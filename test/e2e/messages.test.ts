import test from "node:test";
import assert from "node:assert/strict";
import { TestNetwork } from "../../src/testing/index.js";
import { collect } from "../../src/streams.js";
import { address, config, endpoint, eventually, message } from "../helpers.js";

test(
  "two public instances discover an address and deliver the exact envelope to node custody",
  { timeout: 15000 },
  async (t) => {
    const network = new TestNetwork();
    const received: { bytes: Uint8Array; id: string }[] = [];
    const a = network.create(config("a", ["b"]));
    const b = network.create({
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
      { onEvent: (event) => events.push(event.type) },
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
    let a = network.create(aConfig);
    const b = network.create({
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
    a = network.create(aConfig);
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
    const a = network.create(config("e", ["f"]));
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
    const a = network.create(config("g", ["h"]));
    const b = network.create(config("h", ["g"]));
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
    const b = network.create({
      ...receiverConfig,
      storage: {
        addresses: backend.addresses,
        state: backend.state,
        async commit(id, mutations) {
          const result = await backend.commit(id, mutations);
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
    const a = network.create(config("m", ["n"]));
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
    const a = network.create({
      ...sender,
      storage: {
        addresses: backend.addresses,
        state: backend.state,
        async commit(id, mutations) {
          const result = await backend.commit(id, mutations);
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
    const b = network.create({
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
  },
);

test(
  "one runtime exclusively owns a storage adapter until clean shutdown",
  { timeout: 10000 },
  async (t) => {
    const network = new TestNetwork();
    const cfg = config("q");
    const first = network.create(cfg),
      second = network.create(cfg);
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
