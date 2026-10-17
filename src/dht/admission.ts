// Adapted from UnoLock node; see NOTICE.md. SPDX-License-Identifier: AGPL-3.0-only
/** Immediate, bounded admission: no unbounded waiter queue or lookup history.
 * Permits stay held until the actual operation settles, not merely until its
 * caller stops waiting. Transports must honor cancellation themselves. */
export class DhtAdmission {
  private active = 0;

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1024) {
      throw new Error("Invalid DHT admission capacity");
    }
  }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.active >= this.capacity) throw new DhtCapacityError();
    this.active++;
    try {
      return await operation();
    } finally {
      this.active--;
    }
  }

  get inFlight(): number {
    return this.active;
  }
}

export class DhtCapacityError extends Error {
  constructor() {
    super("Federation DHT capacity reached");
    this.name = "DhtCapacityError";
  }
}
