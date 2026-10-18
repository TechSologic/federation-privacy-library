// Adapted from UnoLock node; see NOTICE.md. SPDX-License-Identifier: AGPL-3.0-only
import { walkDht } from "./iterativeLookup.js";
import { dhtBucketIndex, dhtRefreshTarget, requireDhtId, type DhtContact } from "./routingTable.js";

export interface DhtMaintenanceOptions {
  localId: string;
  seeds(): Promise<DhtContact[]>;
  closest(target: string): Promise<DhtContact[]>;
  oldest(limit: number): Promise<DhtContact[]>;
  candidates(): Promise<DhtContact[]>;
  ping(peer: DhtContact, signal: AbortSignal): Promise<void>;
  findNode(peer: DhtContact, target: string, signal: AbortSignal): Promise<DhtContact[]>;
  verified(peer: DhtContact, signal: AbortSignal): Promise<void>;
  failed(peer: DhtContact, startedAt: number): Promise<void>;
  shouldRecordFailure(error: unknown): boolean;
  randomId(): string;
}

export interface DhtMaintenanceSummary {
  candidateCount: number;
  probeCount: number;
  promotedCount: number;
  failedCount: number;
  introductionCount: number;
  refreshedBuckets: number;
  joined: boolean;
}

/** Join walks the node's neighborhood, then refreshes every intervening
 * distance range. Each bounded round continues where the previous one stopped.
 * Maintenance targets never depend on user address lookups. */
export class DhtMaintenance {
  private cursor = -1;
  private deepest = 0;
  joined = false;
  private active?: Promise<DhtMaintenanceSummary>;

  constructor(private readonly options: DhtMaintenanceOptions) {
    requireDhtId(options.localId);
  }

  run(parent?: AbortSignal): Promise<DhtMaintenanceSummary> {
    if (!this.active)
      this.active = this.runRound(parent).finally(() => {
        this.active = undefined;
      });
    return this.active;
  }

  private async runRound(parent?: AbortSignal): Promise<DhtMaintenanceSummary> {
    const deadline = Date.now() + 90_000;
    const signal = AbortSignal.any([AbortSignal.timeout(90_000), ...(parent ? [parent] : [])]);
    const summary: DhtMaintenanceSummary = {
      candidateCount: 0,
      probeCount: 0,
      promotedCount: 0,
      failedCount: 0,
      introductionCount: 0,
      refreshedBuckets: 0,
      joined: this.joined,
    };
    const verified = new Set<string>();
    let remainingQueries = 40;
    const remember = async (peer: DhtContact, requestSignal: AbortSignal): Promise<void> => {
      if (!verified.has(peer.id)) {
        verified.add(peer.id);
        if (
          await this.options.verified(peer, requestSignal).then(
            () => true,
            () => false,
          )
        )
          summary.promotedCount++;
      }
    };
    const failed = async (peer: DhtContact, startedAt: number, error: unknown): Promise<void> => {
      summary.failedCount++;
      if (!signal.aborted && this.options.shouldRecordFailure(error)) {
        await this.options.failed(peer, startedAt).catch(() => {});
      }
    };
    if (signal.aborted) return summary;
    const hints = await this.options.candidates();
    summary.candidateCount = hints.length;
    const selection = parseInt(requireDhtId(this.options.randomId()).slice(0, 8), 16);
    const offset = hints.length ? selection % hints.length : 0;
    const sampled = [...hints.slice(offset), ...hints.slice(0, offset)].slice(0, 4);
    const oldest = await this.options.oldest(1);
    // One announcement to an established contact spreads our reachability.
    // On a cold start choose one seed, not a ping before every discovery RPC.
    const seeds = oldest.length
      ? []
      : (await this.options.seeds()).filter((peer) => peer.id !== this.options.localId);
    const seed = seeds.length ? [seeds[selection % seeds.length]] : [];
    const initial = new Map([...oldest, ...sampled, ...seed].map((peer) => [peer.id, peer]));
    const probes = [...initial.values()].filter((peer) => peer.id !== this.options.localId);
    for (let index = 0; index < probes.length && !signal.aborted; index += 3) {
      await Promise.all(
        probes.slice(index, index + 3).map(async (peer) => {
          const startedAt = Date.now();
          remainingQueries--;
          try {
            const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
            summary.probeCount++;
            await this.options.ping(peer, requestSignal);
            requestSignal.throwIfAborted();
            await remember(peer, requestSignal);
          } catch (error) {
            await failed(peer, startedAt, error);
          }
        }),
      );
    }
    for (let walk = 0; walk < 4 && remainingQueries >= 20 && !signal.aborted; walk++) {
      const target =
        this.cursor < 0
          ? this.options.localId
          : dhtRefreshTarget(this.options.localId, this.cursor, this.options.randomId());
      const seeds = [...(await this.options.closest(target)), ...(await this.options.seeds())];
      const timeoutMs = Math.min(30_000, deadline - Date.now());
      if (timeoutMs <= 0) break;
      const result = await walkDht({
        target,
        localId: this.options.localId,
        seeds,
        signal,
        maxQueries: remainingQueries,
        timeoutMs,
        rpcTimeoutMs: Math.min(8_000, timeoutMs),
        query: async (peer, key, requestSignal) => {
          const startedAt = Date.now();
          try {
            summary.introductionCount++;
            const contacts = await this.options.findNode(peer, key, requestSignal);
            requestSignal.throwIfAborted();
            // A validated outbound discovery reply itself proves reachability.
            // Requiring an extra ping doubles load and can prevent discovery
            // entirely when a seed's announcement budget is exhausted.
            await remember(peer, requestSignal);
            return { contacts };
          } catch (error) {
            // Cancellation by another result or shutdown is not peer failure.
            if (!requestSignal.aborted) await failed(peer, startedAt, error);
            throw error;
          }
        },
      });
      remainingQueries -= result.queries;
      if (!result.closest.length || result.status === "budget" || result.status === "aborted")
        break;
      const nearest = (await this.options.closest(this.options.localId))[0];
      if (!nearest) break;
      this.deepest = Math.max(this.deepest, dhtBucketIndex(this.options.localId, nearest.id));
      if (this.cursor >= 0) summary.refreshedBuckets++;
      this.cursor++;
      if (this.cursor > this.deepest) {
        // Revisit our own neighborhood each cycle. An early sparse join can
        // observe only distant buckets; without another self lookup it may
        // never discover nearer services that joined afterward.
        this.cursor = -1;
        this.joined = true;
      }
    }
    summary.joined = this.joined;
    return summary;
  }
}
