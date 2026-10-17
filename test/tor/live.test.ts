import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createFederation } from "../../src/index.js";
import { collect } from "../../src/streams.js";
import { address, config, eventually, message } from "../helpers.js";

async function port() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const result = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return result;
}
test(
  "two production instances discover and deliver through real Tor onion services",
  { timeout: 300_000 },
  async (t) => {
    const binary = process.env.TOR_BINARY;
    assert.ok(
      binary,
      "Set TOR_BINARY to an installed Tor executable; this opt-in suite uses the public Tor network",
    );
    const root = await mkdtemp(join(tmpdir(), "federation-tor-test-"));
    const socks = await port(),
      first = await port(),
      second = await port();
    const tor = spawn(binary, ["-f", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    let bootstrapped = false,
      failed = false,
      exited = false;
    tor.on("error", () => {
      failed = true;
    });
    tor.on("exit", () => {
      exited = true;
    });
    tor.stdin.on("error", () => {
      failed = true;
    });
    const exit = new Promise<void>((resolve) => tor.once("close", () => resolve()));
    let last = -1;
    tor.stdout.on("data", (chunk) => {
      const match = /Bootstrapped (\d+)%/.exec(chunk.toString());
      if (match && Number(match[1]) > last) {
        last = Number(match[1]);
        console.log(`Tor bootstrap: ${last}%`);
      }
      if (chunk.toString().includes("Bootstrapped 100%")) bootstrapped = true;
    });
    tor.stderr.on("data", () => {}); // Never print routes or temporary identity material.
    t.after(async () => {
      tor.kill("SIGTERM");
      const kill = setTimeout(() => tor.kill("SIGKILL"), 3000);
      await exit;
      clearTimeout(kill);
      await rm(root, { recursive: true, force: true });
    });
    tor.stdin.end(
      `DataDirectory ${join(root, "data")}\nSocksPort 127.0.0.1:${socks}\nLog notice stdout\nHiddenServiceDir ${join(root, "first")}\nHiddenServicePort 80 127.0.0.1:${first}\nHiddenServiceDir ${join(root, "second")}\nHiddenServicePort 80 127.0.0.1:${second}\n`,
    );
    await eventually(() => {
      if (failed || exited) throw new Error("Disposable Tor process could not start");
      return bootstrapped;
    }, 180_000);
    const [hostA, hostB] = await Promise.all([
      readFile(join(root, "first", "hostname"), "utf8"),
      readFile(join(root, "second", "hostname"), "utf8"),
    ]);
    const onionA = `http://${hostA.trim()}`,
      onionB = `http://${hostB.trim()}`;
    let received = 0;
    const a = createFederation({
      ...config("a"),
      tor: {
        onionService: onionA,
        socksProxy: { host: "127.0.0.1", port: socks },
        listen: { host: "127.0.0.1", port: first },
        bootstrap: [{ onionService: onionB }],
      },
    });
    const b = createFederation({
      ...config("b"),
      tor: {
        onionService: onionB,
        socksProxy: { host: "127.0.0.1", port: socks },
        listen: { host: "127.0.0.1", port: second },
        bootstrap: [{ onionService: onionA }],
      },
      messages: {
        receiver: {
          async receive(stream) {
            await collect(stream, 256 * 1024);
            received++;
          },
        },
      },
    });
    t.after(async () => {
      await Promise.all([a.stop(), b.stop()]);
    });
    await Promise.all([a.start(), b.start()]);
    const target = await address();
    await b.addresses.register(target.record);
    // Onion descriptor publication follows Tor bootstrapping; retries are part of this test.
    const transfer = await a.messages.send(target.address, a.messages.source(message));
    const outcome = await transfer.wait({ signal: AbortSignal.timeout(100_000) });
    assert.equal(outcome.status, "completed", "Real Tor transfer did not achieve node custody");
    await eventually(() => received === 1, 10_000);
  },
);
