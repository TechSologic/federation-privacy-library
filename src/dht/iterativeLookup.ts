// Adapted from UnoLock node; see NOTICE.md. SPDX-License-Identifier: AGPL-3.0-only
import {
  compareDhtDistance,
  dhtBucketSize,
  requireDhtId,
  type DhtContact,
} from "./routingTable.js";

export interface DhtQueryReply<T> {
  contacts: DhtContact[];
  value?: T;
}

export interface DhtWalkOptions<T> {
  target: string;
  seeds: DhtContact[];
  localId?: string;
  query(contact: DhtContact, target: string, signal: AbortSignal): Promise<DhtQueryReply<T>>;
  signal?: AbortSignal;
  k?: number;
  alpha?: number;
  maxQueries?: number;
  maxCandidates?: number;
  timeoutMs?: number;
  rpcTimeoutMs?: number;
}

export interface DhtWalkResult<T> {
  status: "found" | "converged" | "unavailable" | "budget" | "aborted";
  closest: DhtContact[];
  value?: T;
  queries: number;
  failures: number;
}

/** One iterative walk is used by both address reads and replica placement.
 * Only successful respondents are returned as storage destinations. RPC
 * adapters must honor abort signals to release sockets and global admission. */
export async function walkDht<T>(options: DhtWalkOptions<T>): Promise<DhtWalkResult<T>> {
  const target = requireDhtId(options.target);
  const k = limit(options.k ?? dhtBucketSize, 1, 64);
  const alpha = limit(options.alpha ?? 3, 1, 16);
  const maxQueries = limit(options.maxQueries ?? 128, k, 1024);
  const maxCandidates = limit(options.maxCandidates ?? 512, k, 4096);
  const timeoutMs = limit(options.timeoutMs ?? 30_000, 1, 120_000);
  const rpcTimeoutMs = limit(options.rpcTimeoutMs ?? 8_000, 1, timeoutMs);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    abort();
  }, timeoutMs);
  const candidates = new Map<string, DhtContact>();
  const queried = new Set<string>();
  const responded = new Map<string, DhtContact>();
  const failed = new Set<string>();
  type Completion = { contact: DhtContact; reply?: DhtQueryReply<T> };
  const pending = new Map<string, Promise<Completion>>();
  let queries = 0;
  let failures = 0;
  const order = (contacts: DhtContact[]): DhtContact[] =>
    contacts.sort((a, b) => compareDhtDistance(a.id, b.id, target));
  const add = (contacts: DhtContact[]): void => {
    const batch = contacts.slice(0, maxCandidates);
    // Validate a response atomically: a malformed tail must not leave earlier
    // attacker-supplied contacts in the candidate pool.
    for (const contact of batch) {
      requireDhtId(contact.id);
      if (
        typeof contact.endpoint !== "string" ||
        !contact.endpoint ||
        contact.endpoint.length > 128
      )
        throw new Error("Invalid DHT endpoint");
    }
    for (const contact of batch) {
      if (
        contact.id !== options.localId &&
        !failed.has(contact.id) &&
        !candidates.has(contact.id)
      ) {
        candidates.set(contact.id, { ...contact });
      }
    }
    if (candidates.size > maxCandidates) {
      const keep = new Set(
        order([...candidates.values()])
          .slice(0, maxCandidates)
          .map((contact) => contact.id),
      );
      for (const id of candidates.keys()) if (!keep.has(id)) candidates.delete(id);
    }
  };
  const result = (status: DhtWalkResult<T>["status"], value?: T): DhtWalkResult<T> => ({
    status,
    closest: order([...responded.values()]).slice(0, k),
    ...(value === undefined ? {} : { value }),
    queries,
    failures,
  });
  try {
    add(options.seeds);
    while (!controller.signal.aborted) {
      // A failed near contact is replaced by the next closest, so dead peers
      // cannot consume the shortlist permanently.
      const closest = order(
        [...candidates.values()].filter((contact) => !failed.has(contact.id)),
      ).slice(0, k);
      for (const contact of closest) {
        if (pending.size >= alpha || queries >= maxQueries) break;
        if (queried.has(contact.id)) continue;
        queried.add(contact.id);
        queries += 1;
        pending.set(
          contact.id,
          boundedQuery(options.query, contact, target, controller.signal, rpcTimeoutMs),
        );
      }
      if (pending.size === 0) {
        const exhausted = closest.every((contact) => queried.has(contact.id));
        return result(
          !exhausted
            ? "budget"
            : responded.size === 0 || failures > 0
              ? "unavailable"
              : "converged",
        );
      }
      const completion = await Promise.race(pending.values());
      pending.delete(completion.contact.id);
      if (controller.signal.aborted) break;
      if (!completion.reply) {
        failed.add(completion.contact.id);
        failures += 1;
        continue;
      }
      try {
        if (!Array.isArray(completion.reply.contacts) || completion.reply.contacts.length > 64)
          throw new Error("Invalid DHT contacts");
        add(completion.reply.contacts);
        responded.set(completion.contact.id, completion.contact);
        if (completion.reply.value !== undefined) return result("found", completion.reply.value);
      } catch {
        failed.add(completion.contact.id);
        failures += 1;
      }
    }
    return result(timedOut ? "budget" : "aborted");
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}

async function boundedQuery<T>(
  query: DhtWalkOptions<T>["query"],
  contact: DhtContact,
  target: string,
  parent: AbortSignal,
  timeoutMs: number,
): Promise<{ contact: DhtContact; reply?: DhtQueryReply<T> }> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  parent.addEventListener("abort", abort, { once: true });
  if (parent.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  let onAbort: () => void = () => {};
  const cancelled = new Promise<undefined>((resolve) => {
    onAbort = () => resolve(undefined);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
  });
  try {
    if (controller.signal.aborted) return { contact };
    // Catch transport failures, including late rejections after cancellation.
    const response = Promise.resolve()
      .then(() => query(contact, target, controller.signal))
      .catch(() => undefined);
    return { contact, reply: await Promise.race([response, cancelled]) };
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

function limit(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error("Invalid DHT walk limits");
  return value;
}
