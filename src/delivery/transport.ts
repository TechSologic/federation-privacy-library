import type { ReceiveLookupTarget } from "../protocol/lookupRecords.js";

export interface FederationDeliveryRequest {
  expectedValidationFingerprint?: string;
  /** For messages.submit these fields are syntax-checked compatibility inputs;
   * verified resolution selects the actual endpoint. Transport.deliver receives
   * only the resolved, pinned endpoint from the library.
   */
  onionService: string;
  deliveryPath: string;
  addressHash: string;
  envelope: Uint8Array;
}

/** Only locally verified routing updates, never raw peer custody metadata. */
export interface FederationDeliveryTargetUpdate {
  targets: ReceiveLookupTarget[];
}

export type FederationDeliveryResult =
  | {
      readonly status: "accepted";
      readonly acceptedAt?: number;
      readonly targetUpdate?: FederationDeliveryTargetUpdate;
    }
  | {
      readonly status: "retry";
      readonly countAttempt?: boolean;
      readonly retryAfterMs?: number;
      readonly retryReason?: string;
      readonly targetUpdate?: FederationDeliveryTargetUpdate;
    };

/** Consumer transport must enforce Tor, finite I/O budgets, and custody validation.
 * Accepted means durable endpoint custody, not recipient authority or final inbox delivery.
 */
export interface FederationTransport {
  deliver(request: FederationDeliveryRequest): Promise<FederationDeliveryResult>;
}
