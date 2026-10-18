import test from "node:test";
import assert from "node:assert/strict";
import { DhtMaintenance, DhtRoutingTable, dhtRefreshTarget } from "../../src/dht/index.js";

const localId = "0".repeat(64);
const far = { id: dhtRefreshTarget(localId, 0, "1".repeat(64)), endpoint: "synthetic-far" };
const near = { id: dhtRefreshTarget(localId, 200, "2".repeat(64)), endpoint: "synthetic-near" };

test("maintenance rediscovers a growing neighborhood with bounded work", async () => {
  const table = new DhtRoutingTable(localId);
  let grown = false;
  let calls = 0;
  const maintenance = new DhtMaintenance({
    localId,
    seeds: async () => [far],
    closest: async (key) => table.closest(key),
    oldest: async (limit) => table.oldest(limit),
    candidates: async () => [],
    ping: async () => {
      calls++;
    },
    findNode: async (_peer, key) => {
      calls++;
      return grown && key === localId ? [far, near] : [far];
    },
    verified: async (peer) => {
      table.verified(peer);
    },
    failed: async () => {
      assert.fail("Healthy peers must not fail");
    },
    shouldRecordFailure: () => true,
    randomId: () => "3".repeat(64),
  });
  assert.equal((await maintenance.run()).joined, true);
  assert.deepEqual(table.closest(localId), [far]);
  grown = true;
  for (let round = 0; round < 3; round++) {
    calls = 0;
    await maintenance.run();
    assert.ok(calls <= 40);
  }
  assert.deepEqual(table.closest(localId)[0], near);
});

test("maintenance coalesces rounds and does not classify persistence failure as peer failure", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let failures = 0;
  const maintenance = new DhtMaintenance({
    localId,
    seeds: async () => [far],
    closest: async () => [],
    oldest: async () => [],
    candidates: async () => [],
    ping: async () => {
      await gate;
    },
    findNode: async () => [],
    verified: async () => {
      throw new Error("synthetic storage failure");
    },
    failed: async () => {
      failures++;
    },
    shouldRecordFailure: () => true,
    randomId: () => "3".repeat(64),
  });
  const first = maintenance.run();
  assert.equal(maintenance.run(), first);
  release();
  const summary = await first;
  assert.equal(summary.joined, false);
  assert.equal(summary.promotedCount, 0);
  assert.equal(failures, 0);
  const aborted = new AbortController();
  aborted.abort();
  assert.equal((await maintenance.run(aborted.signal)).probeCount, 0);
});
