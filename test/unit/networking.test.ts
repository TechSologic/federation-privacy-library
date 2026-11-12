import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { createServer, request, Agent, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, type Socket, type AddressInfo } from "node:net";
import { once } from "node:events";
import {
  createFederation,
  protocol,
  type Federation,
  type FederationNetworkConnection,
  type FederationBootstrapStorage,
} from "../../src/index.js";
import { tlsFixture } from "../tls-fixture.js";

const local = `http://${"a".repeat(56)}.onion`;
const remote = `http://${"b".repeat(56)}.onion`;
const credentials = tlsFixture();

async function fixture(
  t: TestContext,
  options: {
    localEnabled?: boolean;
    remoteEnabled?: boolean;
    addresses?: string[];
    trustCertificate?: boolean;
    certificate?: ReturnType<typeof tlsFixture>;
    alter?: (descriptor: unknown) => unknown;
    bootstrapStorage?: FederationBootstrapStorage;
    configuredBootstrap?: boolean;
  } = {},
) {
  const counters = { tor: 0, dns: 0, tls: 0, application: 0, descriptors: 0 };
  const certificate = options.certificate ?? credentials;
  let peer: Federation;
  const sockets = new Set<Socket>();
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const direct = req.url?.startsWith(protocol.federationDirectPathPrefix + "/");
    if (direct && !peer.network.enabled) {
      res.writeHead(403).end();
      return;
    }
    const path = direct ? req.url!.slice(protocol.federationDirectPathPrefix.length) : req.url;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (path === protocol.federationNetworkingPath) {
      counters.descriptors++;
      const descriptor = peer.network.describe(JSON.parse(Buffer.concat(chunks).toString()));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(options.alter ? options.alter(descriptor) : descriptor));
    } else {
      counters.application++;
      res.end(Buffer.concat(chunks));
    }
  };
  const onionServer = createServer((req, res) => {
    void handler(req, res);
  });
  const directServer = createHttpsServer(certificate, (req, res) => {
    void handler(req, res);
  });
  for (const server of [onionServer, directServer]) {
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
  }
  const directPort = (directServer.address() as AddressInfo).port;
  const origin = `https://peer.federation.test:${directPort}`;
  const tor = {
    async connect(onion: string, signal: AbortSignal) {
      assert.equal(onion, remote);
      counters.tor++;
      const socket = connect({
        host: "127.0.0.1",
        port: (onionServer.address() as AddressInfo).port,
        signal,
      });
      await once(socket, "connect", { signal });
      return socket;
    },
  };
  peer = createFederation({
    storage: {},
    tor: { onionService: remote },
    transport: { onion: tor },
    networking: { enabled: options.remoteEnabled ?? true, directOrigin: origin },
  });
  const clients = new Set<Federation>();
  const makeClient = (enabled = options.localEnabled ?? true) => {
    const result = createFederation({
      storage: { bootstrap: options.bootstrapStorage },
      tor: { onionService: local },
      transport: { onion: tor },
      networking: {
        enabled,
        directOrigin: "https://sender.federation.test",
        bootstrapOrigins: options.configuredBootstrap ? [origin] : undefined,
      },
    });
    clients.add(result);
    return result;
  };
  const client = makeClient();
  const originalTls = tls.connect;
  t.mock.method(dns, "lookup", async () => {
    counters.dns++;
    return (options.addresses ?? ["8.8.8.8"]).map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));
  });
  t.mock.method(tls, "connect", (settings: tls.ConnectionOptions) => {
    counters.tls++;
    // Only the test driver maps a checked public destination to the loopback peer.
    // Real TLS still performs its certificate and DNS-name checks.
    assert.equal(settings.host, (options.addresses ?? ["8.8.8.8"])[0]);
    assert.equal(settings.servername, "peer.federation.test");
    assert.equal(settings.rejectUnauthorized, true);
    return originalTls({
      ...settings,
      host: "127.0.0.1",
      ca: options.trustCertificate === false ? undefined : certificate.cert,
    });
  });
  syncBuiltinESMExports();
  t.after(async () => {
    await Promise.all([...clients, peer].map((node) => node.stop()));
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      [onionServer, directServer].map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return { client, peer, origin, counters, directServer, makeClient };
}

async function application(
  connection: FederationNetworkConnection,
  bytes: Buffer,
): Promise<Buffer> {
  const agent = new Agent({ keepAlive: false });
  agent.createConnection = (() => connection.socket) as typeof agent.createConnection;
  const url = new URL(connection.origin);
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const req = request(
        {
          hostname: url.hostname,
          port: Number(url.port || 80),
          path: connection.pathPrefix + "/federation/v1/message/receive",
          method: "POST",
          agent,
          headers: { "content-length": bytes.length },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          res.once("error", reject);
          res.once("end", () => resolve(Buffer.concat(chunks)));
        },
      );
      req.once("error", reject);
      req.once("socket", (socket) => socket.resume());
      req.end(bytes);
    });
  } finally {
    connection.socket.destroy();
    agent.destroy();
  }
}

test("direct policy requires Tor and validates public HTTPS origins", () => {
  assert.throws(
    () =>
      createFederation({
        storage: {},
        networking: { enabled: true, directOrigin: "https://node.example.com" },
      }),
    /Tor/,
  );
  for (const origin of [
    "http://node.example.com",
    "https://127.0.0.1",
    "https://[::1]",
    "https://node.onion",
    "https://node.local",
    "https://node.example.com/path",
    "https://u:p@node.example.com",
    "https://node.example.com/?x=1",
  ]) {
    assert.throws(() => protocol.normalizeFederationDirectOrigin(origin));
  }
  assert.equal(
    protocol.normalizeFederationDirectOrigin("https://NODE.EXAMPLE.COM/"),
    "https://node.example.com",
  );
});

test("Tor-only mode performs no direct discovery, DNS or TLS, including domain bootstrap", async (t) => {
  const f = await fixture(t, { localEnabled: false });
  const connection = await f.client.network.connect(remote);
  assert.equal(connection.transport, "tor");
  connection.socket.destroy();
  await assert.rejects(f.client.network.bootstrap(f.origin), /requires direct networking/);
  assert.deepEqual(f.counters, { tor: 1, dns: 0, tls: 0, application: 0, descriptors: 0 });
});

test("an enabled node uses Tor when the peer disables direct mode", async (t) => {
  const f = await fixture(t, { remoteEnabled: false });
  const connection = await f.client.network.connect(remote);
  assert.equal(connection.transport, "tor");
  assert.equal(f.counters.dns, 0);
  assert.equal(
    f.counters.tor,
    2,
    "One authenticated capability query, then application connection",
  );
  connection.socket.destroy();
});

test("both enabled use verified HTTPS for unchanged application bytes and reuse the capability", async (t) => {
  const f = await fixture(t);
  const payload = Buffer.from("synthetic encrypted bytes");
  for (let attempt = 0; attempt < 2; attempt++) {
    const connection = await f.client.network.connect(remote);
    assert.equal(connection.transport, "direct");
    assert.equal(connection.origin, f.origin);
    assert.deepEqual(await application(connection, payload), payload);
  }
  assert.deepEqual(f.counters, { tor: 1, dns: 2, tls: 2, application: 2, descriptors: 1 });
});

test("domain bootstrap verifies the same origin through the onion endpoint", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.client.network.bootstrap(f.origin), { onionService: remote });
  assert.equal(f.counters.tor, 1);
  assert.equal(f.counters.descriptors, 2);
  assert.equal(f.counters.application, 0);
});

test("configured HTTPS seeds persist their verified onion counterpart across a Tor-only restart", async (t) => {
  const retained = new Map<string, string>();
  const f = await fixture(t, {
    configuredBootstrap: true,
    bootstrapStorage: {
      async get(origin) {
        return retained.get(origin);
      },
      async set(origin, onion, { signal }) {
        signal.throwIfAborted();
        retained.set(origin, onion);
      },
    },
  });
  const results = await Promise.all([
    f.client.network.bootstrapPeers(),
    f.client.network.bootstrapPeers(),
  ]);
  assert.deepEqual(results, [[{ onionService: remote }], [{ onionService: remote }]]);
  assert.equal(retained.get(f.origin), remote);
  assert.equal(f.counters.descriptors, 2, "Concurrent introductions share verification");
  await f.client.stop();
  const restarted = f.makeClient(false);
  const before = { ...f.counters };
  assert.deepEqual(await restarted.network.bootstrapPeers(), [{ onionService: remote }]);
  assert.deepEqual(await restarted.network.bootstrap(f.origin), { onionService: remote });
  assert.deepEqual(f.counters, before, "No DNS, TLS, or Tor I/O to read retained hints");
  const connection = await restarted.network.connect(remote);
  assert.equal(connection.transport, "tor");
  connection.socket.destroy();
  assert.equal(f.counters.dns, before.dns);
  assert.equal(f.counters.tls, before.tls);
});

test("a failed domain introduction never persists a claimed onion identity", async (t) => {
  let writes = 0;
  const f = await fixture(t, {
    configuredBootstrap: true,
    alter: (descriptor) => ({
      ...(descriptor as object),
      directOrigin: "https://substituted.federation.test",
    }),
    bootstrapStorage: {
      async get() {
        return undefined;
      },
      async set() {
        writes++;
      },
    },
  });
  assert.deepEqual(await f.client.network.bootstrapPeers(), []);
  assert.equal(writes, 0);
  const dns = f.counters.dns;
  assert.deepEqual(await f.client.network.bootstrapPeers(), []);
  assert.equal(f.counters.dns, dns, "Failed seeds have a bounded retry delay");
});

test("unknown domain seeds stay unresolved in Tor-only mode", async (t) => {
  const f = await fixture(t, {
    localEnabled: false,
    configuredBootstrap: true,
    bootstrapStorage: {
      async get() {
        return undefined;
      },
      async set() {
        assert.fail("No write expected");
      },
    },
  });
  assert.deepEqual(await f.client.network.bootstrapPeers(), []);
  assert.deepEqual(f.counters, { tor: 0, dns: 0, tls: 0, application: 0, descriptors: 0 });
});

test("malformed, substituted or expired capability is never followed directly", async (t) => {
  const f = await fixture(t, {
    alter: (descriptor) => ({ ...(descriptor as object), onionService: local }),
  });
  const connection = await f.client.network.connect(remote);
  assert.equal(connection.transport, "tor");
  assert.equal(f.counters.dns, 0);
  connection.socket.destroy();
  const challenge = "a".repeat(43);
  const valid = {
    type: "unolock.federation.networking.v1",
    onionService: remote,
    enabled: true,
    directOrigin: f.origin,
    challenge,
    expiresAt: Date.now() + 60_000,
  };
  for (const changes of [
    { extra: true },
    { challenge: "b".repeat(43) },
    { expiresAt: 1 },
    { expiresAt: Date.now() + 60 * 60_000 },
    { enabled: false },
  ]) {
    assert.throws(() =>
      protocol.validateFederationNetworkingDescriptor(
        { ...valid, ...changes },
        { challenge, onionService: remote },
      ),
    );
  }
});

test("all DNS answers must be public, including IPv6 and mixed answers", async (t) => {
  for (const addresses of [
    ["127.0.0.1"],
    ["10.1.2.3"],
    ["169.254.169.254"],
    ["100.64.0.1"],
    ["192.168.1.1"],
    ["::1"],
    ["fc00::1"],
    ["::ffff:127.0.0.1"],
    ["64:ff9b::a00:1"],
    ["2002:7f00:1::"],
    ["8.8.8.8", "172.16.0.1"],
  ]) {
    await t.test(addresses.join(","), async (t) => {
      const f = await fixture(t, { addresses });
      const connection = await f.client.network.connect(remote);
      assert.equal(connection.transport, "tor");
      assert.equal(f.counters.tls, 0);
      connection.socket.destroy();
    });
  }
});

test("an untrusted TLS certificate falls back before any application write", async (t) => {
  const f = await fixture(t, { trustCertificate: false });
  const connection = await f.client.network.connect(remote);
  assert.equal(connection.transport, "tor");
  assert.equal(f.counters.application, 0);
  assert.equal(f.counters.tls, 1);
  connection.socket.destroy();
});

test("a trusted certificate for a different hostname cannot authenticate direct transport", async (t) => {
  const f = await fixture(t, { certificate: tlsFixture("other.federation.test") });
  const connection = await f.client.network.connect(remote);
  assert.equal(connection.transport, "tor");
  assert.equal(f.counters.application, 0);
  assert.equal(f.counters.tls, 1);
  connection.socket.destroy();
});

test("cancelled callers cannot accumulate unbounded unresolved system DNS work", async (t) => {
  const f = await fixture(t);
  (await f.client.network.connect(remote)).socket.destroy();
  const resolvers: ((value: { address: string; family: number }[]) => void)[] = [];
  t.mock.method(dns, "lookup", () => new Promise((resolve) => resolvers.push(resolve)));
  syncBuiltinESMExports();
  const controllers = Array.from({ length: 32 }, () => new AbortController());
  const attempts = controllers.map((controller) =>
    f.client.network.connect(remote, { signal: controller.signal }),
  );
  // Attach rejection handlers before cancellation to verify there is no unhandled rejection.
  const settled = Promise.allSettled(attempts);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(resolvers.length, 32);
  for (const controller of controllers) controller.abort();
  assert.ok((await settled).every((result) => result.status === "rejected"));
  await assert.rejects(f.client.network.bootstrap(f.origin), /DNS capacity/);
  assert.equal(resolvers.length, 32);
  for (const resolve of resolvers) resolve([{ address: "8.8.8.8", family: 4 }]);
});

test("disabling retires cached capabilities and closes open direct connections", async (t) => {
  const f = await fixture(t);
  const first = await f.client.network.connect(remote);
  assert.equal(first.transport, "direct");
  f.client.network.configure({ enabled: false });
  assert.equal(first.socket.destroyed, true);
  const dnsBefore = f.counters.dns;
  const next = await f.client.network.connect(remote);
  assert.equal(next.transport, "tor");
  assert.equal(f.counters.dns, dnsBefore);
  assert.equal(f.client.network.enabled, false);
  next.socket.destroy();
});

test("starting workers cannot detach policy cancellation from a pre-start connection", async (t) => {
  const f = await fixture(t);
  (await f.client.network.connect(remote)).socket.destroy();
  let finish!: (value: { address: string; family: number }[]) => void;
  t.mock.method(
    dns,
    "lookup",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  syncBuiltinESMExports();
  const pending = f.client.network.connect(remote);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(typeof finish, "function");
  await f.client.start();
  f.client.network.configure({ enabled: false });
  finish([{ address: "8.8.8.8", family: 4 }]);
  const connection = await pending;
  assert.equal(connection.transport, "tor");
  assert.equal(f.counters.tls, 1, "Disabling must prevent a late direct socket");
  connection.socket.destroy();
});

test("uncertain application attempts are not replayed by the network selector", async (t) => {
  const f = await fixture(t);
  const first = await f.client.network.connect(remote);
  await application(first, Buffer.from("stable-operation-1"));
  f.client.network.reportFailure(remote);
  assert.equal(f.counters.application, 1);
  const retry = await f.client.network.connect(remote);
  assert.equal(retry.transport, "tor");
  assert.equal(
    f.counters.application,
    1,
    "Returning a socket must never resend an application operation",
  );
  retry.socket.destroy();
});

test("concurrent callers share capability discovery but keep independent connections", async (t) => {
  const f = await fixture(t);
  const connections = await Promise.all(
    Array.from({ length: 8 }, () => f.client.network.connect(remote)),
  );
  assert.equal(f.counters.descriptors, 1);
  assert.equal(f.counters.tor, 1);
  for (const connection of connections) {
    assert.equal(connection.transport, "direct");
    connection.socket.destroy();
  }
});

test("caller cancellation and stopped facades cannot start networking", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.client.network.connect(remote, { signal: AbortSignal.abort() }));
  assert.equal(f.counters.tor, 0);
  await f.client.stop();
  await assert.rejects(f.client.network.connect(remote));
  await assert.rejects(f.client.network.bootstrap(f.origin));
  assert.equal(f.counters.dns, 0);
});
