import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { TestNetwork, memorySource } from "../../src/testing/index.js";
import type { ArchiveInfo, ArchiveSource } from "../../src/index.js";
import { collect } from "../../src/streams.js";
import { document, gatewayLocator, readDocument } from "../../src/protocol/archives.js";
import { address, config, endpoint } from "../helpers.js";
import { archivePolicy, TestArchives } from "../archive-adapter.js";

async function pair(t: any) {
  const network = new TestNetwork();
  const policy = archivePolicy();
  const store = new TestArchives();
  const a = network.create({ ...config("i", ["j"]), proofs: policy.proofs });
  const b = network.create({
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
  return { a, b, target, store, policy, network };
}
function source(data: Uint8Array, id = "syntheticarchive1"): ArchiveSource {
  const memory = memorySource(data);
  return {
    ...memory,
    archive: { id, locator: gatewayLocator(id, endpoint("j")) },
    expectedRevision: null,
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
    const events: string[] = [];
    const send = await a.archives.send(target.address, input, {
      onEvent: (event) => events.push(event.type),
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
      { range: { offset: 257, length: 1234 } },
    );
    assert.equal((await read.wait({ signal: AbortSignal.timeout(8000) })).status, "completed");
    assert.deepEqual(received, Buffer.from(data.slice(257, 1491)));
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
        context: document({
          expectedInfo: { byteLength: data.length, sha256: "incorrect-digest" },
        }),
      },
    );
    assert.equal((await bad.wait({ signal: AbortSignal.timeout(8000) })).status, "failed");
  },
);
test(
  "multipart upload retries a persisted part and commits only once",
  { timeout: 20000 },
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
test(
  "signed version commits preserve predecessor and scope bindings",
  { timeout: 15000 },
  async (t) => {
    const { a, target, policy } = await pair(t);
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
    assert.equal(
      (
        await (
          await a.archives.send(target.address, input)
        ).wait({ signal: AbortSignal.timeout(8000) })
      ).status,
      "completed",
    );
    const commit = await a.archives.commitVersion(target.address, archive, {
      expectedPredecessor: null,
      signedSuccessor: signed,
    });
    assert.equal(commit.outcome, "committed");
    const head = await a.archives.head(target.address, archive);
    assert.equal(head?.hash, readDocument(signed).pointerHash);
    const successor = policy.pointer(archive.id, info, readDocument(signed));
    const updated = await a.archives.commitVersion(target.address, archive, {
      expectedPredecessor: head!.hash,
      signedSuccessor: successor,
    });
    assert.equal(updated.outcome, "committed");
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
    let a = network.create(sender);
    const b = network.create({
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
    a = network.create(sender);
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
    const { a, target } = await pair(t);
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
    await a.archives.remove(target.address, created.archive, {
      context: document({
        archiveListID: collection.id,
        authorityArchiveID: collection.authorityArchiveId,
      }),
    });
    const after = await a.archives.list(target.address, collection, { limit: 64 });
    assert.equal(after.outcome, "listed");
    if (after.outcome === "listed") assert.equal(after.page.items.length, 0);
  },
);
