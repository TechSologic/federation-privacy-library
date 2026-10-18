import type { FederationDeliveryProcessSummary } from "./coordinator.js";

/** Optional consumer diagnostics, never route/recipient identities or exception payloads.
 * Retry reasons must be locally classified tags, not arbitrary peer-supplied strings.
 * Observer failures are isolated from delivery state. Status sinks are separate.
 */
export interface FederationDeliveryObserver {
  onBatchProcessed?(summary: FederationDeliveryProcessSummary): void | Promise<void>;
  onStartupWake?(queued: number): void | Promise<void>;
  onError?(event: { operation: "deferred-kick" | "worker" }): void | Promise<void>;
}

export async function notifyDeliveryObserver(callback: () => void | Promise<void>): Promise<void> {
  try {
    await callback();
  } catch {
    /* Diagnostics cannot change delivery state. */
  }
}
