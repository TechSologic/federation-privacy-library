import test from "node:test";
import assert from "node:assert/strict";
import { createServer as tcpServer, connect } from "node:net";
import { createServer as httpServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { HttpWire, localConnect, torConnector } from "../../src/transport.js";
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

test("a timed-out non-cooperative handler remains admission-counted", async (t) => {
  const settings = config("x").tor;
  let port = 0;
  const server = new HttpWire(
    {
      connect: (_endpoint, signal) => localConnect("127.0.0.1", port, signal),
    },
    settings,
    100,
  );
  port = await server.start(async () => new Promise<never>(() => {}));
  const client = new HttpWire(server.connector, settings, 1000);
  t.after(async () => Promise.all([client.stop(), server.stop()]));
  const responses = await Promise.all(
    Array.from({ length: 16 }, (_, index) =>
      client.request(settings.onionService, {
        path: `/synthetic-hang-${index}`,
        signal: AbortSignal.timeout(2000),
      }),
    ),
  );
  for (const response of responses) {
    assert.equal(response.status, 503);
    assert.equal(
      JSON.parse(Buffer.from(await collect(response.body, 100)).toString()).type,
      "SERVER",
    );
  }
  const throttled = await client.request(settings.onionService, {
    path: "/synthetic-after-timeout",
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(throttled.status, 503);
  assert.equal(
    JSON.parse(Buffer.from(await collect(throttled.body, 100)).toString()).type,
    "THROTTLED",
  );
});

test("archive byte routes use the separate finite streaming deadline", async (t) => {
  const settings = config("w").tor;
  let port = 0;
  const connector = {
    connect: (_endpoint: string, signal: AbortSignal) => localConnect("127.0.0.1", port, signal),
  };
  const server = new HttpWire(connector, settings, { controlMs: 100, archiveMs: 500 });
  port = await server.start(async () => {
    await delay(150);
    return { status: 200, body: new Uint8Array([1]) };
  });
  const client = new HttpWire(connector, settings, { controlMs: 1000, archiveMs: 1000 });
  t.after(async () => Promise.all([client.stop(), server.stop()]));

  const control = await client.request(settings.onionService, {
    path: "/synthetic-control",
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(control.status, 503);
  await collect(control.body, 100);

  const archive = await client.request(settings.onionService, {
    path: "/federation/v1/archive/object/read",
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(archive.status, 200);
  assert.deepEqual([...(await collect(archive.body, 100))], [1]);
});
