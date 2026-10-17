import test from "node:test";
import assert from "node:assert/strict";
import { walkDht } from "../../src/dht/iterativeLookup.js";
import { DhtRoutingTable } from "../../src/dht/routingTable.js";
test("DHT lookup follows returned peers and distinguishes unavailability from absence", async () => {
  const localId = "0".repeat(64),
    target = "f".repeat(64);
  const first = { id: "1".repeat(64), endpoint: "synthetic-first" };
  const second = { id: "e".repeat(64), endpoint: "synthetic-second" };
  const found = await walkDht({
    localId,
    target,
    seeds: [first],
    query: async (peer) =>
      peer.id === first.id ? { contacts: [second] } : { contacts: [], value: "value" },
  });
  assert.equal(found.status, "found");
  assert.equal(found.value, "value");
  const offline = await walkDht({
    localId,
    target,
    seeds: [first],
    query: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(offline.status, "unavailable");
  const absent = await walkDht({
    localId,
    target,
    seeds: [first],
    query: async () => ({ contacts: [] }),
  });
  assert.equal(absent.status, "converged");
});
test("routing table does not replace a responsive incumbent on one failed probe", () => {
  const table = new DhtRoutingTable("0".repeat(64), { bucketSize: 1 });
  const first = { id: "f".repeat(64), endpoint: "first" },
    second = { id: "e".repeat(64), endpoint: "second" };
  table.verified(first, 1000);
  const next = table.verified(second, 1001);
  assert.equal(next.admitted, false);
  assert.equal(next.probe?.id, first.id);
  table.verified(first, 1002);
  table.failed(first.id, 1000, 1003);
  assert.equal(table.closest(first.id, 1, 1003)[0].id, first.id);
});
