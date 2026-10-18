import {
  assertSameFederationDelivery,
  assertFederationDeliveryPendingCapacity,
  federationDeliveryMaxAttempts,
  nextFederationDeliveryAttemptAt,
  normalizeFederationDeliveryInput,
  normalizeFederationDeliveryLimit,
  type FederationDeliveryQueue,
  type FederationQueuedDeliveryRecord,
} from "../src/delivery/index.js";

/** Test-only consumer adapter. Production persistence remains application-owned. */
export class TestDeliveryQueue implements FederationDeliveryQueue {
  readonly records = new Map<string, FederationQueuedDeliveryRecord>();
  readonly events: string[] = [];
  failEnqueue = false;
  failAccept = false;

  async enqueue(input: Parameters<FederationDeliveryQueue["enqueue"]>[0]) {
    if (this.failEnqueue) throw new Error("enqueue failed");
    const normalized = normalizeFederationDeliveryInput(input);
    const existing = this.records.get(normalized.deliveryId);
    if (existing) {
      assertSameFederationDelivery(existing, normalized);
      return structuredClone(existing);
    }
    assertFederationDeliveryPendingCapacity(
      [...this.records.values()].filter((record) => record.status === "pending").length,
      this.records.size,
    );
    const now = input.now ?? Date.now();
    const record: FederationQueuedDeliveryRecord = {
      ...normalized,
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.deliveryId, record);
    this.events.push("enqueue");
    return structuredClone(record);
  }

  async listDue(now: number, limit: number) {
    return [...this.records.values()]
      .filter(
        (record) =>
          record.status === "pending" &&
          record.nextAttemptAt !== null &&
          record.nextAttemptAt <= now,
      )
      .sort((a, b) => a.nextAttemptAt! - b.nextAttemptAt! || a.createdAt - b.createdAt)
      .slice(0, normalizeFederationDeliveryLimit(limit))
      .map((record) => structuredClone(record));
  }

  async wakePending(now: number, limit: number) {
    const pending = [...this.records.values()]
      .filter((record) => record.status === "pending")
      .sort(
        (a, b) =>
          (a.nextAttemptAt ?? Infinity) - (b.nextAttemptAt ?? Infinity) ||
          a.createdAt - b.createdAt,
      )
      .slice(0, normalizeFederationDeliveryLimit(limit));
    for (const record of pending) {
      record.nextAttemptAt = now;
      record.updatedAt = now;
    }
    this.events.push("wake");
    return pending.length;
  }

  async listUndeliverable(limit: number) {
    return [...this.records.values()]
      .filter((record) => record.status === "undeliverable")
      .slice(0, normalizeFederationDeliveryLimit(limit))
      .map((record) => structuredClone(record));
  }

  async markAccepted({ deliveryId }: { deliveryId: string }) {
    if (this.failAccept) throw new Error("accept commit failed");
    this.events.push("accepted");
    this.records.delete(deliveryId);
  }

  async markRetry(input: Parameters<FederationDeliveryQueue["markRetry"]>[0]) {
    const record = this.records.get(input.deliveryId)!;
    const now = input.now ?? Date.now();
    if (input.countAttempt !== false) record.attempts++;
    record.status = record.attempts >= federationDeliveryMaxAttempts ? "undeliverable" : "pending";
    record.nextAttemptAt =
      record.status === "undeliverable"
        ? null
        : nextFederationDeliveryAttemptAt(
            now,
            record.attempts,
            input.retryAfterMs,
            input.retryDelayMs,
          );
    record.updatedAt = record.lastFailureAt = now;
    this.events.push("retry");
    return structuredClone(record);
  }
}
