import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { TestNetwork, memorySource } from "../../src/testing/index.js";
import type { ArchiveInfo, ArchiveSource } from "../../src/index.js";
import { collect } from "../../src/streams.js";
import {
  archivePath,
  canonical,
  document,
  gatewayLocator,
  readDocument,
  shaHex,
} from "../../src/protocol/archives.js";
import { HttpWire } from "../../src/transport.js";
import { address, config, endpoint, eventually } from "../helpers.js";
import { archivePolicy, TestArchives } from "../archive-adapter.js";

async function pair(t: any) {
  const network = new TestNetwork();
  const policy = archivePolicy();
  const store = new TestArchives();
  const a = network.createRuntime({
    ...config("i", ["j"]),
    proofs: policy.proofs,
    authorization: policy.authorization,
  });
  const receiverConfig = config("j", ["i"]);
  const b = network.createRuntime({
    ...receiverConfig,
    authorization: policy.authorization,
    archives: { receiver: store, store },
  });
  t.after(async () => {
    await Promise.all([a.stop(), b.stop()]);
  });
  await Promise.all([a.start(), b.start()]);
  const target = await address();
  await b.addresses.register(target.record);
  return { a, b, target, store, policy, network, receiverStorage: receiverConfig.storage };
}
function source(
  data: Uint8Array,
  id = "syntheticarchive1",
  expectedRevision: string | null = null,
): ArchiveSource {
  const memory = memorySource(data);
  return {
    ...memory,
    archive: { id, locator: gatewayLocator(id, endpoint("j")) },
    expectedRevision,
    async describe() {
      return {
        byteLength: data.length,
        sha256: createHash("sha256").update(data).digest("base64url"),
      };
    },
  };
}
test(
  "archive streaming, signed authorization, range reads and full encrypted integrity",
  { timeout: 15000 },
  async (t) => {
    const { a, target, store } = await pair(t);
    const data = new Uint8Array(300_001).map((_, i) => i % 251);
    const input = source(data);
    const info = await input.describe();
    const events: string[] = [];
    const send = await a.archives.send(target.address, input, {
      onEvent: (event) => {
        events.push(event.type);
      },
    });
    const result = await send.wait({ signal: AbortSignal.timeout(8000) });
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.deepEqual(store.data.get(input.archive.id)?.data, Buffer.from(data));
    assert.equal(store.commits, 1);
    assert.ok(store.maxChunk <= 64 * 1024);
    assert.ok(events.includes("progress"));
    let received: Uint8Array | undefined;
    const read = await a.archives.read(
      target.address,
      input.archive,
      {
        async receive(stream, metadata) {
          assert.equal(metadata.info.byteLength, data.length);
          received = await collect(stream, 1234);
        },
      },
      undefined,
      {
        range: { offset: 257, length: 1234 },
        expectedInfo: info,
        expectedRangeSha256: createHash("sha256").update(data.slice(257, 1491)).digest("base64url"),
      },
    );
    assert.equal((await read.wait({ signal: AbortSignal.timeout(8000) })).status, "completed");
    assert.deepEqual(received, Buffer.from(data.slice(257, 1491)));
    const badRange = await a.archives.read(
      target.address,
      input.archive,
      {
        async receive(stream) {
          await collect(stream, 1234);
        },
      },
      undefined,
      {
        range: { offset: 257, length: 1234 },
        expectedInfo: info,
        expectedRangeSha256: createHash("sha256").update("incorrect-range").digest("base64url"),
      },
    );
    assert.equal((await badRange.wait({ signal: AbortSignal.timeout(8000) })).status, "failed");
    const bad = await a.archives.read(
      target.address,
      input.archive,
      {
        async receive(stream) {
          await collect(stream, data.length);
        },
      },
      undefined,
      {
        expectedInfo: {
          byteLength: data.length,
          sha256: createHash("sha256").update("incorrect").digest("base64url"),
        },
      },
    );
    assert.equal((await bad.wait({ signal: AbortSignal.timeout(8000) })).status, "failed");
  },
);
test(
  "multipart upload retries parts and atomically replaces a whole object",
  { timeout: 30000 },
  async (t) => {
    const { a, target, store } = await pair(t);
    let interrupted = false;
    store.afterReceive = async (metadata) => {
      if (!interrupted && metadata.range.length === 8 * 1024 ** 2) {
        interrupted = true;
        throw new Error("Simulated loss after durable part staging");
      }
    };
    const input = source(new Uint8Array(9 * 1024 ** 2 + 7).fill(37), "syntheticarchive2");
    const transfer = await a.archives.send(target.address, input);
    const result = await transfer.wait({ signal: AbortSignal.timeout(15000) });
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(interrupted, true);
    assert.equal(store.commits, 1);
    assert.equal(store.data.get(input.archive.id)?.info.sha256, (await input.describe()).sha256);
    assert.ok((await transfer.status()).attempt > 1);
    assert.equal(result.status, "completed");
    if (result.status !== "completed" || result.result.kind !== "archive-send")
      throw new Error("Expected a completed archive upload");
    const firstRevision = result.result.revision;

    store.afterReceive = undefined;
    const replacement = source(
      new Uint8Array(9 * 1024 ** 2 + 7).fill(38),
      input.archive.id,
      firstRevision,
    );
    const replaced = await (
      await a.archives.send(target.address, replacement)
    ).wait({ signal: AbortSignal.timeout(15000) });
    assert.equal(replaced.status, "completed", JSON.stringify(replaced));
    assert.equal(store.commits, 2);
    assert.equal(
      store.data.get(input.archive.id)?.info.sha256,
      (await replacement.describe()).sha256,
    );

    const stale = source(
      new Uint8Array(9 * 1024 ** 2 + 7).fill(39),
      input.archive.id,
      firstRevision,
    );
    const rejected = await (
      await a.archives.send(target.address, stale)
    ).wait({ signal: AbortSignal.timeout(8000) });
    assert.equal(rejected.status, "failed");
    assert.equal(store.commits, 2);
  },
);
test("wrong authority fails closed before archive receiver runs", { timeout: 15000 }, async (t) => {
  const { a, target, store } = await pair(t);
  const foreign = archivePolicy();
  const transfer = await a.archives.send(
    target.address,
    source(new Uint8Array([4, 5, 6])),
    undefined,
    { proofs: foreign.proofs },
  );
  const result = await transfer.wait({ signal: AbortSignal.timeout(8000) });
  assert.equal(result.status, "failed");
  assert.equal(store.stages.size, 0);
  assert.equal(store.commits, 0);
});
test("archive attempts have an absolute lifetime even while an adapter is active", async (t) => {
  const network = new TestNetwork();
  const policy = archivePolicy();
  const store = new TestArchives();
  let aborted = false;
  store.afterReceive = async (metadata) => {
    await new Promise<void>((resolve) => {
      if (metadata.signal.aborted) resolve();
      else metadata.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    aborted = metadata.signal.aborted;
    metadata.signal.throwIfAborted();
  };
  const a = network.createRuntime(
    {
      ...config("u", ["v"]),
      proofs: policy.proofs,
      authorization: policy.authorization,
      limits: { maxAttempts: 1 },
    },
    { requestDeadlineMs: 150 },
  );
  const b = network.createRuntime(
    {
      ...config("v", ["u"]),
      authorization: policy.authorization,
      archives: { receiver: store, store },
    },
    { requestDeadlineMs: 150 },
  );
  t.after(async () => Promise.all([a.stop(), b.stop()]));
  await Promise.all([a.start(), b.start()]);
  const target = await address();
  await b.addresses.register(target.record);
  const transfer = await a.archives.send(target.address, source(new Uint8Array([8, 9, 10])));
  assert.equal((await transfer.wait({ signal: AbortSignal.timeout(3000) })).status, "failed");
  await eventually(() => aborted);
});
test("multipart session identity ignores unsigned peer locator variants", async (t) => {
  const network = new TestNetwork();
  const policy = archivePolicy();
  const store = new TestArchives();
  const cfg = {
    ...config("w"),
    authorization: policy.authorization,
    archives: { receiver: store, store },
  };
  const runtime = network.createRuntime(cfg);
  t.after(() => runtime.stop());
  await runtime.start();
  const archiveID = "synthetic-multipart-locator";
  const proofRequest = {
    archiveID,
    md5: createHash("md5")
      .update(new Uint8Array([1]))
      .digest("base64"),
    contentLength: 1,
    expectedRevision: null,
  };
  const canonicalRequest = canonical(proofRequest);
  const [proof] = await policy.proofs.provide({
    operation: "multipart-init",
    target: { archive: { id: archiveID, locator: "opaque-client-locator" } },
    canonicalRequest,
    requestHash: shaHex(canonicalRequest),
    signal: AbortSignal.timeout(1000),
  });
  const wire = new HttpWire(network.connector(), cfg.tor);
  const init = async (locator: string) =>
    wire.json(
      cfg.tor.onionService,
      archivePath + "multipart/init",
      {
        type: "unolock.federation.archive.multipart.init.request.v1",
        locator,
        ...proofRequest,
        writeGrant: readDocument(proof),
      },
      AbortSignal.timeout(2000),
    ) as Promise<{ uploadId: string }>;
  const first = await init("opaque-locator-a");
  const second = await init("opaque-locator-b");
  assert.equal(second.uploadId, first.uploadId);
  const sessions = await cfg.storage.state.list({ collection: "archive-incoming", limit: 10 });
  assert.equal(sessions.items.length, 1);
  await wire.stop();
});
test(
  "signed version commits preserve predecessor and scope bindings",
  { timeout: 15000 },
  async (t) => {
    const { a, target, policy, store, receiverStorage } = await pair(t);
    const input = source(new Uint8Array([1]));
    const archive = input.archive;
    const info: ArchiveInfo = {
      byteLength: 1,
      sha256: createHash("sha256")
        .update(new Uint8Array([1]))
        .digest("base64url"),
    };
    const signed = policy.pointer(archive.id, info);
    await assert.rejects(
      a.archives.commitVersion(target.address, archive, {
        expectedPredecessor: null,
        signedSuccessor: signed,
      }),
    );
    const upload = await (
      await a.archives.send(target.address, input)
    ).wait({ signal: AbortSignal.timeout(8000) });
    assert.equal(upload.status, "completed", JSON.stringify(upload));
    assert.equal(
      (
        await receiverStorage.state.list({
          collection: "archive-content",
          limit: 10,
        })
      ).items.length,
      0,
      "a completed whole-object replacement must not create unreferenced content state",
    );
    const wrongInfo: ArchiveInfo = {
      byteLength: 1,
      sha256: createHash("sha256")
        .update(new Uint8Array([9]))
        .digest("base64url"),
    };
    await assert.rejects(
      a.archives.commitVersion(target.address, archive, {
        expectedPredecessor: null,
        signedSuccessor: policy.pointer(archive.id, wrongInfo),
      }),
    );
    const commit = await a.archives.commitVersion(target.address, archive, {
      expectedPredecessor: null,
      signedSuccessor: signed,
    });
    assert.equal(commit.outcome, "committed");
    assert.equal(
      (
        await receiverStorage.state.list({
          collection: "archive-content",
          limit: 10,
        })
      ).items.length,
      0,
    );
    const head = await a.archives.head(target.address, archive, {
      freshness: { minimumSequence: 0 },
    });
    assert.equal(head?.hash, readDocument(signed).pointerHash);
    if (upload.status !== "completed" || upload.result.kind !== "archive-send")
      throw new Error("Expected a completed archive upload");
    const replacement = source(new Uint8Array([2]), archive.id, upload.result.revision);
    const replacementInfo = await replacement.describe();
    const replaced = await (
      await a.archives.send(target.address, replacement)
    ).wait({ signal: AbortSignal.timeout(8000) });
    assert.equal(replaced.status, "completed", JSON.stringify(replaced));
    assert.equal(
      await a.archives.head(target.address, archive, {
        freshness: { minimumSequence: 0 },
      }),
      null,
      "a signed head for superseded bytes must not be exposed as current",
    );
    await assert.rejects(
      a.archives.head(target.address, archive, {
        freshness: {
          minimumSequence: head!.sequence,
          hashAtMinimum: head!.hash,
        },
      }),
      /older than trusted local state/i,
    );
    const successor = policy.pointer(archive.id, replacementInfo, readDocument(signed));
    const updated = await a.archives.commitVersion(target.address, archive, {
      expectedPredecessor: head!.hash,
      signedSuccessor: successor,
    });
    assert.equal(updated.outcome, "committed");
    if (updated.outcome === "committed") {
      const forged = {
        ...readDocument(updated.version.signed),
        signature: Buffer.alloc(64, 7).toString("base64url"),
      };
      store.versions.set(archive.id, { ...updated.version, signed: document(forged) });
      await assert.rejects(
        a.archives.head(target.address, archive, {
          freshness: {
            minimumSequence: updated.version.sequence,
            hashAtMinimum: updated.version.hash,
          },
        }),
        /signature/i,
      );
      store.versions.set(archive.id, commit.version);
      await assert.rejects(
        a.archives.head(target.address, archive, {
          freshness: {
            minimumSequence: updated.version.sequence,
            hashAtMinimum: updated.version.hash,
          },
        }),
        /older than trusted local state/i,
      );
      store.versions.set(archive.id, updated.version);
    }
    const tampered = { ...readDocument(successor), writerAccessId: "different-writer" };
    await assert.rejects(
      a.archives.commitVersion(target.address, archive, {
        expectedPredecessor: head!.hash,
        signedSuccessor: document(tampered),
      }),
    );
  },
);

test(
  "signed head commit rejects a whole-object replacement racing after validation",
  { timeout: 15000 },
  async (t) => {
    const { a, target, policy, store } = await pair(t);
    const input = source(new Uint8Array([2]));
    const info = await input.describe();
    const first = policy.pointer(input.archive.id, info);
    const upload = await (
      await a.archives.send(target.address, input)
    ).wait({ signal: AbortSignal.timeout(8000) });
    assert.equal(upload.status, "completed", JSON.stringify(upload));
    const committed = await a.archives.commitVersion(target.address, input.archive, {
      expectedPredecessor: null,
      signedSuccessor: first,
    });
    assert.equal(committed.outcome, "committed");
    const successor = policy.pointer(input.archive.id, info, readDocument(first));
    const original = store.commitVersion.bind(store);
    store.commitVersion = async (...args) => {
      store.data.get(input.archive.id)!.revision = '"raced-etag"';
      return original(...args);
    };
    const raced = await a.archives.commitVersion(target.address, input.archive, {
      expectedPredecessor: readDocument(first).pointerHash,
      signedSuccessor: successor,
    });
    assert.equal(raced.outcome, "conflict");
  },
);

test(
  "an idempotent signed head retry rechecks the current whole object atomically",
  { timeout: 15000 },
  async (t) => {
    const { a, target, policy, store } = await pair(t);
    const input = source(new Uint8Array([3]));
    const info = await input.describe();
    const first = policy.pointer(input.archive.id, info);
    const upload = await (
      await a.archives.send(target.address, input)
    ).wait({ signal: AbortSignal.timeout(8000) });
    assert.equal(upload.status, "completed", JSON.stringify(upload));
    const committed = await a.archives.commitVersion(target.address, input.archive, {
      expectedPredecessor: null,
      signedSuccessor: first,
    });
    assert.equal(committed.outcome, "committed");
    const original = store.commitVersion.bind(store);
    store.commitVersion = async (...args) => {
      store.data.get(input.archive.id)!.revision = '"raced-idempotent-etag"';
      return original(...args);
    };
    const retried = await a.archives.commitVersion(target.address, input.archive, {
      expectedPredecessor: null,
      signedSuccessor: first,
    });
    assert.equal(retried.outcome, "conflict");
    assert.equal(retried.current?.hash, readDocument(first).pointerHash);
  },
);

test(
  "a multipart sender resumes with a source resolver after instance replacement",
  { timeout: 20000 },
  async (t) => {
    const network = new TestNetwork();
    const policy = archivePolicy();
    const store = new TestArchives();
    const input = source(new Uint8Array(9 * 1024 ** 2 + 11).fill(19), "syntheticarchive3");
    const sender = {
      ...config("i", ["j"]),
      proofs: policy.proofs,
      sources: {
        async resolve(id: string) {
          return id === input.sourceId ? input : null;
        },
      },
    };
    let a = network.createRuntime(sender);
    const b = network.createRuntime({
      ...config("j", ["i"]),
      authorization: policy.authorization,
      archives: { receiver: store, store },
    });
    t.after(async () => {
      await Promise.all([a.stop(), b.stop()]);
    });
    await Promise.all([a.start(), b.start()]);
    const target = await address();
    await b.addresses.register(target.record);
    let reached!: () => void;
    const staged = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let held = false;
    store.afterReceive = async (metadata) => {
      if (held || metadata.range.length !== 8 * 1024 ** 2) return;
      held = true;
      reached();
      await new Promise<void>((resolve) =>
        metadata.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      metadata.signal.throwIfAborted();
    };
    const transfer = await a.archives.send(target.address, input);
    await staged;
    await a.stop();
    store.afterReceive = undefined;
    a = network.createRuntime(sender);
    await a.start();
    const resumed = await a.transfers.get(transfer.id);
    assert.ok(resumed);
    const result = await resumed.wait({ signal: AbortSignal.timeout(15000) });
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(store.commits, 1);
    assert.equal(store.data.get(input.archive.id)?.info.sha256, (await input.describe()).sha256);
  },
);

test(
  "a commit with an uncertain response is recovered without committing twice",
  { timeout: 10000 },
  async (t) => {
    const { a, target, store } = await pair(t);
    const original = store.commitStage.bind(store);
    let uncertain = false;
    store.commitStage = async (...args) => {
      const result = await original(...args);
      if (!uncertain) {
        uncertain = true;
        throw new Error("Simulated loss after durable commit");
      }
      return result;
    };
    const transfer = await a.archives.send(target.address, source(new Uint8Array(200_000).fill(7)));
    const result = await transfer.wait({ signal: AbortSignal.timeout(8000) });
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(store.commits, 1);
    assert.ok(uncertain);
  },
);

test(
  "archive creation, listing and deletion use signed control documents",
  { timeout: 10000 },
  async (t) => {
    const { a, target, policy, network, store } = await pair(t);
    const collection = {
      id: "synthetic-collection",
      authorityArchiveId: "synthetic-authority-archive",
      locator: "synthetic-collection-locator",
    };
    const archive = {
      id: "synthetic-created-archive",
      t: "Cloud",
      m: { encrypted: "opaque" },
      s: 200,
      ps: { nodeBlob: { provider: "node-blob", immutable: true } },
    };
    const created = await a.archives.create(
      target.address,
      { collection, description: document(archive) },
      {
        context: document({
          createIntent: { authorityArchiveID: collection.authorityArchiveId, archive },
        }),
      },
    );
    const listing = await a.archives.list(target.address, collection, { limit: 64 });
    assert.equal(listing.outcome, "listed");
    if (listing.outcome === "listed")
      assert.equal(listing.page.items[0].archive.id, created.archive.id);
    const cursor = store.cursorFor(collection);
    await a.archives.list(target.address, collection, {
      limit: 64,
      cursor,
    });
    await assert.rejects(
      store.list(
        { ...collection, id: "different-collection" },
        { limit: 64, cursor },
        { signal: AbortSignal.timeout(1000) },
      ),
      /cursor scope/i,
    );
    await assert.rejects(
      a.archives.list(target.address, collection, {
        limit: 64,
        cursor: "x".repeat(4097),
      }),
      /identifier/i,
    );
    await a.archives.remove(target.address, created.archive, {
      context: document({
        archiveListID: collection.id,
        authorityArchiveID: collection.authorityArchiveId,
      }),
    });
    const after = await a.archives.list(target.address, collection, { limit: 64 });
    assert.equal(after.outcome, "listed");
    if (after.outcome === "listed") assert.equal(after.page.items.length, 0);
    const legacyListRequest = { authorityArchiveID: collection.authorityArchiveId };
    const canonicalListRequest = canonical(legacyListRequest);
    const [listGrant] = await policy.proofs.provide({
      operation: "archive-list",
      target: {
        archive: { id: collection.authorityArchiveId, locator: collection.locator },
        collection,
      },
      canonicalRequest: canonicalListRequest,
      requestHash: shaHex(canonicalListRequest),
      signal: AbortSignal.timeout(1000),
    });
    const wire = new HttpWire(network.connector(), config("y").tor);
    const tamperedCollection = await wire.request(endpoint("j"), {
      path: archivePath + "list",
      signal: AbortSignal.timeout(2000),
      body: Buffer.from(
        JSON.stringify({
          type: "unolock.federation.archive.list.request.v2",
          archiveListID: "attacker-selected-collection",
          authorityArchiveID: collection.authorityArchiveId,
          listGrant: readDocument(listGrant),
        }),
      ),
      headers: { "content-type": "application/json" },
    });
    await collect(tamperedCollection.body, 8192);
    assert.equal(tamperedCollection.status, 403);
    await wire.stop();
    assert.ok(
      policy.proofRequests.some(
        ({ operation, request }) =>
          operation === "archive-create" &&
          request.archiveListID === undefined &&
          request.authorityArchiveID === collection.authorityArchiveId,
      ),
    );
    assert.ok(
      policy.proofRequests.some(
        ({ operation, request }) =>
          operation === "archive-list" &&
          request.archiveListID === undefined &&
          request.cursor === undefined,
      ),
    );
    assert.ok(
      policy.proofRequests.some(
        ({ operation, request }) =>
          operation === "archive-delete" && request.archiveListID === undefined,
      ),
    );
    assert.ok(
      policy.authorizationRequests.some(
        ({ operation, target }) =>
          operation === "archive-list" &&
          target.collection?.id === collection.id &&
          target.collection.authorityArchiveId === collection.authorityArchiveId,
      ),
    );
  },
);
