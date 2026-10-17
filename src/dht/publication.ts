// Adapted from UnoLock node; see NOTICE.md. SPDX-License-Identifier: AGPL-3.0-only
import { walkDht, type DhtWalkOptions, type DhtWalkResult } from "./iterativeLookup.js";
import type { DhtContact } from "./routingTable.js";

export interface DhtPublicationResult {
  attempted: number;
  succeeded: number;
  complete: boolean;
  status: DhtWalkResult<never>["status"];
}

/** Placement and reads use the same walk. Only acknowledged storage counts;
 * full/conflicting/offline near stores fall back to farther live respondents. */
export async function publishDhtValue<T>(
  options: DhtWalkOptions<never> & {
    value: T;
    replicas?: number;
    put(peer: DhtContact, value: T, signal: AbortSignal): Promise<void>;
  },
): Promise<DhtPublicationResult> {
  const replicas = options.replicas ?? 8;
  if (!Number.isSafeInteger(replicas) || replicas < 1 || replicas > (options.k ?? 20))
    throw new Error("Invalid DHT replica count");
  const signal = AbortSignal.any([
    AbortSignal.timeout(45_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const placement = await walkDht({ ...options, signal });
  const alpha = options.alpha ?? 3;
  let attempted = 0;
  let succeeded = 0;
  for (
    let offset = 0;
    offset < placement.closest.length && succeeded < replicas && !signal.aborted;

  ) {
    const batch = placement.closest.slice(offset, offset + Math.min(alpha, replicas - succeeded));
    offset += batch.length;
    await Promise.all(
      batch.map(async (contact) => {
        attempted++;
        try {
          const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
          await options.put(contact, options.value, requestSignal);
          requestSignal.throwIfAborted();
          succeeded++;
        } catch {
          /* Conflicts and failures are never successful acknowledgements. */
        }
      }),
    );
  }
  return {
    attempted,
    succeeded,
    status: placement.status,
    complete:
      succeeded >= replicas ||
      (placement.status === "converged" && succeeded > 0 && succeeded === placement.closest.length),
  };
}
