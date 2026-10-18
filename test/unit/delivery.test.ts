import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { FederationError } from "../../src/errors.js";
import {
  FederationDeliveryCoordinator,
  FederationDeliveryWorker,
  assertFederationDeliveryPendingCapacity,
  assertSameFederationDelivery,
  nextFederationDeliveryAttemptAt,
  normalizeFederationDeliveryInput,
  type FederationDeliveryResult,
  type FederationDeliveryTargetResolution,
} from "../../src/delivery/index.js";
import { TestDeliveryQueue } from "../delivery-queue.js";

const addressHash = "a".repeat(64);
const target = {
  onionService: `http://${"b".repeat(56)}.onion`,
  deliveryPath: "/federation/v1/message/receive" as const,
  priority: 0,
};
const fallback = { ...target, onionService: `http://${"c".repeat(56)}.onion`, priority: 1 };
const entry = {
  deliveryId: "synthetic_delivery_1",
  addressHash,
  envelope: new Uint8Array([1, 2, 3]),
  expectedValidationFingerprint: "f".repeat(32),
  now: 1000,
};
const request = { ...entry, ...target };
const empty = { attempted: 0, accepted: 0, queued: 0, undeliverable: 0 };
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function coordinator(queue: TestDeliveryQueue, deliver: () => Promise<FederationDeliveryResult>) {
  return new FederationDeliveryCoordinator({
    queue,
    transport: { deliver },
    targetResolver: {
      async resolveTargets() {
        return [target];
      },
    },
  });
}

test("delivery commits admission before sending and acceptance before application status", async () => {
  const queue = new TestDeliveryQueue();
  const engine = new FederationDeliveryCoordinator({
    queue,
    targetResolver: {
      async resolveTargets() {
        assert.equal(queue.records.size, 1);
        return [target];
      },
    },
    transport: {
      async deliver(input) {
        assert.equal(queue.records.size, 1);
        assert.deepEqual(input.envelope, entry.envelope);
        assert.equal(input.expectedValidationFingerprint, entry.expectedValidationFingerprint);
        queue.events.push("send");
        return { status: "accepted" };
      },
    },
    deliveryStatusSink: {
      async setDeliveryStatus(input) {
        assert.equal(queue.records.size, 0);
        assert.deepEqual(input, {
          deliveryId: entry.deliveryId,
          status: "delivered",
          updatedAt: 1000,
        });
        queue.events.push("status");
      },
    },
  });
  assert.deepEqual(await engine.submit(request, entry), { status: "accepted" });
  assert.deepEqual(queue.events, ["enqueue", "send", "accepted", "status"]);
  queue.failEnqueue = true;
  await assert.rejects(engine.submit(request, entry), /enqueue failed/);
  assert.equal(queue.events.length, 4);
});

test("delivery failures retain durable work and application callback failures propagate", async () => {
  const queue = new TestDeliveryQueue();
  const failedTransport = coordinator(queue, async () => {
    throw new Error("send failed");
  });
  await assert.rejects(failedTransport.submit(request, entry), /send failed/);
  assert.equal(queue.records.size, 1);
  queue.failAccept = true;
  const engine = coordinator(queue, async () => ({ status: "accepted" }));
  await assert.rejects(engine.processDue({ now: 1000 }), /accept commit failed/);
  assert.equal(queue.records.size, 1);
  queue.failAccept = false;
  const failingSink = new FederationDeliveryCoordinator({
    queue,
    transport: {
      async deliver() {
        return { status: "accepted" };
      },
    },
    targetResolver: {
      async resolveTargets() {
        return [target];
      },
    },
    deliveryStatusSink: {
      async setDeliveryStatus() {
        throw new Error("status failed");
      },
    },
  });
  await assert.rejects(failingSink.processDue({ now: 1000 }), /status failed/);
  assert.equal(queue.records.size, 0); // Status is explicitly not atomic with queue acceptance.
});

test("queue identity binds hash, sealed bytes and fingerprint while legacy fingerprints remain optional", async () => {
  const normalized = normalizeFederationDeliveryInput(entry);
  normalized.envelope[0] = 99;
  assert.equal(entry.envelope[0], 1);
  const queue = new TestDeliveryQueue();
  const record = await queue.enqueue(entry);
  assertSameFederationDelivery(record, entry);
  for (const changed of [
    { ...entry, addressHash: "d".repeat(64) },
    { ...entry, envelope: new Uint8Array([9]) },
    { ...entry, expectedValidationFingerprint: undefined },
  ])
    assert.throws(() => assertSameFederationDelivery(record, changed), /identity conflict/);
  assert.equal(
    normalizeFederationDeliveryInput({ ...entry, expectedValidationFingerprint: undefined })
      .expectedValidationFingerprint,
    undefined,
  );
  for (const changed of [
    { ...entry, deliveryId: "short" },
    { ...entry, addressHash: "bad" },
    { ...entry, envelope: new Uint8Array() },
    { ...entry, expectedValidationFingerprint: "bad" },
  ])
    assert.throws(() => normalizeFederationDeliveryInput(changed), FederationError);
  assertFederationDeliveryPendingCapacity(999, 1255);
  for (const counts of [
    [1000, 1000],
    [999, 1256],
  ])
    assert.throws(() => assertFederationDeliveryPendingCapacity(...(counts as [number, number])), {
      code: "limit-exceeded",
    });
});

test("queue retry policy preserves exponential, peer and lookup delays with a finite ceiling", () => {
  assert.deepEqual(
    [1, 2, 3, 96].map((attempt) => nextFederationDeliveryAttemptAt(1000, attempt)),
    [16000, 31000, 61000, 61000],
  );
  assert.equal(nextFederationDeliveryAttemptAt(1000, 1, 120000), 61000);
  assert.equal(nextFederationDeliveryAttemptAt(1000, 3, 60000, 5000), 6000);
  assert.equal(nextFederationDeliveryAttemptAt(1000, 1, NaN), 16000);
  assert.equal(nextFederationDeliveryAttemptAt(1000, 1, 0, 0.1), 1001);
});

test("direct retry without peer delay keeps its initial attempt count and due time", async () => {
  for (const retryAfterMs of [undefined, 0, 30000]) {
    const queue = new TestDeliveryQueue();
    const engine = coordinator(queue, async () => ({ status: "retry", retryAfterMs }));
    assert.deepEqual(await engine.submit(request, entry), {
      status: "queued",
      deliveryId: entry.deliveryId,
    });
    const record = queue.records.get(entry.deliveryId)!;
    assert.equal(record.attempts, retryAfterMs ? 1 : 0);
    assert.equal(record.nextAttemptAt, retryAfterMs ? 31000 : 1000);
  }
});

test("unavailable lookup does not consume attempts; missing targets eventually become undeliverable", async () => {
  const queue = new TestDeliveryQueue();
  await queue.enqueue(entry);
  let resolution: FederationDeliveryTargetResolution = {
    status: "unavailable",
    retryDelayMs: 5000,
  };
  const engine = new FederationDeliveryCoordinator({
    queue,
    transport: {
      async deliver() {
        assert.fail("No endpoint is available");
      },
    },
    targetResolver: {
      async resolveTargets() {
        return resolution;
      },
    },
  });
  assert.deepEqual(await engine.processDue({ now: 1000 }), {
    ...empty,
    queued: 1,
    retryReasons: { "lookup-unavailable": 1 },
  });
  assert.equal(queue.records.get(entry.deliveryId)!.attempts, 0);
  assert.equal(queue.records.get(entry.deliveryId)!.nextAttemptAt, 6000);
  resolution = { status: "resolved", targets: [] };
  for (let attempt = 0; attempt < 96; attempt++)
    await engine.processDue({ now: 100000 + attempt * 60000 });
  assert.equal((await engine.listUndeliverable())[0].attempts, 96);
  assert.equal(queue.records.get(entry.deliveryId)!.nextAttemptAt, null);
});

test("fallbacks get independent envelope snapshots, earliest peer delay and no-attempt propagation", async () => {
  const queue = new TestDeliveryQueue();
  await queue.enqueue(entry);
  const seen: string[] = [];
  const engine = new FederationDeliveryCoordinator({
    queue,
    targetResolver: {
      async resolveTargets() {
        return [fallback, target, target];
      },
    },
    transport: {
      async deliver(input) {
        assert.deepEqual(input.envelope, entry.envelope);
        input.envelope.fill(0);
        seen.push(input.onionService);
        return seen.length === 1
          ? { status: "retry", retryAfterMs: 40000, retryReason: "busy" }
          : {
              status: "retry",
              retryAfterMs: 20000,
              retryReason: "unavailable",
              countAttempt: false,
            };
      },
    },
  });
  assert.deepEqual(await engine.processDue({ now: 1000 }), {
    ...empty,
    attempted: 2,
    queued: 1,
    retryReasons: { busy: 1, unavailable: 1 },
  });
  assert.deepEqual(seen, [target.onionService, fallback.onionService]);
  assert.equal(queue.records.get(entry.deliveryId)!.nextAttemptAt, 21000);
  assert.equal(queue.records.get(entry.deliveryId)!.attempts, 0);
  assert.deepEqual(queue.records.get(entry.deliveryId)!.envelope, entry.envelope);
});

test("equal priority targets are attempted once before ordered fallbacks", async () => {
  const queue = new TestDeliveryQueue();
  await queue.enqueue(entry);
  const equal = { ...fallback, priority: 0 };
  const last = { ...target, onionService: `http://${"d".repeat(56)}.onion`, priority: 2 };
  const seen: string[] = [];
  const engine = new FederationDeliveryCoordinator({
    queue,
    targetResolver: {
      async resolveTargets() {
        return [last, fallback, target, equal];
      },
    },
    transport: {
      async deliver(input) {
        seen.push(input.onionService);
        return { status: "retry" };
      },
    },
  });
  await engine.processDue({ now: 1000 });
  // Duplicate endpoint uses the first priority (fallback=1), preserving legacy normalization.
  assert.deepEqual(seen, [target.onionService, fallback.onionService, last.onionService]);
  seen.length = 0;
  await queue.wakePending(1000, 1);
  const equalEngine = new FederationDeliveryCoordinator({
    queue,
    targetResolver: {
      async resolveTargets() {
        return [last, target, equal];
      },
    },
    transport: {
      async deliver(input) {
        seen.push(input.onionService);
        return { status: "retry" };
      },
    },
  });
  await equalEngine.processDue({ now: 1000 });
  assert.deepEqual(new Set(seen.slice(0, 2)), new Set([target.onionService, equal.onionService]));
  assert.equal(seen[2], last.onionService);
});

test("delivery responses cannot persist recipient route relationships", async () => {
  for (const mode of ["direct", "retry", "accepted"] as const) {
    const queue = new TestDeliveryQueue();
    let updates = 0;
    const engine = new FederationDeliveryCoordinator({
      queue,
      targetResolver: {
        async resolveTargets() {
          return [target];
        },
      },
      transport: {
        async deliver() {
          return {
            status: mode === "retry" ? "retry" : "accepted",
            targetUpdate: { targets: [fallback] },
          };
        },
      },
      routingCache: {
        setLookupTargets(hash, targets) {
          assert.equal(hash, addressHash);
          assert.deepEqual(targets, [fallback]);
          updates++;
        },
      },
    });
    if (mode === "direct") await engine.submit(request, entry);
    else {
      await queue.enqueue(entry);
      await engine.processDue({ now: 1000 });
    }
    assert.equal(updates, 0);
  }
});

test("overlapping delivery calls coalesce and shutdown drains active custody before restart", async () => {
  const queue = new TestDeliveryQueue();
  await queue.enqueue(entry);
  await queue.enqueue({ ...entry, deliveryId: "synthetic_delivery_2" });
  const started = gate(),
    finish = gate();
  let attempts = 0;
  const engine = coordinator(queue, async () => {
    attempts++;
    started.release();
    await finish.promise;
    return { status: "accepted" };
  });
  const first = engine.processDue({ now: 1000 });
  await started.promise;
  assert.deepEqual(await engine.processDue({ now: 1000 }), empty);
  let stopped = false;
  const stop = engine.stopProcessing().then(() => {
    stopped = true;
  });
  await nextTurn();
  assert.equal(stopped, false);
  assert.throws(() => engine.resumeProcessing(), /still draining/);
  finish.release();
  await Promise.all([first, stop]);
  assert.equal(attempts, 1);
  assert.equal(queue.records.size, 1);
  assert.equal(await engine.wakePendingForStartup(), 0);
  assert.deepEqual(await engine.processDue(), empty);
  // A fresh coordinator resumes durable records with the same consumer provider.
  const restarted = coordinator(queue, async () => ({ status: "accepted" }));
  assert.equal(await restarted.wakePendingForStartup({ now: 500, limit: 1 }), 1);
  assert.equal((await restarted.processDue({ now: 500 })).accepted, 1);
  assert.equal(queue.records.size, 0);
});

test("deferred kicks report only a fixed event and isolate failing diagnostic handlers", async () => {
  const queue = new TestDeliveryQueue();
  await queue.enqueue(entry);
  const started = gate(),
    finish = gate(),
    reported = gate();
  const events: unknown[] = [];
  let calls = 0;
  const engine = new FederationDeliveryCoordinator({
    queue,
    targetResolver: {
      async resolveTargets() {
        return [target];
      },
    },
    transport: {
      async deliver() {
        calls++;
        if (calls === 1) {
          started.release();
          await finish.promise;
        }
        throw new Error(`sensitive ${addressHash} ${target.onionService}`);
      },
    },
    observer: {
      async onError(event) {
        events.push(event);
        reported.release();
        throw new Error("observer failed");
      },
    },
  });
  const first = engine.processDue({ now: 1000 });
  await started.promise;
  await engine.processDue();
  finish.release();
  await assert.rejects(first, /sensitive/);
  await nextTurn(); // Keep the test alive for the intentionally unrefed kick.
  await reported.promise;
  await engine.stopProcessing();
  assert.deepEqual(events, [{ operation: "deferred-kick" }]);
  assert.equal(queue.records.size, 1);
});

test("retry counters handle property names without inheriting object values", async () => {
  for (const reason of ["constructor", "__proto__", "toString", "invalid reason"]) {
    const queue = new TestDeliveryQueue();
    await queue.enqueue(entry);
    const engine = coordinator(queue, async () => ({ status: "retry", retryReason: reason }));
    const summary = await engine.processDue({ now: 1000 });
    const key = reason === "invalid reason" ? "retry" : reason;
    assert.equal(summary.retryReasons![key], 1);
    assert.equal(Object.getPrototypeOf(summary.retryReasons), Object.prototype);
    assert.deepEqual(Object.keys(summary.retryReasons!), [key]);
  }
});

test("worker wakes before processing, suppresses overlap and drains consumer work", async () => {
  const order: string[] = [];
  const started = gate(),
    finish = gate();
  let calls = 0;
  const worker = new FederationDeliveryWorker({
    batchLimit: 7,
    coordinator: {
      resumeProcessing() {
        order.push("resume");
      },
      async wakePendingForStartup(options) {
        assert.equal(options?.limit, 7);
        order.push("wake");
        return 1;
      },
      async processDue(options) {
        assert.equal(options?.limit, 7);
        order.push("process");
        calls++;
        started.release();
        await finish.promise;
        return { ...empty, accepted: 1 };
      },
      async stopProcessing() {
        order.push("stop");
      },
    },
    observer: {
      async onStartupWake(queued) {
        assert.equal(queued, 1);
        order.push("woken");
      },
      async onBatchProcessed(summary) {
        assert.equal(summary.accepted, 1);
        order.push("batch");
        throw new Error("observer failure");
      },
    },
  });
  worker.start();
  await started.promise;
  await worker.runOnce();
  assert.equal(calls, 1);
  let stopped = false;
  const stop = worker.stop().then(() => {
    stopped = true;
  });
  await nextTurn();
  assert.equal(stopped, false);
  finish.release();
  await stop;
  assert.deepEqual(order, ["resume", "wake", "woken", "process", "stop", "batch"]);
  await worker.runOnce();
  assert.equal(calls, 1);
});

test("startup errors do not expose exceptions and observer failures cannot reject shutdown", async () => {
  const reported = gate();
  const events: unknown[] = [];
  const worker = new FederationDeliveryWorker({
    coordinator: {
      async processDue() {
        throw new Error(addressHash);
      },
    },
    observer: {
      onError(event) {
        events.push(event);
        reported.release();
        throw new Error("observer failure");
      },
    },
  });
  worker.start();
  await reported.promise;
  await worker.stop();
  assert.deepEqual(events, [{ operation: "worker" }]);
});

test("worker observers receive an explicit aggregate whitelist from supplied coordinators", async () => {
  const events: unknown[] = [];
  const worker = new FederationDeliveryWorker({
    coordinator: {
      async processDue() {
        return {
          ...empty,
          accepted: 1,
          addressHash,
          onionService: target.onionService,
          deliveryId: entry.deliveryId,
          retryReasons: {},
        };
      },
    },
    observer: {
      onBatchProcessed(summary) {
        events.push(summary);
      },
    },
  });
  await worker.runOnce();
  await worker.stop();
  assert.deepEqual(events, [{ ...empty, accepted: 1 }]);
});
