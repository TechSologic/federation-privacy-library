import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  FederationStorage,
  LocalAddress,
  Stored,
  StateRecord,
  StateKey,
  StorageFence,
  StorageMutation,
  StorageCommit,
  PageRequest,
  Page,
} from "../contracts.js";
import { fail, integer } from "../errors.js";
function keyOf(key: StateKey) {
  return JSON.stringify([key.collection, key.key]);
}
function page<T>(entries: [string, T][], query: PageRequest): Page<T> {
  integer(query.limit, 1, 256);
  const selected = entries
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .filter(([k]) => query.cursor === undefined || k > query.cursor)
    .slice(0, query.limit + 1);
  return {
    items: selected.slice(0, query.limit).map(([, v]) => structuredClone(v)),
    ...(selected.length > query.limit ? { cursor: selected[query.limit - 1][0] } : {}),
  };
}
/** Reference/test adapter. It retains state across library restarts, not process exits. */
export class MemoryFederationStorage implements FederationStorage {
  private addressRecords = new Map<string, Stored<LocalAddress>>();
  private stateRecords = new Map<string, Stored<StateRecord>>();
  private commits = new Map<
    string,
    { changes: readonly StorageMutation[]; result: StorageCommit }
  >();
  private currentLease?: { fence: StorageFence; expiresAt: number };
  private nextEpoch = 0;
  readonly lease = {
    claim: async (owner: string, expiresAt: number): Promise<StorageFence | null> => {
      if (!owner || owner.length > 256) fail("invalid-data", "Invalid lease owner");
      integer(expiresAt, Date.now() + 1);
      if (this.currentLease && this.currentLease.expiresAt > Date.now()) return null;
      const fence = { owner, epoch: ++this.nextEpoch };
      this.currentLease = { fence, expiresAt };
      return structuredClone(fence);
    },
    renew: async (fence: StorageFence, expiresAt: number): Promise<boolean> => {
      integer(expiresAt, Date.now() + 1);
      if (!this.fenceIsCurrent(fence)) return false;
      this.currentLease!.expiresAt = expiresAt;
      return true;
    },
    release: async (fence: StorageFence): Promise<void> => {
      if (this.fenceIsCurrent(fence)) this.currentLease = undefined;
    },
  };
  readonly addresses = {
    get: async (key: string) => structuredClone(this.addressRecords.get(key) ?? null),
    list: async (query: PageRequest & { enabled?: boolean }) =>
      page(
        [...this.addressRecords].filter(
          ([, v]) => query.enabled === undefined || v.value.enabled === query.enabled,
        ),
        query,
      ),
  };
  readonly state = {
    get: async (key: StateKey) => structuredClone(this.stateRecords.get(keyOf(key)) ?? null),
    list: async (query: PageRequest & { collection: string; dueBefore?: number }) =>
      page(
        [...this.stateRecords].filter(
          ([, v]) =>
            v.value.key.collection === query.collection &&
            (query.dueBefore === undefined ||
              (v.value.dueAt !== undefined && v.value.dueAt <= query.dueBefore)),
        ),
        query,
      ),
  };
  private fenceIsCurrent(fence: StorageFence): boolean {
    return (
      this.currentLease !== undefined &&
      this.currentLease.expiresAt > Date.now() &&
      this.currentLease.fence.owner === fence.owner &&
      this.currentLease.fence.epoch === fence.epoch
    );
  }
  async commit(
    commitId: string,
    changes: readonly StorageMutation[],
    fence: StorageFence,
  ): Promise<StorageCommit> {
    changes = structuredClone(changes);
    if (!commitId || commitId.length > 256) fail("invalid-data", "Invalid commit identity");
    integer(changes.length, 1, 100);
    if (!this.fenceIsCurrent(fence)) return { outcome: "fenced" };
    const old = this.commits.get(commitId);
    if (old) {
      if (!isDeepStrictEqual(old.changes, changes)) return { outcome: "conflict" };
      return structuredClone(old.result);
    }
    const keys = new Set<string>();
    for (const mutation of changes) {
      const key = mutation.kind === "address" ? mutation.key : keyOf(mutation.key);
      const unique = mutation.kind + key;
      if (keys.has(unique)) fail("invalid-data", "Duplicate batch key");
      keys.add(unique);
      const record =
        mutation.kind === "address" ? this.addressRecords.get(key) : this.stateRecords.get(key);
      if ((record?.revision ?? null) !== mutation.expectedRevision) {
        const result: StorageCommit = { outcome: "conflict" };
        this.commits.set(commitId, { changes: structuredClone(changes), result });
        return result;
      }
      if (
        mutation.value &&
        (mutation.kind === "address"
          ? mutation.value.identity.addressHash !== mutation.key
          : !isDeepStrictEqual(mutation.value.key, mutation.key))
      )
        fail("invalid-data", "Storage key mismatch");
    }
    const revisions = changes.map((mutation) => {
      const revision = mutation.value === null ? null : randomUUID();
      if (mutation.kind === "address") {
        if (mutation.value === null) this.addressRecords.delete(mutation.key);
        else
          this.addressRecords.set(mutation.key, {
            revision: revision!,
            value: structuredClone(mutation.value),
          });
      } else {
        if (mutation.value === null) this.stateRecords.delete(keyOf(mutation.key));
        else
          this.stateRecords.set(keyOf(mutation.key), {
            revision: revision!,
            value: structuredClone(mutation.value),
          });
      }
      return revision;
    });
    const result: StorageCommit = { outcome: "committed", revisions };
    this.commits.set(commitId, {
      changes: structuredClone(changes),
      result: structuredClone(result),
    });
    return result;
  }
}
