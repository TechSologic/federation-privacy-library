import test from "node:test";
import assert from "node:assert/strict";
import { MemoryFederationStorage } from "../../src/adapters/memory.js";
import { State } from "../../src/state.js";
import { address } from "../helpers.js";
test("conditional batches are atomic, idempotent and do not reuse deleted revisions", async () => {
  const store = new MemoryFederationStorage();
  const fence = (await store.lease.claim("test-owner", Date.now() + 60_000))!;
  const state = new State(store, () => fence);
  const target = await address();
  const key = target.record.identity.addressHash;
  const changes = [
    { kind: "address" as const, key, expectedRevision: null, value: target.record },
    state.mutation("queue", "job", null, { accepted: true }),
  ];
  const first = await store.commit("stable-commit", changes, fence);
  assert.equal(first.outcome, "committed");
  assert.deepEqual(await store.commit("stable-commit", changes, fence), first);
  assert.deepEqual(
    await store.commit("stable-commit", [state.mutation("queue", "other", null, {})], fence),
    { outcome: "conflict" },
  );
  const revision = (await store.addresses.get(key))!.revision;
  assert.deepEqual(
    await store.commit(
      "conflict",
      [
        state.mutation("queue", "must-not-appear", null, {}),
        { kind: "address", key, expectedRevision: "stale", value: null },
      ],
      fence,
    ),
    { outcome: "conflict" },
  );
  assert.equal(await state.get("queue", "must-not-appear"), null);
  await store.commit(
    "delete",
    [{ kind: "address", key, expectedRevision: revision, value: null }],
    fence,
  );
  await store.commit(
    "recreate",
    [{ kind: "address", key, expectedRevision: null, value: target.record }],
    fence,
  );
  assert.notEqual((await store.addresses.get(key))!.revision, revision);
  const copy = await state.get<{ accepted: boolean }>("queue", "job");
  copy!.value.accepted = false;
  assert.equal((await state.get<{ accepted: boolean }>("queue", "job"))!.value.accepted, true);
});
test("pagination neither skips nor duplicates mixed-case state keys", async () => {
  const store = new MemoryFederationStorage();
  const fence = (await store.lease.claim("test-owner", Date.now() + 60_000))!;
  const state = new State(store, () => fence);
  const keys = ["z", "B", "a", "A", "_", "0"];
  for (const key of keys) await state.put("page", key, null, key, 5);
  const all: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.state.list({ collection: "page", limit: 2, cursor, dueBefore: 5 });
    all.push(...page.items.map((item) => item.value.key.key));
    cursor = page.cursor;
  } while (cursor);
  assert.deepEqual(all, [...keys].sort());
});

test("a newer lease fences every mutation from the previous runtime", async () => {
  const store = new MemoryFederationStorage();
  const first = (await store.lease.claim("first", Date.now() + 60_000))!;
  await store.lease.release(first);
  const second = (await store.lease.claim("second", Date.now() + 60_000))!;
  assert.ok(second.epoch > first.epoch);
  assert.deepEqual(
    await store.commit(
      "stale-write",
      [
        {
          kind: "state",
          key: { collection: "test", key: "stale" },
          expectedRevision: null,
          value: null,
        },
      ],
      first,
    ),
    { outcome: "fenced" },
  );
});
