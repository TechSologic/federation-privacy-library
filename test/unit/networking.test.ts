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
    if (path === "/.well-known/unolock-federation/v1/networking") {
      counters.descriptors++;
      res.writeHead(404).end();
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
      storage: {},
      tor: { onionService: local },
      transport: { onion: tor },
      networking: {
        enabled,
        directOrigin: "https://sender.federation.test",
      },
    });
    if (options.remoteEnabled !== false) result.network.acceptTorArchiveEndpoint(remote, origin);
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
  return {
    client,
    peer,
    origin,
    counters,
    directServer,
    makeClient,
  };
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
          path: connection.pathPrefix + "/federation/v1/archive/object",
          method: "PUT",
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

test("ordinary connections always use one Tor connection, with no capabilities, DNS or TLS", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 2; i++) (await f.client.network.connect(remote)).socket.destroy();
  assert.deepEqual(f.counters, { tor: 2, dns: 0, tls: 0, application: 0, descriptors: 0 });
});

test("archive bytes use the endpoint learned over Tor without a capability round trip", async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.alloc(2 * 1024 * 1024, 0x61);
  for (let i = 0; i < 2; i++) {
    const c = await f.client.network.connectArchive(remote);
    assert.equal(c.transport, "direct");
    assert.deepEqual(await application(c, bytes), bytes);
  }
  assert.deepEqual(f.counters, { tor: 0, dns: 2, tls: 2, application: 2, descriptors: 0 });
});

test("cold and pre-direct peers use Tor without probing for capabilities", async (t) => {
  const f = await fixture(t, { remoteEnabled: false });
  (await f.client.network.connectArchive(remote)).socket.destroy();
  f.client.network.acceptTorArchiveEndpoint(remote, undefined);
  (await f.client.network.connectArchive(remote)).socket.destroy();
  assert.deepEqual(f.counters, { tor: 2, dns: 0, tls: 0, application: 0, descriptors: 0 });
});

test("local Tor-only policy never performs direct DNS", async (t) => {
  const f = await fixture(t, { localEnabled: false });
  (await f.client.network.connectArchive(remote)).socket.destroy();
  assert.deepEqual(f.counters, { tor: 1, dns: 0, tls: 0, application: 0, descriptors: 0 });
});

test("invalid or withdrawn advertisements clear the endpoint and preserve Tor", async (t) => {
  const f = await fixture(t);
  for (const value of [
    undefined,
    remote,
    "https://127.0.0.1",
    "https://node.internal",
    "http://peer.example.com",
    [f.origin],
  ]) {
    f.client.network.acceptTorArchiveEndpoint(remote, f.origin);
    f.client.network.acceptTorArchiveEndpoint(remote, value);
    const c = await f.client.network.connectArchive(remote);
    assert.equal(c.transport, "tor");
    c.socket.destroy();
  }
  assert.equal(f.counters.dns, 0);
  assert.equal(f.counters.descriptors, 0);
});

test("endpoint learning is scoped to the exact onion and expires without a probe", async (t) => {
  const f = await fixture(t, { remoteEnabled: false });
  f.client.network.acceptTorArchiveEndpoint(local, f.origin);
  (await f.client.network.connectArchive(remote)).socket.destroy();
  assert.equal(f.counters.dns, 0);
  f.client.network.acceptTorArchiveEndpoint(remote, f.origin);
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 5 * 60_000 + 1);
  const c = await f.client.network.connectArchive(remote);
  assert.equal(c.transport, "tor");
  assert.equal(f.counters.dns, 0);
  c.socket.destroy();
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
      const c = await f.client.network.connectArchive(remote);
      assert.equal(c.transport, "tor");
      assert.equal(f.counters.tls, 0);
      assert.equal(f.counters.descriptors, 0);
      c.socket.destroy();
    });
  }
});

test("TLS trust and hostname failures fall back before any application bytes", async (t) => {
  for (const options of [
    { trustCertificate: false },
    { certificate: tlsFixture("other.federation.test") },
  ]) {
    await t.test(JSON.stringify(Object.keys(options)), async (t) => {
      const f = await fixture(t, options);
      const c = await f.client.network.connectArchive(remote);
      assert.equal(c.transport, "tor");
      assert.equal(f.counters.tls, 1);
      assert.equal(f.counters.application, 0);
      c.socket.destroy();
    });
  }
});

test("cancelled callers retain DNS capacity until system lookups settle", async (t) => {
  const f = await fixture(t);
  const resolvers: ((value: { address: string; family: number }[]) => void)[] = [];
  t.mock.method(dns, "lookup", () => new Promise((resolve) => resolvers.push(resolve)));
  syncBuiltinESMExports();
  const controllers = Array.from({ length: 32 }, () => new AbortController());
  const settled = Promise.allSettled(
    controllers.map((controller) =>
      f.client.network.connectArchive(remote, { signal: controller.signal }),
    ),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(resolvers.length, 32);
  controllers.forEach((controller) => controller.abort());
  assert.ok((await settled).every((result) => result.status === "rejected"));
  const c = await f.client.network.connectArchive(remote);
  assert.equal(c.transport, "tor");
  c.socket.destroy();
  assert.equal(resolvers.length, 32);
  resolvers.forEach((resolve) => resolve([{ address: "8.8.8.8", family: 4 }]));
});

test("disabling closes direct sockets and prevents subsequent DNS", async (t) => {
  const f = await fixture(t);
  const c = await f.client.network.connectArchive(remote);
  assert.equal(c.transport, "direct");
  f.client.network.configure({ enabled: false });
  assert.equal(c.socket.destroyed, true);
  (await f.client.network.connectArchive(remote)).socket.destroy();
  assert.equal(f.counters.dns, 1);
});

test("policy cancellation prevents a late direct connection", async (t) => {
  const f = await fixture(t);
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
  const pending = f.client.network.connectArchive(remote);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(typeof finish, "function");
  await f.client.start();
  f.client.network.configure({ enabled: false });
  finish([{ address: "8.8.8.8", family: 4 }]);
  const c = await pending;
  assert.equal(c.transport, "tor");
  assert.equal(f.counters.tls, 0);
  c.socket.destroy();
});

test("uncertain application writes are never replayed by connection selection", async (t) => {
  const f = await fixture(t);
  await application(
    await f.client.network.connectArchive(remote),
    Buffer.from("stable-operation-1"),
  );
  f.client.network.reportFailure(remote);
  const c = await f.client.network.connectArchive(remote);
  assert.equal(c.transport, "tor");
  assert.equal(f.counters.application, 1);
  c.socket.destroy();
});

test("concurrent archive connections perform no capability discovery", async (t) => {
  const f = await fixture(t);
  const connections = await Promise.all(
    Array.from({ length: 8 }, () => f.client.network.connectArchive(remote)),
  );
  assert.equal(f.counters.tor, 0);
  assert.equal(f.counters.descriptors, 0);
  for (const c of connections) {
    assert.equal(c.transport, "direct");
    c.socket.destroy();
  }
});

test("cancelled and stopped facades cannot start networking", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.client.network.connectArchive(remote, { signal: AbortSignal.abort() }));
  await f.client.stop();
  await assert.rejects(f.client.network.connect(remote));
  await assert.rejects(f.client.network.connectArchive(remote));
  assert.deepEqual(f.counters, { tor: 0, dns: 0, tls: 0, application: 0, descriptors: 0 });
});
