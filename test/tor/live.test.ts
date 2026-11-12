import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createFederation, protocol } from "../../src/index.js";
import { collect } from "../../src/streams.js";
import { address, config, eventually, message } from "../helpers.js";
import { publicNetwork } from "../public-network.js";

async function port() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const result = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return result;
}
test(
  "real Tor identity verification supports direct delivery and either-side Tor-only participation",
  { timeout: 300_000 },
  async (t) => {
    const binary = process.env.TOR_BINARY;
    assert.ok(
      binary,
      "Set TOR_BINARY to an installed Tor executable; this opt-in suite uses the public Tor network",
    );
    const root = await mkdtemp(join(tmpdir(), "federation-tor-test-"));
    // TLS terminates on local test proxies with validated disposable certificates.
    // Onion services and outbound SOCKS connections use the actual Tor network.
    const network = await publicNetwork(t, ["a", "b"]);
    t.after(() => network.close());
    const socks = await port(),
      first = network.configs.get("a")!.tor.listen!.port,
      second = network.configs.get("b")!.tor.listen!.port;
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
      storage: config("a").storage,
      handlers: { authorization: config("a").authorization },
      tor: {
        onionService: onionA,
        socksProxy: { host: "127.0.0.1", port: socks },
        listen: { host: "127.0.0.1", port: first },
        bootstrap: [{ onionService: onionB }],
      },
    });
    const b = createFederation({
      storage: config("b").storage,
      tor: {
        onionService: onionB,
        socksProxy: { host: "127.0.0.1", port: socks },
        listen: { host: "127.0.0.1", port: second },
        bootstrap: [{ onionService: onionA }],
      },
      handlers: {
        authorization: config("b").authorization,
        routes: config("b").routes,
        messages: {
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
    const waitForTransfer = async (
      transfer: Awaited<ReturnType<typeof a.messages.send>>,
      phase: string,
      timeoutMs: number,
    ) => {
      try {
        const result = await transfer.wait({ signal: AbortSignal.timeout(timeoutMs) });
        assert.equal(result.status, "completed", phase);
        t.diagnostic(`${phase}: completed`);
      } catch (error) {
        const status = await transfer.status();
        t.diagnostic(
          `${phase}: state=${status.state}, attempt=${status.attempt}, failure=${status.failure?.code ?? "none"}`,
        );
        throw error;
      }
    };
    // Onion descriptor publication follows Tor bootstrapping; retries are part of this test.
    const transfer = await a.messages.send(target.address, a.messages.source(message));
    await waitForTransfer(transfer, "Initial Tor delivery", 100_000);
    await eventually(() => received === 1, 10_000);
    const directA = network.configs.get("a")!.directOrigin;
    const directB = network.configs.get("b")!.directOrigin;
    a.network.configure({ enabled: true, directOrigin: directA });
    b.network.configure({ enabled: true, directOrigin: directB });
    const send = async (messageId: number, phase: string) => {
      const operation = await a.messages.send(
        target.address,
        a.messages.source({ ...message, messageId }),
      );
      await waitForTransfer(operation, phase, 60_000);
    };
    const directMessages = () =>
      network.requests.filter((req) => req.path === protocol.messagePath).length;
    await send(102, "Both nodes direct-enabled");
    assert.equal(directMessages(), 1, "Both enabled peers should exchange the envelope over HTTPS");
    a.network.configure({ enabled: false });
    await send(103, "Sender Tor-only");
    assert.equal(directMessages(), 1, "A Tor-only sender must not send over HTTPS");
    a.network.configure({ enabled: true, directOrigin: directA });
    b.network.configure({ enabled: false });
    await send(104, "Receiver Tor-only");
    assert.equal(directMessages(), 1, "A Tor-only receiver must remain reachable through Tor");
    await eventually(() => received === 4, 10_000);
  },
);
