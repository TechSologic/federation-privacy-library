// Adapted from UnoLock node; see NOTICE.md. SPDX-License-Identifier: AGPL-3.0-only
export interface DhtMaintenanceWorkerOptions {
  run(signal: AbortSignal): Promise<unknown>;
  onError(error: unknown): void;
  delayMs(): number;
  minWakeDelayMs?: number;
}

/** Coalesced wake-ups cannot bypass the minimum round spacing. Shutdown aborts
 * and drains the active round; no new scheduling happens afterward. */
export function createDhtMaintenanceWorker(options: DhtMaintenanceWorkerOptions): {
  start(): void;
  wake(): void;
  stop(): Promise<void>;
} {
  const controller = new AbortController();
  // Forty maintenance RPCs per round must not be amplified above a managed
  // peer's one-request/second sustained admission by incoming announcements.
  const minimum = options.minWakeDelayMs ?? 60_000;
  if (!Number.isSafeInteger(minimum) || minimum < 1_000)
    throw new Error("Invalid maintenance wake interval");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  let lastStarted = -Infinity;
  let wakePending = false;
  let started = false;
  const schedule = (delay: number): void => {
    if (controller.signal.aborted) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      run();
    }, delay);
    timer.unref?.();
  };
  const run = (): void => {
    if (controller.signal.aborted || active) return;
    const remaining = Math.max(0, minimum - (Date.now() - lastStarted));
    if (remaining > 0) {
      schedule(remaining);
      return;
    }
    lastStarted = Date.now();
    wakePending = false;
    let operation: Promise<unknown>;
    try {
      operation = options.run(controller.signal);
    } catch (error) {
      operation = Promise.reject(error);
    }
    active = operation
      .then(() => {}, options.onError)
      .finally(() => {
        active = undefined;
        const delay = wakePending
          ? Math.max(0, minimum - (Date.now() - lastStarted))
          : options.delayMs();
        schedule(delay);
      });
  };
  return {
    start() {
      if (!started) {
        started = true;
        run();
      }
    },
    wake() {
      if (!started || controller.signal.aborted) return;
      wakePending = true;
      if (!active) schedule(Math.max(0, minimum - (Date.now() - lastStarted)));
    },
    async stop() {
      controller.abort();
      if (timer) clearTimeout(timer);
      timer = undefined;
      await active;
    },
  };
}
