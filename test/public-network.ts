import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, connect, type Socket, type AddressInfo } from "node:net";
import { createServer as httpsServer } from "node:https";
import { request } from "node:http";
import dns from "node:dns/promises";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import { Transform } from "node:stream";
import type { TorConfiguration } from "../src/index.js";
import { protocol } from "../src/index.js";
import { tlsFixture } from "./tls-fixture.js";

/** Separate offline network driver. Applications use the public factory and real SOCKS/TLS. */
export async function publicNetwork(
  t: TestContext,
  letters: string[],
  options: { archiveDelayMs?: number; dropMessageAcknowledgementOnce?: boolean } = {},
) {
  const sockets = new Set<Socket>();
  const routes = new Map<string, number>();
  const configs = new Map<string, { tor: TorConfiguration; directOrigin: string }>();
  const requests: { transport: "tor" | "direct"; host: string; path: string }[] = [];
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };
  const credentials = tlsFixture();
  const proxies: ReturnType<typeof httpsServer>[] = [];
  const socks = createServer((socket) => {
    track(socket);
    let buffered = Buffer.alloc(0);
    let greeted = false;
    const receive = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 1024) return socket.destroy();
      if (!greeted && buffered.length >= 3) {
        if (!buffered.subarray(0, 3).equals(Buffer.from([5, 1, 0]))) return socket.destroy();
        buffered = buffered.subarray(3);
        greeted = true;
        socket.write(Buffer.from([5, 0]));
      }
      if (!greeted || buffered.length < 5) return;
      const size = buffered[4];
      if (buffered.length < size + 7) return;
      const host = buffered.subarray(5, size + 5).toString("ascii");
      const port = routes.get(host);
      if (
        !port ||
        !buffered.subarray(0, 4).equals(Buffer.from([5, 1, 0, 3])) ||
        buffered.readUInt16BE(size + 5) !== 80
      )
        return socket.destroy();
      socket.off("data", receive);
      const upstream = track(connect(port, "127.0.0.1"));
      upstream.once("close", () => socket.destroy());
      socket.once("close", () => upstream.destroy());
      upstream.once("connect", () => {
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
        socket.once("data", (data) => {
          const path = /^[A-Z]+ ([^ ]+) /.exec(data.toString("ascii"))?.[1];
          if (path) requests.push({ transport: "tor", host, path });
        });
        const rest = buffered.subarray(size + 7);
        if (rest.length) upstream.write(rest);
        socket.pipe(upstream).pipe(socket);
      });
    };
    socket.on("data", receive);
  });
  socks.listen(0, "127.0.0.1");
  await once(socks, "listening");
  const socksPort = (socks.address() as AddressInfo).port;
  for (const letter of letters) {
    const host = `${letter.repeat(56)}.onion`;
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = (reservation.address() as AddressInfo).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    routes.set(host, port);
    let dropAcknowledgement = options.dropMessageAcknowledgementOnce === true;
    const proxy = httpsServer(credentials, (req, res) => {
      if (!req.url?.startsWith(protocol.federationDirectPathPrefix + "/")) {
        res.writeHead(404).end();
        return;
      }
      requests.push({
        transport: "direct",
        host,
        path: req.url.slice(protocol.federationDirectPathPrefix.length),
      });
      const upstream = request(
        { host: "127.0.0.1", port, method: req.method, path: req.url, headers: req.headers },
        (response) => {
          if (dropAcknowledgement && req.url?.endsWith(protocol.messagePath)) {
            dropAcknowledgement = false;
            response.resume();
            response.once("end", () => res.destroy());
            return;
          }
          res.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(res);
        },
      );
      upstream.once("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      res.once("close", () => upstream.destroy());
      if (options.archiveDelayMs && req.url.endsWith("/archive/object")) {
        let first = true;
        const throttle = new Transform({
          transform(chunk, _encoding, callback) {
            if (!first) {
              callback(null, chunk);
              return;
            }
            first = false;
            setTimeout(() => callback(null, chunk), options.archiveDelayMs);
          },
        });
        upstream.flushHeaders();
        req.pipe(throttle).pipe(upstream);
        res.once("close", () => throttle.destroy());
      } else req.pipe(upstream);
    });
    proxy.on("connection", track);
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    proxies.push(proxy);
    configs.set(letter, {
      tor: {
        onionService: `http://${host}`,
        socksProxy: { host: "127.0.0.1", port: socksPort },
        listen: { host: "127.0.0.1", port },
        bootstrap: letters
          .filter((peer) => peer !== letter)
          .map((peer) => ({ onionService: `http://${peer.repeat(56)}.onion` })),
      },
      directOrigin: `https://peer.federation.test:${(proxy.address() as AddressInfo).port}`,
    });
  }
  const originalTls = tls.connect;
  t.mock.method(dns, "lookup", async () => [{ address: "8.8.8.8", family: 4 }]);
  t.mock.method(tls, "connect", (options: tls.ConnectionOptions) => {
    assert.equal(options.host, "8.8.8.8");
    assert.equal(options.rejectUnauthorized, true);
    return originalTls({ ...options, host: "127.0.0.1", ca: credentials.cert });
  });
  syncBuiltinESMExports();
  return {
    configs,
    requests,
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all(
        [socks, ...proxies].map(
          (server) => new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      );
      t.mock.restoreAll();
      syncBuiltinESMExports();
    },
  };
}
