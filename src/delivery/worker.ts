import type { FederationDeliveryProcessSummary } from "./coordinator.js";
import { notifyDeliveryObserver, type FederationDeliveryObserver } from "./observer.js";

export interface FederationDeliveryWorkerCoordinator {
  processDue(options?: { now?: number; limit?: number }): Promise<FederationDeliveryProcessSummary>;
  wakePendingForStartup?(options?: { now?: number; limit?: number }): Promise<number>;
  resumeProcessing?(): void;
  stopProcessing?(): Promise<void>;
}

export interface FederationDeliveryWorkerOptions {
  coordinator: FederationDeliveryWorkerCoordinator;
  intervalMs?: number;
  batchLimit?: number;
  observer?: FederationDeliveryObserver;
}

export interface FederationDeliveryWorkerHandle {
  runOnce(): Promise<void>;
  stop(): Promise<void>;
}

const defaultIntervalMs = 60_000;
const defaultBatchLimit = 16;

export function startFederationDeliveryWorker(
  options: FederationDeliveryWorkerOptions,
): FederationDeliveryWorkerHandle {
  const worker = new FederationDeliveryWorker(options);
  worker.start();
  return worker;
}

export class FederationDeliveryWorker implements FederationDeliveryWorkerHandle {
  private readonly intervalMs: number;
  private readonly batchLimit: number;
  private readonly observer?: FederationDeliveryObserver;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private startup: NodeJS.Immediate | undefined;
  private startupDrain?: Promise<void>;
  private drain?: Promise<void>;
  private finishDrain?: () => void;

  constructor(private readonly options: FederationDeliveryWorkerOptions) {
    this.intervalMs = normalizeInterval(options.intervalMs ?? defaultIntervalMs);
    this.batchLimit = normalizeBatchLimit(options.batchLimit ?? defaultBatchLimit);
    this.observer = options.observer;
  }

  start(): void {
    if (this.timer || this.stopped) {
      return;
    }
    this.options.coordinator.resumeProcessing?.();
    this.startup = setImmediate(() => {
      this.startup = undefined;
      if (this.stopped) return;
      this.startupDrain = this.runStartupOnce().catch(() =>
        notifyDeliveryObserver(() => this.observer?.onError?.({ operation: "worker" })),
      );
    });
    this.timer = setInterval(() => {
      this.runOnce().catch(() =>
        notifyDeliveryObserver(() => this.observer?.onError?.({ operation: "worker" })),
      );
    }, this.intervalMs);
    this.timer.unref();
  }

  async runOnce(): Promise<void> {
    if (this.stopped) return;
    if (this.running) {
      return;
    }
    this.running = true;
    this.drain = new Promise((resolve) => {
      this.finishDrain = resolve;
    });
    try {
      const summary = await this.options.coordinator.processDue({
        limit: this.batchLimit,
      });
      if (
        summary.attempted > 0 ||
        summary.accepted > 0 ||
        summary.queued > 0 ||
        summary.undeliverable > 0
      ) {
        // A supplied coordinator can return additional fields at runtime.
        // Preserve the aggregate-only boundary instead of forwarding its object.
        const aggregate: FederationDeliveryProcessSummary = {
          attempted: summary.attempted,
          accepted: summary.accepted,
          queued: summary.queued,
          undeliverable: summary.undeliverable,
          ...(summary.retryReasons && Object.keys(summary.retryReasons).length > 0
            ? { retryReasons: summary.retryReasons }
            : {}),
        };
        await notifyDeliveryObserver(() => this.observer?.onBatchProcessed?.(aggregate));
      }
    } finally {
      this.running = false;
      this.finishDrain?.();
      this.finishDrain = undefined;
      this.drain = undefined;
    }
  }

  private async runStartupOnce(): Promise<void> {
    const woken = await this.options.coordinator.wakePendingForStartup?.({
      limit: this.batchLimit,
    });
    if (woken && woken > 0) {
      await notifyDeliveryObserver(() => this.observer?.onStartupWake?.(woken));
    }
    await this.runOnce();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.startup) clearImmediate(this.startup);
    this.startup = undefined;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await Promise.all([this.drain, this.startupDrain, this.options.coordinator.stopProcessing?.()]);
  }
}

function normalizeInterval(value: number): number {
  if (!Number.isInteger(value) || value < 1_000 || value > 3_600_000) {
    throw new Error("Federation delivery worker interval is invalid");
  }
  return value;
}

function normalizeBatchLimit(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 256) {
    throw new Error("Federation delivery worker batch limit is invalid");
  }
  return value;
}
