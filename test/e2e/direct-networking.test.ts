import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createFederation,
  protocol,
  type Federation,
  type ArchiveSource,
} from "../../src/index.js";
import { address, config, eventually, message } from "../helpers.js";
import { publicNetwork } from "../public-network.js";
import { archivePolicy, TestArchives } from "../archive-adapter.js";

test(
  "configured onion seeds join through Tor with direct archive policy",
  { timeout: 30_000 },
  async (t) => {
    const network = await publicNetwork(t, ["a", "b"]);
    const hosts = new Map(["a", "b"].map((letter) => [letter, config(letter)]));
    const received: Buffer[] = [];
    const peers: Federation[] = [];
    t.after(async () => {
      await Promise.all(peers.map((peer) => peer.stop()));
      await network.close();
    });
    const make = (letter: string, enabled: boolean) => {
      const host = hosts.get(letter)!;
      const peer = createFederation({
        storage: {
          ...host.storage,
          commit: host.storage.commit.bind(host.storage),
        },
        tor: {
          ...network.configs.get(letter)!.tor,
          bootstrap:
            letter === "a" ? [{ onionService: network.configs.get("b")!.tor.onionService }] : [],
        },
        networking: {
          enabled,
          directOrigin: network.configs.get(letter)!.directOrigin,
        },
        handlers: {
          authorization: host.authorization,
          routes: host.routes,
          messages: {
            async receive(stream) {
              received.push(Buffer.from(await new Response(stream).arrayBuffer()));
            },
          },
        },
      });
      peers.push(peer);
      return peer;
    };
    const b = make("b", true);
    await b.start();
    let a = make("a", true);
    await a.start();
    const send = async (operationId: string, messageId: number) => {
      const target = await address();
      await b.addresses.register(target.record);
      const transfer = await a.messages.send(
        target.address,
        a.messages.source({ ...message, messageId }),
        undefined,
        { operationId },
      );
      assert.equal(
        (await transfer.wait({ signal: AbortSignal.timeout(8_000) })).status,
        "completed",
      );
    };
    await send("onion-bootstrap-direct-policy", 81);
    assert.ok(
      network.requests.some((req) => req.transport === "tor" && req.path === protocol.messagePath),
    );
    await a.stop();
    a = make("a", false);
    const boundary = network.requests.length;
    await a.start();
    await send("domain-bootstrap-tor-restart", 82);
    assert.ok(
      network.requests
        .slice(boundary)
        .some((req) => req.transport === "tor" && req.path === protocol.messagePath),
    );
    // B may still try its cached direct capability for A; A rejects that ingress.
    // Requests to B are A's outbound traffic and must all use Tor after restart.
    assert.ok(
      !network.requests
        .slice(boundary)
        .some((req) => req.transport === "direct" && req.host.startsWith("b")),
    );
    await eventually(() => received.length === 2);
  },
);

test(
  "direct policy keeps message delivery on Tor with one receiver effect",
  { timeout: 30_000 },
  async (t) => {
    const network = await publicNetwork(t, ["a", "b"], { dropMessageAcknowledgementOnce: true });
    const received: Buffer[] = [];
    const peers: Federation[] = [];
    t.after(async () => {
      await Promise.all(peers.map((peer) => peer.stop()));
      await network.close();
    });
    for (const letter of ["a", "b"]) {
      const host = config(letter);
      peers.push(
        createFederation({
          storage: host.storage,
          tor: network.configs.get(letter)!.tor,
          networking: { enabled: true, directOrigin: network.configs.get(letter)!.directOrigin },
          handlers: {
            routes: host.routes,
            authorization: host.authorization,
            messages: {
              async receive(stream) {
                received.push(Buffer.from(await new Response(stream).arrayBuffer()));
              },
            },
          },
        }),
      );
    }
    await Promise.all(peers.map((peer) => peer.start()));
    const target = await address();
    await peers[1].addresses.register(target.record);
    const source = peers[0].messages.source(message);
    const transfer = await peers[0].messages.send(target.address, source, undefined, {
      operationId: "stable-custody-operation",
    });
    assert.equal(
      (await transfer.wait({ signal: AbortSignal.timeout(12_000) })).status,
      "completed",
    );
    await eventually(() => received.length === 1);
    assert.deepEqual(
      received[0],
      Buffer.from(await new Response(await source.open({})).arrayBuffer()),
    );
    const attempts = network.requests.filter((req) => req.path === protocol.messagePath);
    assert.deepEqual(
      attempts.map((req) => req.transport),
      ["tor"],
    );
    assert.equal(
      (
        await peers[0].messages.send(target.address, source, undefined, {
          operationId: "stable-custody-operation",
        })
      ).id,
      transfer.id,
    );
    assert.equal(received.length, 1);
  },
);

test(
  "public instances preserve old addresses and full participation across direct and Tor peers",
  { timeout: 30_000 },
  async (t) => {
    const network = await publicNetwork(t, ["a", "b", "c"]);
    const received = new Map<string, Buffer[]>();
    const peers = new Map<string, Federation>();
    t.after(async () => {
      await Promise.all([...peers.values()].map((peer) => peer.stop()));
      await network.close();
    });
    for (const letter of ["a", "b", "c"]) {
      const host = config(letter);
      received.set(letter, []);
      const peer = createFederation({
        storage: host.storage,
        tor: network.configs.get(letter)!.tor,
        networking: { enabled: false, directOrigin: network.configs.get(letter)!.directOrigin },
        handlers: {
          authorization: host.authorization,
          routes: host.routes,
          messages: {
            async receive(stream) {
              received.get(letter)!.push(Buffer.from(await new Response(stream).arrayBuffer()));
            },
          },
        },
      });
      peers.set(letter, peer);
    }
    await Promise.all([...peers.values()].map((peer) => peer.start()));
    const target = await address();
    await peers.get("b")!.addresses.register(target.record);
    const before = await peers.get("a")!.addresses.lookup(target.address);
    assert.ok(before);
    assert.equal(before.routes.messageOnionService, network.configs.get("b")!.tor.onionService);
    let messageId = 0;
    const expectedBytes: Buffer[] = [];
    const send = async (letter: string, id: string) => {
      const sender = peers.get(letter)!;
      const source = sender.messages.source({ ...message, messageId: ++messageId });
      expectedBytes.push(Buffer.from(await new Response(await source.open({})).arrayBuffer()));
      const transfer = await sender.messages.send(target.address, source, undefined, {
        operationId: id,
      });
      assert.equal(
        (await transfer.wait({ signal: AbortSignal.timeout(8000) })).status,
        "completed",
      );
      return Buffer.from(await new Response(await source.open({})).arrayBuffer());
    };
    await send("a", "before-direct");
    await eventually(() => received.get("b")!.length === 1);
    assert.equal(network.requests.filter((req) => req.transport === "direct").length, 0);

    for (const letter of ["a", "b"])
      peers.get(letter)!.network.configure({
        enabled: true,
        directOrigin: network.configs.get(letter)!.directOrigin,
      });
    assert.deepEqual(await peers.get("a")!.addresses.lookup(target.address), before);
    await send("a", "after-direct");
    await send("c", "tor-only-peer");
    await eventually(() => received.get("b")!.length === 3);
    assert.deepEqual(
      received
        .get("b")!
        .map((bytes) => bytes.toString("hex"))
        .sort(),
      expectedBytes.map((bytes) => bytes.toString("hex")).sort(),
    );
    const messagePaths = network.requests.filter((req) => req.path === protocol.messagePath);
    assert.equal(messagePaths.filter((req) => req.transport === "direct").length, 0);
    assert.equal(messagePaths.filter((req) => req.transport === "tor").length, 3);
    const torRecipient = await address();
    await peers.get("c")!.addresses.register(torRecipient.record);
    const returnTransfer = await peers
      .get("b")!
      .messages.send(
        torRecipient.address,
        peers.get("b")!.messages.source({ ...message, messageId: 50 }),
        undefined,
        { operationId: "direct-to-tor-peer" },
      );
    assert.equal(
      (await returnTransfer.wait({ signal: AbortSignal.timeout(8000) })).status,
      "completed",
    );
    await eventually(() => received.get("c")!.length === 1);
    assert.ok(
      network.requests.some(
        (req) =>
          req.host.startsWith("c") && req.path === protocol.messagePath && req.transport === "tor",
      ),
    );
    assert.ok(
      !network.requests.some((req) => req.host.startsWith("c") && req.transport === "direct"),
    );

    peers.get("a")!.network.configure({ enabled: false });
    await send("a", "direct-disabled-again");
    await eventually(() => received.get("b")!.length === 4);
    assert.deepEqual(await peers.get("a")!.addresses.lookup(target.address), before);
    assert.equal(
      network.requests.filter(
        (req) => req.transport === "direct" && req.path === protocol.messagePath,
      ).length,
      0,
    );
  },
);

test(
  "public direct HTTPS carries signed streaming archive upload and range download",
  { timeout: 30_000 },
  async (t) => {
    const network = await publicNetwork(t, ["i", "j"], { archiveDelayMs: 300 });
    const store = new TestArchives();
    const policy = archivePolicy();
    const senderHost = config("i");
    const receiverHost = config("j");
    const a = createFederation({
      storage: senderHost.storage,
      limits: { controlRequestDeadlineMs: 200, archiveRequestDeadlineMs: 8000 },
      tor: network.configs.get("i")!.tor,
      networking: { enabled: true, directOrigin: network.configs.get("i")!.directOrigin },
      handlers: {
        routes: senderHost.routes,
        proofs: policy.proofs,
        authorization: policy.authorization,
      },
    });
    const b = createFederation({
      storage: Object.assign(receiverHost.storage, { archives: store }),
      limits: { controlRequestDeadlineMs: 200, archiveRequestDeadlineMs: 8000 },
      tor: network.configs.get("j")!.tor,
      networking: { enabled: true, directOrigin: network.configs.get("j")!.directOrigin },
      handlers: {
        routes: receiverHost.routes,
        authorization: policy.authorization,
        archives: store,
      },
    });
    t.after(async () => {
      await Promise.all([a.stop(), b.stop()]);
      await network.close();
    });
    await Promise.all([a.start(), b.start()]);
    const target = await address();
    await b.addresses.register(target.record);
    const data = Buffer.alloc(9 * 1024 * 1024 + 37, 21);
    const info = {
      byteLength: data.length,
      sha256: createHash("sha256").update(data).digest("base64url"),
    };
    const input: ArchiveSource = {
      sourceId: "direct-stream-fixture",
      archive: {
        id: "direct-archive-fixture",
        locator: protocol.archiveGatewayLocator(
          "direct-archive-fixture",
          network.configs.get("j")!.tor.onionService,
        ),
      },
      expectedRevision: null,
      async describe() {
        return info;
      },
      async open(options) {
        let offset = options.range?.offset ?? 0;
        const end = offset + (options.range?.length ?? data.length);
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            options.signal?.throwIfAborted();
            if (offset === end) {
              controller.close();
              return;
            }
            const next = Math.min(end, offset + 64 * 1024);
            controller.enqueue(data.subarray(offset, next));
            offset = next;
          },
        });
      },
    };
    const upload = await a.archives.send(target.address, input);
    const result = await upload.wait({ signal: AbortSignal.timeout(10_000) });
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.deepEqual(store.data.get(input.archive.id)?.data, data);
    assert.ok(store.maxChunk <= 64 * 1024);
    let readBytes: Buffer | undefined;
    const wanted = data.subarray(123, 123 + 8197);
    const read = await a.archives.read(
      target.address,
      input.archive,
      {
        async receive(stream) {
          readBytes = Buffer.from(await new Response(stream).arrayBuffer());
        },
      },
      undefined,
      {
        expectedInfo: info,
        range: { offset: 123, length: wanted.length },
        expectedRangeSha256: createHash("sha256").update(wanted).digest("base64url"),
      },
    );
    assert.equal((await read.wait({ signal: AbortSignal.timeout(8000) })).status, "completed");
    assert.deepEqual(readBytes, wanted);
    const archivePaths = network.requests.filter((req) =>
      req.path.startsWith("/federation/v1/archive/"),
    );
    const bytePaths = new Set([
      "/federation/v1/archive/object",
      "/federation/v1/archive/object/read",
      "/federation/v1/archive/multipart/part",
    ]);
    assert.ok(archivePaths.some((req) => req.path.endsWith("multipart/part")));
    assert.ok(archivePaths.some((req) => req.path.endsWith("multipart/init")));
    for (const req of archivePaths)
      assert.equal(req.transport, bytePaths.has(req.path) ? "direct" : "tor");
    assert.ok(
      network.requests
        .filter((req) => !bytePaths.has(req.path))
        .every((req) => req.transport === "tor"),
    );
    assert.ok(
      !network.requests.some((req) => req.path === "/.well-known/unolock-federation/v1/networking"),
    );
  },
);
