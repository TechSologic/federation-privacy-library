import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, connect, type Socket } from "node:net";
import { createServer as httpServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { HttpWire, torConnector } from "../../src/transport.js";
import { FederationError } from "../../src/errors.js";
import { collect } from "../../src/streams.js";
import { config, endpoint } from "../helpers.js";

async function fixture(
  t: TestContext,
  reply: (attempt: number) => {
    code?: number;
    delayMs?: number;
    version?: number;
    reserved?: number;
  },
  controlMs = 60_000,
  responseStatus = 200,
) {
  const stopped = new AbortController();
  const sockets = new Set<Socket>();
  const requests: string[] = [];
  let attempts = 0;
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };
  const server = httpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push(Buffer.concat(chunks).toString());
      res.statusCode = responseStatus;
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const proxy = createServer((socket) => {
    track(socket);
    let buffered = Buffer.alloc(0);
    let greeted = false;
    const read = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (!greeted && buffered.length >= 3) {
        assert.deepEqual(buffered.subarray(0, 3), Buffer.from([5, 1, 0]));
        buffered = buffered.subarray(3);
        greeted = true;
        socket.write(Buffer.from([5, 0]));
      }
      if (!greeted || buffered.length < 5 || buffered.length < 7 + buffered[4]) return;
      assert.deepEqual(buffered.subarray(0, 4), Buffer.from([5, 1, 0, 3]));
      assert.equal(buffered.subarray(5, 5 + buffered[4]).toString(), `${"k".repeat(56)}.onion`);
      socket.removeListener("data", read);
      const outcome = reply(++attempts);
      void (async () => {
        if (outcome.delayMs) await delay(outcome.delayMs, undefined, { signal: stopped.signal });
        if (socket.destroyed) return;
        const header = Buffer.from([
          outcome.version ?? 5,
          outcome.code ?? 0,
          outcome.reserved ?? 0,
          1,
          127,
          0,
          0,
          1,
          0,
          80,
        ]);
        if (outcome.code || outcome.version !== undefined || outcome.reserved !== undefined) {
          socket.end(header);
          return;
        }
        const upstream = track(connect(port, "127.0.0.1"));
        socket.once("close", () => upstream.destroy());
        upstream.once("connect", () => {
          socket.write(header);
          socket.pipe(upstream).pipe(socket);
        });
      })().catch(() => socket.destroy());
    };
    socket.on("data", read);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const settings = {
    ...config("l").tor,
    socksProxy: { host: "127.0.0.1", port: (proxy.address() as { port: number }).port },
  };
  const wire = new HttpWire(torConnector(settings), settings, controlMs);
  t.after(async () => {
    stopped.abort();
    await wire.stop();
    for (const socket of sockets) socket.destroy();
    await Promise.all([
      new Promise<void>((resolve) => proxy.close(() => resolve())),
      new Promise<void>((resolve) => server.close(() => resolve())),
    ]);
  });
  const send = async (signal = AbortSignal.timeout(5000)) => {
    const response = await wire.request(endpoint("k"), {
      path: "/synthetic-control",
      method: "POST",
      body: Buffer.from("exact synthetic request"),
      signal,
    });
    if (response.status !== 200) {
      await collect(response.body, 100, { signal });
      throw new Error("Synthetic peer rejection");
    }
    return JSON.parse(Buffer.from(await collect(response.body, 100, { signal })).toString());
  };
  return { send, requests, attempts: () => attempts, stop: () => wire.stop() };
}

test(
  "slow onion establishment can use the control budget beyond the old 15s cutoff",
  { timeout: 5000 },
  async (t) => {
    // Scale production deadline timers only; exercise the real TCP/SOCKS/HTTP path.
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const caller = timeout(4000);
    t.mock.method(AbortSignal, "timeout", (ms: number) => timeout(Math.max(1, ms / 10)));
    const peer = await fixture(t, () => ({ delayMs: 1750 }));
    assert.deepEqual(await peer.send(caller), { ok: true });
    assert.equal(peer.attempts(), 1);
    assert.deepEqual(peer.requests, ["exact synthetic request"]);
  },
);

test("temporary onion failures recover before sending HTTP exactly once", async (t) => {
  const peer = await fixture(t, (attempt) => ({ code: [0xf0, 0xf2, 0][attempt - 1] }));
  assert.deepEqual(await peer.send(), { ok: true });
  assert.equal(peer.attempts(), 3);
  assert.deepEqual(peer.requests, ["exact synthetic request"]);
});

test("temporary onion failure retries have an attempt bound", async (t) => {
  const peer = await fixture(t, () => ({ code: 0xf7 }));
  await assert.rejects(
    peer.send(),
    (error: unknown) => error instanceof FederationError && error.retryable,
  );
  assert.equal(peer.attempts(), 3);
  assert.equal(peer.requests.length, 0);
});

for (const code of [0x01, 0x03, 0x04, 0x05, 0x06, 0xf0, 0xf2, 0xf3, 0xf7]) {
  test(`temporary onion rejection ${code.toString(16)} permits a fresh connection`, async (t) => {
    const peer = await fixture(t, (attempt) => ({ code: attempt === 1 ? code : 0 }));
    assert.deepEqual(await peer.send(), { ok: true });
    assert.equal(peer.attempts(), 2);
    assert.deepEqual(peer.requests, ["exact synthetic request"]);
  });
}

for (const code of [0x02, 0x07, 0x08, 0xf1, 0xf4, 0xf5, 0xf6, 0xff]) {
  test(`permanent onion rejection ${code.toString(16)} is not retried`, async (t) => {
    const peer = await fixture(t, () => ({ code }));
    await assert.rejects(
      peer.send(),
      (error: unknown) => error instanceof FederationError && !error.retryable,
    );
    assert.equal(peer.attempts(), 1);
    assert.equal(peer.requests.length, 0);
  });
}

test("malformed SOCKS success cannot trigger retry or HTTP forwarding", async (t) => {
  const peer = await fixture(t, () => ({ reserved: 1 }));
  await assert.rejects(
    peer.send(),
    (error: unknown) => error instanceof FederationError && !error.retryable,
  );
  assert.equal(peer.attempts(), 1);
  assert.equal(peer.requests.length, 0);
});

test("a lower control deadline still aborts slow onion establishment", async (t) => {
  const peer = await fixture(t, () => ({ delayMs: 200 }), 100);
  await assert.rejects(peer.send());
  assert.equal(peer.attempts(), 1);
  assert.equal(peer.requests.length, 0);
});

test("caller cancellation interrupts onion retry backoff", async (t) => {
  const peer = await fixture(t, () => ({ code: 0xf0 }));
  const signal = AbortSignal.timeout(100);
  await assert.rejects(
    peer.send(signal),
    (error: unknown) =>
      error === signal.reason ||
      (error instanceof Error && error.name === "AbortError" && error.cause === signal.reason),
  );
  assert.equal(peer.attempts(), 1);
  assert.equal(peer.requests.length, 0);
});

test("HTTP rejection never retries an already forwarded application request", async (t) => {
  const peer = await fixture(t, () => ({}), 60_000, 503);
  await assert.rejects(peer.send(), /Synthetic peer rejection/);
  assert.equal(peer.attempts(), 1);
  assert.deepEqual(peer.requests, ["exact synthetic request"]);
});

test("transport shutdown cancels an outstanding onion connection", async (t) => {
  let started!: () => void;
  const connecting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const peer = await fixture(t, () => {
    started();
    return { delayMs: 1000 };
  });
  const rejected = assert.rejects(peer.send());
  await connecting;
  await peer.stop();
  await rejected;
  assert.equal(peer.attempts(), 1);
  assert.equal(peer.requests.length, 0);
});

test("transport shutdown cancels onion retry backoff", async (t) => {
  let started!: () => void;
  const connecting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const peer = await fixture(t, () => {
    started();
    return { code: 0xf0 };
  });
  const rejected = assert.rejects(peer.send());
  await connecting;
  await delay(30);
  await peer.stop();
  await rejected;
  assert.equal(peer.attempts(), 1);
  assert.equal(peer.requests.length, 0);
});
