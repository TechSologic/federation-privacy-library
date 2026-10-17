import test from "node:test";
import assert from "node:assert/strict";
import { createServer as tcpServer, connect } from "node:net";
import { createServer as httpServer } from "node:http";
import { HttpWire, torConnector } from "../../src/transport.js";
import { config, endpoint } from "../helpers.js";
import { collect } from "../../src/streams.js";
test(
  "production transport uses SOCKS remote onion names and supports fragmented handshake replies",
  { timeout: 5000 },
  async (t) => {
    let requestedHost = "";
    const server = httpServer((req, res) => {
      assert.equal(req.headers.host, `${"k".repeat(56)}.onion`);
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const serverPort = (server.address() as any).port;
    const sockets = new Set<import("node:net").Socket>();
    const proxy = tcpServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => sockets.delete(socket));
      let buffered = Buffer.alloc(0),
        step = 0;
      const handle = (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (step === 0 && buffered.length >= 3) {
          assert.deepEqual(buffered.subarray(0, 3), Buffer.from([5, 1, 0]));
          buffered = buffered.subarray(3);
          step = 1;
          socket.write(Buffer.from([5]));
          setImmediate(() => socket.write(Buffer.from([0])));
        }
        if (step === 1 && buffered.length >= 5 && buffered.length >= 7 + buffered[4]) {
          assert.deepEqual(buffered.subarray(0, 4), Buffer.from([5, 1, 0, 3]));
          requestedHost = buffered.subarray(5, 5 + buffered[4]).toString();
          socket.removeListener("data", handle);
          const upstream = connect(serverPort, "127.0.0.1");
          sockets.add(upstream);
          upstream.on("error", () => {});
          upstream.once("close", () => sockets.delete(upstream));
          upstream.once("connect", () => {
            socket.write(Buffer.from([5, 0, 0, 1]));
            setImmediate(() => {
              socket.write(Buffer.from([127, 0, 0, 1, 0, 80]));
              socket.pipe(upstream).pipe(socket);
            });
          });
        }
      };
      socket.on("data", handle);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const settings = {
      ...config("l").tor,
      socksProxy: { host: "127.0.0.1", port: (proxy.address() as any).port },
    };
    const wire = new HttpWire(torConnector(settings), settings);
    t.after(async () => {
      await wire.stop();
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => proxy.close(() => resolve())),
        new Promise<void>((resolve) => server.close(() => resolve())),
      ]);
    });
    const response = await wire.request(endpoint("k"), {
      path: "/synthetic-test",
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(Buffer.from(await collect(response.body, 100)).toString(), '{"ok":true}');
    assert.equal(requestedHost, `${"k".repeat(56)}.onion`);
    await assert.rejects(
      wire.request("http://example.com", { path: "/", signal: new AbortController().signal }),
      /onion/,
    );
  },
);
