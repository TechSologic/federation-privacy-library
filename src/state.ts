import { randomUUID } from "node:crypto";
import type {
  FederationStorage,
  StateRecord,
  StorageFence,
  Stored,
  StorageMutation,
} from "./contracts.js";
import { fail } from "./errors.js";

export class State {
  constructor(
    readonly storage: FederationStorage,
    private readonly activeFence: () => StorageFence,
  ) {}
  async get<T>(collection: string, key: string): Promise<Stored<T> | null> {
    const record = await this.storage.state.get({ collection, key });
    return record ? { revision: record.revision, value: this.decode<T>(record.value) } : null;
  }
  decode<T>(record: StateRecord): T {
    try {
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(record.bytes));
      if (parsed.version !== 1) fail("storage", "Unsupported federation state version");
      return parsed.value as T;
    } catch {
      fail("storage", "Invalid persisted federation state");
    }
  }
  mutation(
    collection: string,
    key: string,
    expectedRevision: string | null,
    value: unknown,
    dueAt?: number,
  ): StorageMutation {
    return {
      kind: "state",
      key: { collection, key },
      expectedRevision,
      value:
        value === null
          ? null
          : {
              key: { collection, key },
              bytes: Buffer.from(JSON.stringify({ version: 1, value })),
              dueAt,
            },
    };
  }
  async put(
    collection: string,
    key: string,
    expectedRevision: string | null,
    value: unknown,
    dueAt?: number,
  ): Promise<string | null> {
    const result = await this.commit([
      this.mutation(collection, key, expectedRevision, value, dueAt),
    ]);
    if (result.outcome === "fenced") fail("storage", "Runtime storage ownership changed");
    return result.outcome === "committed" ? result.revisions[0] : null;
  }
  async commit(changes: readonly StorageMutation[]) {
    return this.storage.commit(randomUUID(), changes, this.activeFence());
  }
  async *scan<T>(
    collection: string,
    dueBefore?: number,
  ): AsyncGenerator<{ key: string; value: T; revision: string }> {
    let cursor: string | undefined;
    do {
      const page = await this.storage.state.list({ collection, limit: 128, cursor, dueBefore });
      for (const item of page.items)
        yield {
          key: item.value.key.key,
          value: this.decode<T>(item.value),
          revision: item.revision,
        };
      cursor = page.cursor;
    } while (cursor);
  }
}
