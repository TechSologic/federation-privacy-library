import test from "node:test";
import assert from "node:assert/strict";
import { TestNetwork } from "../../src/testing/index.js";
import { collect } from "../../src/streams.js";
import { encodeMessage, messagePath } from "../../src/protocol/messages.js";
import { HttpWire } from "../../src/transport.js";
import { address, config, endpoint, eventually, message } from "../helpers.js";

test("verified lookup bindings survive restart and do not require a reachable directory", async (t) => {
  const network = new TestNetwork();
  const senderConfig = config("a", ["b"]);
  let sender = network.createRuntime(senderConfig);
  const owner = network.createRuntime(config("b"));
  t.after(async () => Promise.all([sender.stop(), owner.stop()]));
  await Promise.all([sender.start(), owner.start()]);
  const target = await address();
  await owner.addresses.register(target.record);
  const first = await sender.addresses.lookup(target.address);
  assert.ok(first);
  await sender.stop();
  await owner.stop();
  sender = network.createRuntime(senderConfig);
  await sender.start();
  assert.deepEqual(await sender.addresses.lookup(target.address), first);
});

test("an address without an expiry receives a standing route for offline clients", async (t) => {
  const network = new TestNetwork();
  const ownerConfig = config("b");
  const authorize = ownerConfig.routes!.authorize;
  let expiresAt: number | undefined;
  const owner = network.createRuntime({
    ...ownerConfig,
    routes: {
      async authorize(request) {
        expiresAt = request.route.expiresAt;
        return authorize(request);
      },
    },
  });
  t.after(() => owner.stop());
  await owner.start();
  await owner.addresses.register((await address()).record);
  assert.equal(expiresAt, 0);
});

test("a signed sealed route replicates over HTTP and is resolved through a separate peer", async (t) => {
  const network = new TestNetwork();
  const replicaConfig = config("a");
  const replica = network.createRuntime(replicaConfig);
  const owner = network.createRuntime(config("b", ["a"]));
  const sender = network.createRuntime(config("c", ["a"]));
  t.after(async () => Promise.all([replica.stop(), owner.stop(), sender.stop()]));
  await Promise.all([replica.start(), owner.start(), sender.start()]);
  const target = await address();
  await owner.addresses.register(target.record);
  await eventually(
    async () =>
      !!(await replicaConfig.storage.state.get({
        collection: "replica",
        key: target.record.identity.addressHash,
      })),
  );
  const replicated = await replicaConfig.storage.state.get({
    collection: "replica",
    key: target.record.identity.addressHash,
  });
  const value = JSON.parse(Buffer.from(replicated!.value.bytes).toString()).value;
  assert.ok(value.encoded.length > 8192, "Fixture must exercise the previous wire limit");
  await eventually(
    async () =>
      (await owner.addresses.get(target.record.identity.addressHash))?.publication === "published",
  );
  const result = await sender.addresses.lookup(target.address);
  assert.deepEqual(result?.keys, target.record.keys);
  assert.equal(result?.routes.messageOnionService, endpoint("b"));
});

test(
  "two public instances discover an address and deliver the exact envelope to node custody",
  { timeout: 15000 },
  async (t) => {
    const network = new TestNetwork();
    const received: { bytes: Uint8Array; id: string }[] = [];
    const a = network.createRuntime(config("a", ["b"]));
    const b = network.createRuntime({
      ...config("b", ["a"]),
      messages: {
        receiver: {
          async receive(stream, metadata) {
            received.push({ bytes: await collect(stream, 256 * 1024), id: metadata.deliveryId });
            assert.equal(metadata.messageId, message.messageId);
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
    const result = await a.addresses.lookup(target.address);
    assert.deepEqual(result?.keys, target.record.keys);
    assert.equal(result?.routes.messageOnionService, endpoint("b"));
    const events: string[] = [];
    const source = a.messages.source(message);
    const transfer = await a.messages.send(
      target.address,
      source,
      {
        onEvent: (event) => {
          events.push(event.type);
        },
      },
      { operationId: "first-message" },
    );
    assert.deepEqual(await transfer.wait({ signal: AbortSignal.timeout(8000) }), {
      status: "completed",
      result: { kind: "message", outcome: "delivered" },
    });
    await eventually(() => received.length === 1);
    assert.deepEqual(received[0].bytes, await collect(await source.open({}), 256 * 1024));
    const duplicate = await a.messages.send(target.address, source, undefined, {
      operationId: "first-message",
    });
    assert.equal(duplicate.id, transfer.id);
    await assert.rejects(
      a.messages.send(target.address, a.messages.source({ ...message, messageId: 2 }), undefined, {
        operationId: "first-message",
      }),
      /different content/,
    );
    assert.ok(events.includes("completed"));
  },
);

test(
  "queued exact bytes survive stopping and recreating a sender; offline attempts retry",
  { timeout: 15000 },
  async (t) => {
    const network = new TestNetwork();
    const aConfig = config("c", ["d"]);
    let received = 0;
    let a = network.createRuntime(aConfig);
    const b = network.createRuntime({
      ...config("d", ["c"]),
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
    network.block(endpoint("d"));
    const transfer = await a.messages.send(target.address, a.messages.source(message));
    await eventually(async () => (await transfer.status()).state === "retrying");
    await a.stop();
    a = network.createRuntime(aConfig);
    network.unblock(endpoint("d"));
    await a.start();
    const resumed = await a.transfers.get(transfer.id);
    assert.ok(resumed);
    assert.equal((await resumed.wait({ signal: AbortSignal.timeout(8000) })).status, "completed");
    await eventually(() => received === 1);
  },
);

test(
  "cancellation is durable and listener exceptions cannot break other transfers",
  { timeout: 10000 },
  async (t) => {
    const network = new TestNetwork();
    const a = network.createRuntime(config("e", ["f"]));
    t.after(() => a.stop());
    await a.start();
    const target = await address();
    const transfer = await a.messages.send(target.address, a.messages.source(message), {
      onEvent() {
        throw new Error("app observer failed");
      },
    });
    await transfer.cancel();
    assert.deepEqual(await transfer.wait(), { status: "cancelled" });
    await assert.rejects(transfer.resume(), /Only failed or paused/);
  },
);

test(
  "address updates use revisions and removal stops local key serving",
  { timeout: 10000 },
  async (t) => {
    const network = new TestNetwork();
    const a = network.createRuntime(config("g", ["h"]));
    const b = network.createRuntime(config("h", ["g"]));
    t.after(async () => {
      await Promise.all([a.stop(), b.stop()]);
    });
    await Promise.all([a.start(), b.start()]);
    const target = await address();
    const registered = await b.addresses.register(target.record);
    const disabled = await b.addresses.update(
      { ...target.record, enabled: false },
      registered.record.revision,
    );
    await assert.rejects(
      b.addresses.update(target.record, registered.record.revision),
      /revision changed/,
    );
    assert.equal(disabled.publication, "disabled");
    await b.addresses.remove(target.record.identity.addressHash, disabled.record.revision);
    assert.equal(await b.addresses.get(target.record.identity.addressHash), null);
  },
);

test(
  "lost custody acknowledgement retries exact bytes without a duplicate receiver effect",
  { timeout: 10000 },
  async (t) => {
    const network = new TestNetwork();
    const receiverConfig = config("n", ["m"]);
    const backend = receiverConfig.storage;
    let lost = false;
    let effects = 0;
    const b = network.createRuntime({
      ...receiverConfig,
      storage: {
        addresses: backend.addresses,
        state: backend.state,
        lease: backend.lease,
        async commit(id, mutations, fence) {
          const result = await backend.commit(id, mutations, fence);
          if (
            !lost &&
            result.outcome === "committed" &&
            mutations.some(
              (m) =>
                m.kind === "state" && m.key.collection === "ingress" && m.expectedRevision === null,
            )
          ) {
            lost = true;
            throw new Error("Simulated response loss after commit");
          }
          return result;
        },
      },
      messages: {
        receiver: {
          async receive(stream) {
            await collect(stream, 256 * 1024);
            effects++;
          },
        },
      },
    });
    const a = network.createRuntime(config("m", ["n"]));
    t.after(async () => {
      await Promise.all([a.stop(), b.stop()]);
    });
    await Promise.all([a.start(), b.start()]);
    const target = await address();
    await b.addresses.register(target.record);
    const transfer = await a.messages.send(target.address, a.messages.source(message));
    assert.equal((await transfer.wait({ signal: AbortSignal.timeout(8000) })).status, "completed");
    await eventually(() => effects === 1);
    assert.ok(lost);
    assert.ok((await transfer.status()).attempt > 1);
    const capacity = await backend.state.get({ collection: "capacity", key: "ingress" });
    assert.equal(JSON.parse(Buffer.from(capacity!.value.bytes).toString()).value, 0);
    const receipts = await backend.state.list({ collection: "ingress", limit: 10 });
    assert.equal(receipts.items.length, 1);
    const receipt = JSON.parse(Buffer.from(receipts.items[0]!.value.bytes).toString()).value;
    assert.equal(receipt.done, true);
    assert.equal("addressHash" in receipt, false);
    assert.equal("envelope" in receipt, false);
  },
);

test(
  "an uncertain local submission can be retried with its operation identifier",
  { timeout: 10000 },
  async (t) => {
    const network = new TestNetwork();
    const sender = config("o", ["p"]);
    const backend = sender.storage;
    let lost = false;
    const a = network.createRuntime({
      ...sender,
      storage: {
        addresses: backend.addresses,
        state: backend.state,
        lease: backend.lease,
        async commit(id, mutations, fence) {
          const result = await backend.commit(id, mutations, fence);
          if (
            !lost &&
            result.outcome === "committed" &&
            mutations.some(
              (m) =>
                m.kind === "state" && m.key.collection === "outbox" && m.expectedRevision === null,
            )
          ) {
            lost = true;
            throw new Error("Simulated unknown commit result");
          }
          return result;
        },
      },
    });
    const b = network.createRuntime({
      ...config("p", ["o"]),
      messages: {
        receiver: {
          async receive(stream) {
            await collect(stream, 256 * 1024);
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
    await assert.rejects(
      a.messages.send(target.address, a.messages.source(message), undefined, {
        operationId: "uncertain",
      }),
      (error: any) => error.outcome === "unknown" && error.operationId === "uncertain",
    );
    const retry = await a.messages.send(target.address, a.messages.source(message), undefined, {
      operationId: "uncertain",
    });
    assert.equal((await retry.wait({ signal: AbortSignal.timeout(8000) })).status, "completed");
    const stored = await backend.state.get({ collection: "outbox", key: "uncertain" });
    const tombstone = JSON.parse(Buffer.from(stored!.value.bytes).toString()).value;
    assert.equal(tombstone.snapshot.state, "completed");
    assert.equal(typeof tombstone.submissionCommitment, "string");
    for (const field of ["destination", "envelope", "digest", "dueAt"])
      assert.equal(field in tombstone, false);
    const exactRetry = await a.messages.send(
      target.address,
      a.messages.source(message),
      undefined,
      { operationId: "uncertain" },
    );
    assert.equal((await exactRetry.wait()).status, "completed");
  },
);

test(
  "one runtime exclusively owns a storage adapter until clean shutdown",
  { timeout: 10000 },
  async (t) => {
    const network = new TestNetwork();
    const cfg = config("q");
    const first = network.createRuntime(cfg),
      second = network.createRuntime(cfg);
    t.after(async () => {
      await Promise.all([first.stop(), second.stop()]);
    });
    await first.start();
    await assert.rejects(second.start(), /Another runtime owns/);
    await first.stop();
    await second.start();
    assert.equal(second.status().state, "ready");
  },
);

test(
  "unknown ingress releases active capacity without retaining attacker records",
  { timeout: 10000 },
  async (t) => {
    const network = new TestNetwork();
    const receiver = config("s");
    const backend = receiver.storage;
    const b = network.createRuntime({
      ...receiver,
      limits: { maxPendingOperations: 1 },
      messages: {
        receiver: {
          async receive() {
            assert.fail("an unregistered destination must not reach the receiver");
          },
        },
      },
    });
    t.after(async () => {
      await b.stop();
    });
    await b.start();
    const wire = new HttpWire(network.connector(), receiver.tor);
    const capacity = async () => {
      const record = await backend.state.get({ collection: "capacity", key: "ingress" });
      if (!record) return 0;
      return JSON.parse(Buffer.from(record.value.bytes).toString()).value as number;
    };
    const submit = async (messageId: number) => {
      const response = await wire.request(receiver.tor.onionService, {
        path: messagePath,
        signal: AbortSignal.timeout(2000),
        body: encodeMessage({ ...message, messageId }),
        headers: {
          "content-type": "application/octet-stream",
          "x-unolock-address-hash": "a".repeat(64),
        },
      });
      await collect(response.body, 8192);
      assert.equal(response.status, 202);
    };
    await submit(message.messageId);
    await eventually(async () => (await capacity()) === 0);
    await submit(message.messageId + 1);
    await eventually(async () => (await capacity()) === 0);
    const receipts = await backend.state.list({ collection: "ingress", limit: 10 });
    assert.equal(receipts.items.length, 0);
    await wire.stop();
  },
);

test(
  "lease renewal loss closes serving and rejects further mutations",
  { timeout: 5000 },
  async (t) => {
    const network = new TestNetwork();
    const cfg = config("t");
    const backend = cfg.storage;
    let stopped = 0;
    const runtime = network.createRuntime(
      {
        ...cfg,
        storage: {
          addresses: backend.addresses,
          state: backend.state,
          lease: {
            ...backend.lease,
            async renew() {
              return false;
            },
          },
          commit: (id, changes, fence) => backend.commit(id, changes, fence),
        },
      },
      { leaseRenewMs: 20, leaseTtlMs: 200, onStopped: () => stopped++ },
    );
    t.after(() => runtime.stop());
    await runtime.start();
    await eventually(() => runtime.status().reason === "storage-unavailable", 1000);
    assert.equal(stopped, 1);
    await assert.rejects(
      runtime.addresses.register((await address()).record),
      /not running|ownership|own storage/,
    );
  },
);

test("lease expiry closes serving when renewal never settles", { timeout: 5000 }, async (t) => {
  const network = new TestNetwork();
  const cfg = config("u");
  const backend = cfg.storage;
  let stopped = 0;
  const runtime = network.createRuntime(
    {
      ...cfg,
      storage: {
        addresses: backend.addresses,
        state: backend.state,
        lease: {
          ...backend.lease,
          async renew() {
            return new Promise<boolean>(() => {});
          },
        },
        commit: (id, changes, fence) => backend.commit(id, changes, fence),
      },
    },
    { leaseRenewMs: 20, leaseTtlMs: 120, onStopped: () => stopped++ },
  );
  t.after(() => runtime.stop());
  await runtime.start();
  await eventually(() => runtime.status().reason === "storage-unavailable", 1000);
  assert.equal(stopped, 1);
  await assert.rejects(
    runtime.addresses.register((await address()).record),
    /not running|ownership|own storage/,
  );
  const successor = network.createRuntime({ ...cfg, storage: backend });
  t.after(() => successor.stop());
  assert.equal((await successor.start()).state, "ready");
});
