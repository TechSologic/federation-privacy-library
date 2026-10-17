// Adapted from UnoLock node; see NOTICE.md. SPDX-License-Identifier: AGPL-3.0-only
/** Transport-independent Kademlia routing state. Only outbound-verified contacts
 * belong here. Wire identities must be derived from their onion by the adapter. */
export interface DhtContact {
  id: string;
  endpoint: string;
}

export interface DhtRoutingEntry {
  contact: DhtContact;
  seenAt: number;
  failures: number;
  lastFailureAt?: number;
}

export interface DhtBucketSnapshot {
  contacts: DhtRoutingEntry[];
  replacements: DhtRoutingEntry[];
}

export const dhtBucketSize = 20;
const idPattern = /^[a-f0-9]{64}$/;

export function requireDhtId(id: string): string {
  if (typeof id !== "string" || !idPattern.test(id)) throw new Error("Invalid DHT id");
  return id;
}

/** Zero is the furthest bucket; 255 differs only in the final bit. */
export function dhtBucketIndex(localId: string, remoteId: string): number {
  requireDhtId(localId);
  requireDhtId(remoteId);
  for (let i = 0; i < 64; i += 1) {
    const difference = parseInt(localId[i], 16) ^ parseInt(remoteId[i], 16);
    if (difference) return i * 4 + Math.clz32(difference) - 28;
  }
  return -1;
}

export function compareDhtDistance(a: string, b: string, target: string): number {
  for (let i = 0; i < 64; i += 1) {
    if (a[i] === b[i]) continue;
    const digit = parseInt(target[i], 16);
    const difference = (parseInt(a[i], 16) ^ digit) - (parseInt(b[i], 16) ^ digit);
    if (difference) return difference;
  }
  return 0;
}

/** Produce an independent refresh lookup inside one distance bucket. Entropy
 * comes from a CSPRNG in production; simulations can supply deterministic IDs. */
export function dhtRefreshTarget(localId: string, bucket: number, entropy: string): string {
  requireDhtId(localId);
  requireDhtId(entropy);
  if (!Number.isSafeInteger(bucket) || bucket < 0 || bucket > 255)
    throw new Error("Invalid DHT bucket");
  const nibble = Math.floor(bucket / 4);
  const bit = 3 - (bucket % 4);
  const prefixMask = (15 << (bit + 1)) & 15;
  const digit = (
    (parseInt(localId[nibble], 16) & prefixMask) |
    ((parseInt(localId[nibble], 16) ^ (1 << bit)) & (1 << bit)) |
    (parseInt(entropy[nibble], 16) & ((1 << bit) - 1))
  ).toString(16);
  return localId.slice(0, nibble) + digit + entropy.slice(nibble + 1);
}

export class DhtRoutingTable {
  private readonly buckets = new Map<number, Map<string, DhtRoutingEntry>>();
  private readonly replacements = new Map<number, Map<string, DhtRoutingEntry>>();
  readonly localId: string;
  readonly bucketSize: number;
  readonly retentionMs: number;

  constructor(localId: string, options: { bucketSize?: number; retentionMs?: number } = {}) {
    this.localId = requireDhtId(localId);
    this.bucketSize = options.bucketSize ?? dhtBucketSize;
    this.retentionMs = options.retentionMs ?? 30 * 60_000;
    if (
      !Number.isSafeInteger(this.bucketSize) ||
      this.bucketSize < 1 ||
      this.bucketSize > 64 ||
      !Number.isSafeInteger(this.retentionMs) ||
      this.retentionMs < 1
    )
      throw new Error("Invalid DHT routing limits");
  }

  /** A full bucket retains live incumbents. Caller may probe the returned oldest
   * contact and call failed() on a real outbound failure. Announcements alone
   * must never evict an incumbent or refresh its liveness. */
  verified(contact: DhtContact, now = Date.now()): { admitted: boolean; probe?: DhtContact } {
    requireDhtId(contact.id);
    if (typeof contact.endpoint !== "string" || !contact.endpoint || contact.endpoint.length > 128)
      throw new Error("Invalid DHT endpoint");
    const index = dhtBucketIndex(this.localId, contact.id);
    if (index < 0) return { admitted: false };
    this.pruneBucket(index, now);
    const bucket = this.buckets.get(index) ?? new Map<string, DhtRoutingEntry>();
    this.buckets.set(index, bucket);
    const entry = { contact: { ...contact }, seenAt: now, failures: 0 };
    if (bucket.has(contact.id) || bucket.size < this.bucketSize) {
      bucket.delete(contact.id);
      bucket.set(contact.id, entry);
      this.replacements.get(index)?.delete(contact.id);
      return { admitted: true };
    }
    const spare = this.replacements.get(index) ?? new Map<string, DhtRoutingEntry>();
    this.replacements.set(index, spare);
    spare.delete(contact.id);
    spare.set(contact.id, entry);
    if (spare.size > this.bucketSize) spare.delete(spare.keys().next().value!);
    return { admitted: false, probe: { ...bucket.values().next().value!.contact } };
  }

  /** Ignore failures of probes started before the latest successful contact. */
  failed(id: string, probeStartedAt: number, now = Date.now()): void {
    const index = dhtBucketIndex(this.localId, id);
    const bucket = this.buckets.get(index);
    const entry = bucket?.get(id);
    // Equality is conservative: a successful verification and an older probe
    // can share the same clock millisecond.
    if (!entry || entry.seenAt >= probeStartedAt || (entry.lastFailureAt ?? -1) >= probeStartedAt)
      return;
    entry.lastFailureAt = probeStartedAt;
    entry.failures += 1;
    if (entry.failures < 2) return;
    bucket!.delete(id);
    this.pruneBucket(index, now);
  }

  closest(target: string, limit = this.bucketSize, now = Date.now()): DhtContact[] {
    requireDhtId(target);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256 * this.bucketSize)
      throw new Error("Invalid DHT result limit");
    // This bucket shares the target's first bit that differs from our ID.
    // Every contact in it is closer to the target than every contact outside
    // it. A full bucket therefore answers ordinary k-nearest requests without
    // allocating and sorting the entire routing table for every inbound RPC.
    const index = dhtBucketIndex(this.localId, target);
    if (index >= 0) {
      this.pruneBucket(index, now);
      const bucket = this.buckets.get(index);
      if (bucket && bucket.size >= limit)
        return [...bucket.values()]
          .sort((a, b) => compareDhtDistance(a.contact.id, b.contact.id, target))
          .slice(0, limit)
          .map((entry) => ({ ...entry.contact }));
    }
    // Different buckets have disjoint fixed prefixes. For buckets a < b,
    // their first differing distance bit is a: bucket a is nearer iff the
    // target differs from our local ID at that bit. Consequently differing-bit
    // buckets come first in ascending order, then matching-bit buckets in
    // descending order. Every member of one bucket precedes every member of
    // the next; sparse/self-target lookups need not sort the entire table.
    const toward: number[] = [];
    const away: number[] = [];
    for (const index of [...this.buckets.keys()].sort((a, b) => a - b)) {
      const nibble = Math.floor(index / 4);
      const different =
        (parseInt(this.localId[nibble], 16) ^ parseInt(target[nibble], 16)) &
        (1 << (3 - (index % 4)));
      (different ? toward : away).push(index);
    }
    const answer: DhtContact[] = [];
    for (const index of [...toward, ...away.reverse()]) {
      this.pruneBucket(index, now);
      const entries = [...(this.buckets.get(index)?.values() ?? [])].sort((a, b) =>
        compareDhtDistance(a.contact.id, b.contact.id, target),
      );
      for (const entry of entries.slice(0, limit - answer.length))
        answer.push({ ...entry.contact });
      if (answer.length >= limit) break;
    }
    return answer;
  }

  /** Maintenance visits oldest contacts rather than repeatedly sampling seeds. */
  oldest(limit = this.bucketSize, now = Date.now()): DhtContact[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256 * this.bucketSize)
      throw new Error("Invalid DHT result limit");
    return this.entries(now)
      .sort((a, b) => a.seenAt - b.seenAt)
      .slice(0, limit)
      .map((entry) => ({ ...entry.contact }));
  }

  get size(): number {
    return [...this.buckets.values()].reduce((total, bucket) => total + bucket.size, 0);
  }

  snapshot(index: number, now = Date.now()): DhtBucketSnapshot {
    requireBucket(index);
    this.pruneBucket(index, now);
    const clone = (entry: DhtRoutingEntry): DhtRoutingEntry => ({
      ...entry,
      contact: { ...entry.contact },
    });
    return {
      contacts: [...(this.buckets.get(index)?.values() ?? [])].map(clone),
      replacements: [...(this.replacements.get(index)?.values() ?? [])].map(clone),
    };
  }

  snapshots(now = Date.now()): Array<{ index: number; snapshot: DhtBucketSnapshot }> {
    return [...this.buckets.keys()]
      .map((index) => ({ index, snapshot: this.snapshot(index, now) }))
      .filter(({ snapshot }) => snapshot.contacts.length + snapshot.replacements.length > 0);
  }

  /** Restore only trusted persistence, never a remote announcement. The adapter
   * additionally verifies that each identity is derived from its endpoint. */
  restoreBucket(index: number, snapshot: DhtBucketSnapshot, now = Date.now()): void {
    requireBucket(index);
    if (
      !snapshot ||
      !Array.isArray(snapshot.contacts) ||
      !Array.isArray(snapshot.replacements) ||
      snapshot.contacts.length > this.bucketSize ||
      snapshot.replacements.length > this.bucketSize
    )
      throw new Error("Invalid DHT bucket snapshot");
    const ids = new Set<string>();
    const checked = (entries: DhtRoutingEntry[]): Map<string, DhtRoutingEntry> =>
      new Map(
        entries.map((entry) => {
          if (
            !entry?.contact ||
            !Number.isSafeInteger(entry.seenAt) ||
            entry.seenAt < 0 ||
            !Number.isSafeInteger(entry.failures) ||
            entry.failures < 0 ||
            entry.failures > 1 ||
            (entry.lastFailureAt !== undefined &&
              (!Number.isSafeInteger(entry.lastFailureAt) || entry.lastFailureAt < 0)) ||
            typeof entry.contact.endpoint !== "string" ||
            !entry.contact.endpoint ||
            entry.contact.endpoint.length > 128 ||
            dhtBucketIndex(this.localId, entry.contact.id) !== index ||
            ids.has(entry.contact.id)
          ) {
            throw new Error("Invalid DHT bucket entry");
          }
          ids.add(entry.contact.id);
          return [entry.contact.id, { ...entry, contact: { ...entry.contact } }];
        }),
      );
    // Validate the entire snapshot before changing either collection.
    const contacts = checked(snapshot.contacts);
    const replacements = checked(snapshot.replacements);
    this.buckets.set(index, contacts);
    this.replacements.set(index, replacements);
    this.pruneBucket(index, now);
  }

  private entries(now: number): DhtRoutingEntry[] {
    for (const index of this.buckets.keys()) this.pruneBucket(index, now);
    return [...this.buckets.values()].flatMap((bucket) => [...bucket.values()]);
  }

  private pruneBucket(index: number, now: number): void {
    const bucket = this.buckets.get(index);
    const spare = this.replacements.get(index);
    for (const collection of [bucket, spare]) {
      for (const [id, entry] of collection ?? []) {
        if (entry.seenAt + this.retentionMs <= now) collection!.delete(id);
      }
    }
    if (!bucket || !spare) return;
    // Prefer the most recently verified replacement; no unverified contact can
    // be promoted by expiry or failure processing.
    for (const [id, entry] of [...spare].reverse()) {
      if (bucket.size >= this.bucketSize) break;
      bucket.set(id, entry);
      spare.delete(id);
    }
  }
}

function requireBucket(index: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index > 255)
    throw new Error("Invalid DHT bucket");
}
