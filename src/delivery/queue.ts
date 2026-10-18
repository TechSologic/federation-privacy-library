import { messageMaxBytes as federationDeliveryEnvelopeMaxBytes } from "../protocol/messages.js";
import { randomUUID } from "node:crypto";
import { FederationError } from "../errors.js";
import { normalizeSha256HexAddressHash } from "../protocol/lookupRecords.js";

export type FederationDeliveryQueueStatus = "pending" | "undeliverable";

export interface FederationQueuedDeliveryRecord {
  expectedValidationFingerprint?: string;
  deliveryId: string;
  addressHash: string;
  envelope: Uint8Array;
  status: FederationDeliveryQueueStatus;
  attempts: number;
  nextAttemptAt: number | null;
  createdAt: number;
  updatedAt: number;
  lastFailureAt?: number;
}

/** Host-owned durable queue. One live coordinator owns each adapter instance.
 * A simple backing queue requires exclusive ownership. Distributed providers
 * must claim nominated work, isolate receipts, and condition completion on the
 * exact original snapshot so cancelled/replaced work cannot be acknowledged.
 * Processing may repeat after uncertain outcomes; preserve exact identities.
 * Production implementations encrypt envelopes and every identifying index at rest.
 * Enqueue atomically validates identity and capacity, commits before resolving,
 * and is idempotent for the exact delivery id/hash/envelope/fingerprint tuple.
 * Reads and writes return isolated snapshots. Acceptance and retry mutations
 * commit before resolving; failures must reject, never acknowledge lost work.
 * See docs/using-library/runtime.md for restart, ownership, and status-handler limitations.
 */
export interface FederationDeliveryQueue {
  enqueue(input: {
    expectedValidationFingerprint?: string;
    deliveryId?: string;
    addressHash: string;
    envelope: Uint8Array;
    now?: number;
  }): Promise<FederationQueuedDeliveryRecord>;

  listDue(now: number, limit: number): Promise<FederationQueuedDeliveryRecord[]>;

  wakePending(now: number, limit: number): Promise<number>;

  listUndeliverable(limit: number): Promise<FederationQueuedDeliveryRecord[]>;

  markAccepted(input: { deliveryId: string }): Promise<void>;

  markRetry(input: {
    deliveryId: string;
    now?: number;
    retryAfterMs?: number;
    retryDelayMs?: number;
    retryReason?: string;
    countAttempt?: boolean;
  }): Promise<FederationQueuedDeliveryRecord>;
}

export { messageMaxBytes as federationDeliveryEnvelopeMaxBytes } from "../protocol/messages.js";
export const federationDeliveryRetryBaseMs = 15_000;
export const federationDeliveryRetryMaxMs = 60_000;
export const federationDeliveryMaxAttempts = 96;
export const federationDeliveryPendingMax = 1_000;
export const federationDeliveryUndeliverableWarn = 1;
export const federationDeliveryUndeliverableMax = 256;
export const federationDeliveryRetainedMax =
  federationDeliveryPendingMax + federationDeliveryUndeliverableMax;

const deliveryIdPattern = /^[A-Za-z0-9_-]{16,128}$/;

export function createFederationDeliveryId(): string {
  return randomUUID();
}

export function normalizeFederationDeliveryId(value: unknown): string {
  if (typeof value !== "string") {
    throw new FederationError("invalid-data", "Federation delivery id is invalid");
  }
  const trimmed = value.trim();
  if (!deliveryIdPattern.test(trimmed)) {
    throw new FederationError("invalid-data", "Federation delivery id is invalid");
  }
  return trimmed;
}

export function validateFederationDeliveryEnvelope(value: Uint8Array): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength === 0 ||
    value.byteLength > federationDeliveryEnvelopeMaxBytes
  ) {
    throw new FederationError("invalid-data", "Federation delivery envelope size is invalid");
  }
  return new Uint8Array(value);
}

export function normalizeFederationDeliveryInput(input: {
  expectedValidationFingerprint?: string;
  deliveryId?: string;
  addressHash: string;
  envelope: Uint8Array;
}): {
  expectedValidationFingerprint?: string;
  deliveryId: string;
  addressHash: string;
  envelope: Uint8Array;
} {
  return {
    expectedValidationFingerprint: normalizeFederationValidationFingerprint(
      input.expectedValidationFingerprint,
    ),
    deliveryId: input.deliveryId
      ? normalizeFederationDeliveryId(input.deliveryId)
      : createFederationDeliveryId(),
    addressHash: normalizeSha256HexAddressHash(input.addressHash),
    envelope: validateFederationDeliveryEnvelope(input.envelope),
  };
}

export function normalizeFederationValidationFingerprint(value: unknown): string | undefined {
  if (value === undefined) return undefined; // Old durable entries wait for client upgrade.
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(value)) {
    throw new FederationError("invalid-data", "Invalid recipient validation commitment");
  }
  return value;
}

export function assertSameFederationDelivery(
  existing: FederationQueuedDeliveryRecord,
  input: {
    addressHash: string;
    envelope: Uint8Array;
    expectedValidationFingerprint?: string;
  },
): void {
  if (
    existing.addressHash !== input.addressHash ||
    existing.expectedValidationFingerprint !== input.expectedValidationFingerprint ||
    !Buffer.from(existing.envelope).equals(Buffer.from(input.envelope))
  ) {
    throw new FederationError("invalid-data", "Federation delivery identity conflict");
  }
}

export function normalizeFederationDeliveryLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0 || limit > 256) {
    throw new Error("Federation delivery queue limit is invalid");
  }
  return limit;
}

export function assertFederationDeliveryPendingCapacity(count: number, retained = count): void {
  if (!Number.isInteger(count) || count < 0) {
    throw new FederationError(
      "invalid-data",
      "Federation outbound delivery queue count is invalid",
    );
  }
  if (count >= federationDeliveryPendingMax || retained >= federationDeliveryRetainedMax) {
    throw new FederationError("limit-exceeded", "Federation outbound delivery queue is full");
  }
}

export function nextFederationDeliveryAttemptAt(
  now: number,
  attempts: number,
  retryAfterMs?: number,
  retryDelayMs?: number,
): number {
  if (typeof retryDelayMs === "number" && Number.isFinite(retryDelayMs) && retryDelayMs > 0) {
    return now + Math.min(federationDeliveryRetryMaxMs, Math.ceil(retryDelayMs));
  }
  const exponent = Math.max(0, Math.min(attempts - 1, federationDeliveryMaxAttempts));
  const exponentialDelay = Math.min(
    federationDeliveryRetryMaxMs,
    federationDeliveryRetryBaseMs * 2 ** exponent,
  );
  const peerDelay =
    typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? Math.min(federationDeliveryRetryMaxMs, Math.ceil(retryAfterMs))
      : 0;
  return now + Math.max(exponentialDelay, peerDelay);
}
