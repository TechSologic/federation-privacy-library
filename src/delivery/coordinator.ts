import {
  type FederationDeliveryQueue,
  type FederationQueuedDeliveryRecord,
  normalizeFederationDeliveryInput,
} from "./queue.js";
import {
  type FederationDeliveryResult,
  type FederationDeliveryRequest,
  type FederationTransport,
} from "./transport.js";
import { randomInt } from "node:crypto";
import { notifyDeliveryObserver, type FederationDeliveryObserver } from "./observer.js";
import {
  federationDeliveryPaths,
  type FederationDeliveryPath,
  normalizeReceiveLookupTargets,
  validateFederationOnionService,
} from "../protocol/lookupRecords.js";

export interface FederationDeliveryTarget {
  onionService: string;
  deliveryPath: FederationDeliveryPath;
  priority: number;
}

export type FederationDeliveryTargetResolution =
  | { status: "resolved"; targets: FederationDeliveryTarget[] }
  | { status: "unavailable"; retryDelayMs?: number; retryReason?: string };

export interface FederationDeliveryTargetResolver {
  resolveTargets(request: {
    addressHash: string;
    expectedValidationFingerprint?: string;
  }): Promise<FederationDeliveryTarget[] | FederationDeliveryTargetResolution>;
}

/** Consumer-owned route cache; updates must already be locally authorized. */
export interface FederationDeliveryRoutingSink {
  setLookupTargets(addressHash: string, targets: FederationDeliveryTarget[]): void;
}

export interface FederationDeliveryCoordinatorOptions {
  observer?: FederationDeliveryObserver;
  queue: FederationDeliveryQueue;
  transport: FederationTransport;
  targetResolver: FederationDeliveryTargetResolver;
  routingCache?: FederationDeliveryRoutingSink;
  maxRetryBatch?: number;
  deliveryStatusSink?: FederationDeliveryStatusSink;
}

export interface FederationDeliverySubmitResult {
  status: "accepted" | "queued";
  deliveryId?: string;
}

export interface FederationDeliveryProcessSummary {
  attempted: number;
  accepted: number;
  queued: number;
  undeliverable: number;
  retryReasons?: Record<string, number>;
}

export type FederationDeliveryStatus = "queued" | "delivered" | "undeliverable";

/** Application status side effect, awaited after queue mutation. Failures propagate.
 * This is not a transaction with the queue or a replayable event outbox.
 */
export interface FederationDeliveryStatusSink {
  setDeliveryStatus(input: {
    deliveryId: string;
    status: FederationDeliveryStatus;
    updatedAt: number;
  }): Promise<void>;
}

export class FederationDeliveryCoordinator {
  private readonly queue: FederationDeliveryQueue;
  private readonly transport: FederationTransport;
  private readonly targetResolver: FederationDeliveryTargetResolver;
  private readonly maxRetryBatch: number;
  private readonly deliveryStatusSink?: FederationDeliveryStatusSink;
  private readonly observer?: FederationDeliveryObserver;
  private activeDelivery?: Promise<unknown>;
  private stopped = false;
  private pendingKick = false;
  private kick: NodeJS.Immediate | undefined;

  constructor(options: FederationDeliveryCoordinatorOptions) {
    this.observer = options.observer;
    this.queue = options.queue;
    this.transport = options.transport;
    this.targetResolver = options.targetResolver;
    this.maxRetryBatch = normalizeBatchLimit(options.maxRetryBatch ?? 32);
    this.deliveryStatusSink = options.deliveryStatusSink;
  }

  async submit(
    request: FederationDeliveryRequest,
    options: { now?: number; deliveryId?: string } = {},
  ): Promise<FederationDeliverySubmitResult> {
    const delivery = normalizeFederationDeliveryInput({
      deliveryId: options.deliveryId,
      addressHash: request.addressHash,
      envelope: request.envelope,
      expectedValidationFingerprint: request.expectedValidationFingerprint,
    });
    validateDeliveryTarget({
      onionService: request.onionService,
      deliveryPath: request.deliveryPath,
    });
    const queued = await this.queue.enqueue({ ...delivery, now: options.now });
    if (this.stopped || this.activeDelivery) {
      if (!this.stopped) this.pendingKick = true;
      return { status: "queued", deliveryId: queued.deliveryId };
    }
    return this.runDelivery<FederationDeliverySubmitResult>(async () => {
      if (this.stopped) return { status: "queued", deliveryId: queued.deliveryId };
      // Caller-supplied routes are not authority. Resolve and durably pin the
      // normalized destination before every first attempt, just as on retries.
      const resolution = normalizeTargetResolution(
        await this.targetResolver.resolveTargets({
          addressHash: delivery.addressHash,
          expectedValidationFingerprint: delivery.expectedValidationFingerprint,
        }),
      );
      if (this.stopped) return { status: "queued", deliveryId: queued.deliveryId };
      if (resolution.status === "unavailable") {
        await this.queue.markRetry({
          deliveryId: queued.deliveryId,
          now: options.now,
          retryDelayMs: resolution.retryDelayMs ?? 5_000,
          retryReason: resolution.retryReason ?? "lookup-unavailable",
          countAttempt: false,
        });
        return { status: "queued", deliveryId: queued.deliveryId };
      }
      const target = orderTargetsForAttempt(resolution.targets)[0];
      if (!target) {
        await this.queue.markRetry({
          deliveryId: queued.deliveryId,
          now: options.now,
          retryReason: "no-targets",
        });
        return { status: "queued", deliveryId: queued.deliveryId };
      }
      const result = await this.transport.deliver({
        onionService: target.onionService,
        deliveryPath: target.deliveryPath,
        addressHash: delivery.addressHash,
        envelope: delivery.envelope,
        expectedValidationFingerprint: delivery.expectedValidationFingerprint,
      });
      if (result.status === "accepted") {
        await this.queue.markAccepted({ deliveryId: queued.deliveryId });
        await this.setDeliveryStatus(delivery.deliveryId, "delivered", options.now ?? Date.now());
        return { status: "accepted" };
      }
      if (result.retryAfterMs) {
        const retry = await this.queue.markRetry({
          deliveryId: queued.deliveryId,
          now: options.now,
          retryAfterMs: result.retryAfterMs,
          retryReason: result.retryReason,
          countAttempt: result.countAttempt,
        });
        await this.setDeliveryStatus(
          queued.deliveryId,
          retry.status === "undeliverable" ? "undeliverable" : "queued",
          retry.updatedAt,
        );
      } else {
        await this.setDeliveryStatus(queued.deliveryId, "queued", queued.updatedAt);
      }
      return { status: "queued", deliveryId: queued.deliveryId };
    });
  }

  processDue(
    options: { now?: number; limit?: number } = {},
  ): Promise<FederationDeliveryProcessSummary> {
    // Immediate message kicks and the periodic worker share this boundary.
    // Skipped callers must not report another caller's delivery counts.
    if (this.stopped || this.activeDelivery) {
      if (!this.stopped) this.pendingKick = true;
      return Promise.resolve({ attempted: 0, accepted: 0, queued: 0, undeliverable: 0 });
    }
    return this.runDelivery(() => this.processDueBatch(options));
  }

  resumeProcessing(): void {
    if (this.stopped && this.activeDelivery)
      throw new Error("Federation delivery is still draining");
    this.stopped = false;
  }

  async stopProcessing(): Promise<void> {
    this.stopped = true;
    this.pendingKick = false;
    if (this.kick) clearImmediate(this.kick);
    this.kick = undefined;
    // The initiating caller owns error reporting; shutdown still drains a
    // rejected attempt before its queue/database can be closed.
    await this.activeDelivery?.catch(() => undefined);
  }

  private runDelivery<T>(operation: () => Promise<T>): Promise<T> {
    if (this.kick) clearImmediate(this.kick);
    this.kick = undefined;
    this.pendingKick = false;
    const work = Promise.resolve()
      .then(operation)
      .finally(() => {
        this.activeDelivery = undefined;
        if (this.pendingKick && !this.stopped) {
          this.pendingKick = false;
          this.kick = setImmediate(() => {
            this.kick = undefined;
            void this.processDue().catch(() =>
              notifyDeliveryObserver(() =>
                this.observer?.onError?.({ operation: "deferred-kick" }),
              ),
            );
          });
          this.kick.unref();
        }
      });
    this.activeDelivery = work;
    return work;
  }

  private async processDueBatch(options: {
    now?: number;
    limit?: number;
  }): Promise<FederationDeliveryProcessSummary> {
    const now = options.now ?? Date.now();
    const limit = options.limit ?? this.maxRetryBatch;
    const due = this.stopped ? [] : await this.queue.listDue(now, limit);
    let attempted = 0;
    let accepted = 0;
    let queued = 0;
    let undeliverable = 0;
    const retryReasons: Record<string, number> = {};

    for (const record of due) {
      if (this.stopped) break;
      const targetResolution = normalizeTargetResolution(
        await this.targetResolver.resolveTargets({
          addressHash: record.addressHash,
          expectedValidationFingerprint: record.expectedValidationFingerprint,
        }),
      );
      if (this.stopped) break;
      if (targetResolution.status === "unavailable") {
        const retryReason = targetResolution.retryReason ?? "lookup-unavailable";
        incrementRetryReason(retryReasons, retryReason);
        await this.queue.markRetry({
          deliveryId: record.deliveryId,
          now,
          retryDelayMs: targetResolution.retryDelayMs ?? 5_000,
          retryReason,
          countAttempt: false,
        });
        queued += 1;
        continue;
      }
      const targets = orderTargetsForAttempt(targetResolution.targets);
      if (targets.length === 0) {
        incrementRetryReason(retryReasons, "no-targets");
        const retry = await this.queue.markRetry({
          deliveryId: record.deliveryId,
          now,
          retryReason: "no-targets",
        });
        if (retry.status === "undeliverable") {
          undeliverable += 1;
        } else {
          queued += 1;
        }
        continue;
      }

      let lastRetryAfterMs: number | undefined;
      let countAttempt = true;
      let lastRetryReason: string | undefined;
      let delivered = false;
      for (const normalizedTarget of targets) {
        if (this.stopped) break;
        attempted += 1;
        const result = await this.transport.deliver({
          onionService: normalizedTarget.onionService,
          deliveryPath: normalizedTarget.deliveryPath,
          addressHash: record.addressHash,
          envelope: new Uint8Array(record.envelope),
          expectedValidationFingerprint: record.expectedValidationFingerprint,
        });
        if (result.status === "accepted") {
          this.applyPinnedTargetUpdate(record.addressHash, result);
          await this.queue.markAccepted({ deliveryId: record.deliveryId });
          await this.setDeliveryStatus(record.deliveryId, "delivered", now);
          accepted += 1;
          delivered = true;
          break;
        }
        const retryReason = result.retryReason ?? "retry";
        lastRetryReason = retryReason;
        if (result.countAttempt === false) countAttempt = false;
        incrementRetryReason(retryReasons, retryReason);
        if (result.retryAfterMs && (!lastRetryAfterMs || result.retryAfterMs < lastRetryAfterMs)) {
          lastRetryAfterMs = result.retryAfterMs;
        }
      }
      if (delivered) {
        continue;
      }
      if (this.stopped) break;
      const retry = await this.queue.markRetry({
        deliveryId: record.deliveryId,
        now,
        retryAfterMs: lastRetryAfterMs,
        retryReason: lastRetryReason,
        countAttempt,
      });
      if (retry.status === "undeliverable") {
        await this.setDeliveryStatus(record.deliveryId, "undeliverable", retry.updatedAt);
        undeliverable += 1;
      } else {
        await this.setDeliveryStatus(record.deliveryId, "queued", retry.updatedAt);
        queued += 1;
      }
    }

    const summary = {
      attempted,
      accepted,
      queued,
      undeliverable,
      ...(Object.keys(retryReasons).length > 0 ? { retryReasons } : {}),
    };
    return summary;
  }

  async wakePendingForStartup(options: { now?: number; limit?: number } = {}): Promise<number> {
    if (this.stopped) return 0;
    const now = options.now ?? Date.now();
    const limit = options.limit ?? this.maxRetryBatch;
    const woken = await this.queue.wakePending(now, limit);
    return woken;
  }

  async listUndeliverable(limit = 32): Promise<FederationQueuedDeliveryRecord[]> {
    return this.queue.listUndeliverable(normalizeBatchLimit(limit));
  }

  private applyPinnedTargetUpdate(addressHash: string, result: FederationDeliveryResult): void {
    // Accepted delivery does not grant route authority. Authenticated lookup
    // records are reopened for each retry instead of persisting relationships.
    void addressHash;
    void result;
  }

  private async setDeliveryStatus(
    deliveryId: string,
    status: FederationDeliveryStatus,
    updatedAt: number,
  ): Promise<void> {
    await this.deliveryStatusSink?.setDeliveryStatus({ deliveryId, status, updatedAt });
  }
}

function incrementRetryReason(retryReasons: Record<string, number>, reason: string): void {
  const normalized = normalizeRetryReason(reason);
  Object.defineProperty(retryReasons, normalized, {
    value: (Object.hasOwn(retryReasons, normalized) ? retryReasons[normalized] : 0) + 1,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function normalizeRetryReason(reason: string): string {
  if (reason.length === 0 || reason.length > 96 || !/^[A-Z0-9_.:-]+$/i.test(reason)) {
    return "retry";
  }
  return reason;
}

function validateDeliveryTarget(input: {
  onionService: string;
  deliveryPath: string;
  priority?: number;
}): FederationDeliveryTarget {
  if (!federationDeliveryPaths.includes(input.deliveryPath as FederationDeliveryPath)) {
    throw new Error("Federation delivery path is invalid");
  }
  return {
    onionService: validateFederationOnionService(input.onionService),
    deliveryPath: input.deliveryPath as FederationDeliveryPath,
    priority: input.priority ?? 0,
  };
}

function normalizeTargetResolution(
  result: FederationDeliveryTarget[] | FederationDeliveryTargetResolution,
): FederationDeliveryTargetResolution {
  if (Array.isArray(result)) {
    return { status: "resolved", targets: result };
  }
  return result;
}

function orderTargetsForAttempt(input: FederationDeliveryTarget[]): FederationDeliveryTarget[] {
  if (input.length === 0) {
    return [];
  }
  const targets = normalizeReceiveLookupTargets(
    input.map((target) => ({
      onionService: target.onionService,
      deliveryPath: target.deliveryPath,
      priority: target.priority ?? 0,
    })),
  );
  if (targets.length === 0) {
    return [];
  }
  const bestPriority = targets[0].priority;
  const best = shuffle(targets.filter((target) => target.priority === bestPriority));
  const fallback = targets.filter((target) => target.priority !== bestPriority);
  return [...best, ...fallback].map((target) => ({
    onionService: target.onionService,
    deliveryPath: target.deliveryPath,
    priority: target.priority,
  }));
}

function shuffle<T>(input: T[]): T[] {
  const output = [...input];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [output[index], output[swapIndex]] = [output[swapIndex], output[index]];
  }
  return output;
}

function normalizeBatchLimit(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 256) {
    throw new Error("Federation delivery batch limit is invalid");
  }
  return value;
}
