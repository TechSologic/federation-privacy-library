// Adapted from UnoLock node; see NOTICE.md. SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";
import { FederationError } from "../errors.js";
import {
  normalizeSha256HexAddressHash,
  validateFederationOnionService,
  type FederationLookupPeer,
  type FederationLookupValue,
} from "../protocol/lookupRecords.js";
import type { FederationLookupRpcClient } from "../protocol/lookupRpcClient.js";
import type { LookupStorage, PublicationStorage, ClaimedPublicationStorage } from "./storage.js";
import { normalizeFederationLookupPeer, routingKeyToBytes } from "../protocol/lookupRouting.js";
import { walkDht } from "../dht/iterativeLookup.js";
import { publishDhtValue } from "../dht/publication.js";
import type { DhtContact } from "../dht/routingTable.js";
import { DhtAdmission, DhtCapacityError } from "../dht/admission.js";
import { DhtMaintenance, type DhtMaintenanceSummary } from "../dht/maintenance.js";
const lookupWalkAdmission = new DhtAdmission(8);
const publicationAdmission = new DhtAdmission(2);

export interface FederationLookupCoordinatorOptions {
  localLookup: LookupStorage;
  rpcClient: Pick<FederationLookupRpcClient, "findValue" | "findNode" | "putValue"> &
    Partial<Pick<FederationLookupRpcClient, "ping">>;
  bootstrapPeers: FederationLookupPeer[];
  localOnionService?: string;
  publishQueue?: PublicationStorage | ClaimedPublicationStorage;
  maxPublishPeers?: number;
  maxRetryBatch?: number;
  lookupAlpha?: number;
  maxLookupQueries?: number;
  isAddressActive?(addressHash: string): Promise<boolean>;
}

export type FederationLookupResolution =
  | { readonly source: "local" | "bootstrap" | "discovered"; readonly value: FederationLookupValue }
  | { readonly source: "missing" | "unavailable"; readonly value?: never };

export interface FederationLookupPublishSummary {
  attempted: number;
  succeeded: number;
  queued: number;
}

export type FederationPeerDiscoverySummary = DhtMaintenanceSummary;

export class FederationLookupCoordinator {
  private readonly localLookup: LookupStorage;
  private readonly rpcClient: FederationLookupCoordinatorOptions["rpcClient"];
  private readonly localOnionService?: string;
  private readonly bootstrapPeers: FederationLookupPeer[];
  private readonly publishQueue?: PublicationStorage | ClaimedPublicationStorage;
  private readonly maxPublishPeers: number;
  private readonly maxRetryBatch: number;
  private readonly lookupAlpha: number;
  private readonly maxLookupQueries: number;
  private readonly isAddressActive?: FederationLookupCoordinatorOptions["isAddressActive"];
  private readonly publishing = new Map<string, Promise<FederationLookupPublishSummary>>();
  private readonly maintenance?: DhtMaintenance;
  private joinRepairRequested = false;

  constructor(options: FederationLookupCoordinatorOptions) {
    this.localLookup = options.localLookup;
    this.rpcClient = options.rpcClient;
    this.localOnionService = options.localOnionService
      ? validateFederationOnionService(options.localOnionService)
      : undefined;
    if (this.localOnionService) this.localLookup.configureRouting(this.localOnionService);
    this.bootstrapPeers = options.bootstrapPeers.map(validatePeer);
    this.publishQueue = options.publishQueue;
    this.isAddressActive = options.isAddressActive;
    this.maxPublishPeers = normalizeLimit(options.maxPublishPeers ?? 8, "maxPublishPeers");
    this.maxRetryBatch = normalizeLimit(options.maxRetryBatch ?? 32, "maxRetryBatch");
    this.lookupAlpha = normalizeLimit(options.lookupAlpha ?? 3, "lookupAlpha");
    this.maxLookupQueries = normalizeLimit(options.maxLookupQueries ?? 128, "maxLookupQueries");
    if (this.lookupAlpha > 16 || this.maxLookupQueries < 20 || this.maxPublishPeers > 20) {
      throw new Error("Federation lookup requires alpha <= 16 and at least 20 queries");
    }
    if (this.localOnionService && this.rpcClient.ping) {
      this.maintenance = new DhtMaintenance({
        localId: toDhtContact({ onionService: this.localOnionService }).id,
        seeds: async () => (await this.seeds()).map(toDhtContact),
        closest: async (key) => (await this.localLookup.findNode(key)).map(toDhtContact),
        oldest: async (limit) =>
          (await this.localLookup.findPeersForMaintenance(limit)).map(toDhtContact),
        candidates: async () => (await this.localLookup.findPeerCandidates()).map(toDhtContact),
        ping: async (peer, signal) => {
          await this.rpcClient.ping!({ onionService: peer.endpoint }, signal);
        },
        findNode: async (peer, key, signal) =>
          (await this.rpcClient.findNode({ onionService: peer.endpoint }, key, signal)).map(
            toDhtContact,
          ),
        verified: async (peer, signal) => {
          await this.localLookup.ping({ onionService: peer.endpoint }, signal);
        },
        failed: (peer, startedAt) =>
          this.localLookup.recordPeerFailure({ onionService: peer.endpoint }, startedAt),
        shouldRecordFailure: (error) =>
          !(error instanceof FederationError && error.code === "limit-exceeded"),
        randomId: () => randomBytes(32).toString("hex"),
      });
    }
  }

  private async seeds(): Promise<FederationLookupPeer[]> {
    return this.localLookup.findBootstrapPeers
      ? (await this.localLookup.findBootstrapPeers()).map(validatePeer)
      : this.bootstrapPeers;
  }

  get joined(): boolean {
    return this.maintenance?.joined === true;
  }

  // Discovery carries service routes and independent routing keys only.
  async refreshPeers(signal?: AbortSignal): Promise<FederationPeerDiscoverySummary | undefined> {
    if (!this.maintenance || signal?.aborted) return undefined;
    const summary = await this.maintenance.run(signal);
    if (!this.joinRepairRequested && summary.joined && !signal?.aborted) {
      await this.publishQueue?.requestRepair(Date.now());
      this.joinRepairRequested = true;
    }
    return summary;
  }

  async resolve(
    addressHash: string,
    signal?: AbortSignal,
    acceptValue?: (value: FederationLookupValue) => boolean,
  ): Promise<FederationLookupResolution> {
    const normalized = normalizeSha256HexAddressHash(addressHash);
    const local = await this.localLookup.findValue(normalized);
    if (local && (!acceptValue || acceptValue(local))) {
      return { source: "local", value: local };
    }

    let resolved: FederationLookupResolution;
    try {
      resolved = await lookupWalkAdmission.run(
        () => this.walkToValue(normalized, signal, acceptValue),
        signal,
      );
    } catch (error) {
      if (!(error instanceof DhtCapacityError) && !signal?.aborted) throw error;
      resolved = { source: "unavailable" };
    }
    return resolved;
  }

  async publishLocalValue(
    addressHash: string,
    options: { now?: number; signal?: AbortSignal } = {},
  ): Promise<FederationLookupPublishSummary> {
    const normalized = normalizeSha256HexAddressHash(addressHash);
    const existing = this.publishing.get(normalized);
    if (existing) return existing;
    // Persist intent before network I/O. SQLite also creates this job atomically
    // with the owned value; enqueue here covers the in-memory test adapter.
    if (this.publishQueue && !("claim" in this.publishQueue))
      await this.publishQueue.enqueue({ addressHash: normalized, now: options.now });
    try {
      return await publicationAdmission.run(async () => {
        const raced = this.publishing.get(normalized);
        if (raced) return raced;
        const work = this.publishValueOnce(normalized, options);
        this.publishing.set(normalized, work);
        try {
          return await work;
        } finally {
          this.publishing.delete(normalized);
        }
      }, options.signal);
    } catch (error) {
      if (!(error instanceof DhtCapacityError) && !options.signal?.aborted) throw error;
      if (this.publishQueue && !("claim" in this.publishQueue))
        await this.publishQueue.markFailed({ addressHash: normalized, now: options.now });
      return { attempted: 0, succeeded: 0, queued: 1 };
    }
  }

  private async publishValueOnce(
    addressHash: string,
    options: { now?: number; signal?: AbortSignal },
  ): Promise<FederationLookupPublishSummary> {
    if (this.publishQueue && "claim" in this.publishQueue) {
      const claim = await this.publishQueue.claim(addressHash, options);
      if (!claim) return { attempted: 0, succeeded: 0, queued: 0 };
      try {
        if (claim.value.addressHash !== addressHash)
          throw new FederationError("invalid-data", "Publication claim identity mismatch");
        const result = await this.placeValue(claim.value, options);
        options.signal?.throwIfAborted();
        await claim.complete(result.queued === 0, options);
        return result;
      } catch (error) {
        if (!options.signal?.aborted) await claim.complete(false, options);
        throw error;
      }
    }
    const value = await this.localLookup.findOwnedValue(addressHash);
    if (!value) {
      await this.publishQueue?.remove(addressHash);
      throw new FederationError(
        "invalid-data",
        "Cannot publish a missing owned federation lookup value",
      );
    }
    if (this.isAddressActive && !(await this.isAddressActive(addressHash))) {
      await this.publishQueue?.remove(addressHash);
      return { attempted: 0, succeeded: 0, queued: 0 };
    }
    const result = await this.placeValue(value, options);
    if (result.queued === 0)
      await this.publishQueue?.markSucceeded({ addressHash, now: options.now });
    else await this.publishQueue?.markFailed({ addressHash, now: options.now });
    return result;
  }

  private async placeValue(
    value: FederationLookupValue,
    options: { signal?: AbortSignal },
  ): Promise<FederationLookupPublishSummary> {
    const addressHash = value.addressHash;
    const signal = AbortSignal.any([
      AbortSignal.timeout(45_000),
      ...(options.signal ? [options.signal] : []),
    ]);
    const learned = await this.localLookup.findNode(addressHash);
    const publication = await publishDhtValue({
      value,
      replicas: this.maxPublishPeers,
      put: async (contact, record, requestSignal) => {
        await this.rpcClient.putValue({ onionService: contact.endpoint }, record, requestSignal);
      },
      target: addressHash,
      seeds: [...learned, ...(await this.seeds())].map(toDhtContact),
      localId: this.localOnionService
        ? toDhtContact({ onionService: this.localOnionService }).id
        : undefined,
      alpha: this.lookupAlpha,
      maxQueries: this.maxLookupQueries,
      signal,
      query: async (contact, key, requestSignal) => {
        const peer = { onionService: contact.endpoint };
        const introductions = await this.rpcClient.findNode(peer, key, requestSignal);
        requestSignal.throwIfAborted();
        await this.localLookup.ping(peer, requestSignal).catch(() => {});
        return { contacts: introductions.map(toDhtContact) };
      },
    });
    const { attempted, succeeded, complete } = publication;
    return { attempted, succeeded, queued: complete ? 0 : 1 };
  }

  async processPendingPublishes(
    options: { now?: number; limit?: number; signal?: AbortSignal } = {},
  ): Promise<FederationLookupPublishSummary> {
    if (!this.publishQueue) return { attempted: 0, succeeded: 0, queued: 0 };
    const due = await this.publishQueue.listDue(
      options.now ?? Date.now(),
      options.limit ?? this.maxRetryBatch,
      options,
    );
    const summary = { attempted: 0, succeeded: 0, queued: 0 };
    for (let offset = 0; offset < due.length && !options.signal?.aborted; offset += 2) {
      const completed = await Promise.allSettled(
        due.slice(offset, offset + 2).map(async (record) => {
          if (
            this.publishQueue &&
            !("claim" in this.publishQueue) &&
            !(await this.localLookup.findOwnedValue(record.addressHash))
          ) {
            await this.publishQueue.remove(record.addressHash);
            return;
          }
          const result = await this.publishLocalValue(record.addressHash, options);
          summary.attempted += result.attempted;
          summary.succeeded += result.succeeded;
          summary.queued += result.queued;
        }),
      );
      // A storage failure in one job must not let shutdown race another job's
      // still-active sockets or database writes.
      const failed = completed.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    }
    return summary;
  }

  private async walkToValue(
    addressHash: string,
    signal?: AbortSignal,
    acceptValue?: (value: FederationLookupValue) => boolean,
  ): Promise<FederationLookupResolution> {
    const learned = await this.localLookup.findNode(addressHash);
    // Distance ordering prefers nearby learned contacts. Keep configured seeds
    // as fallbacks in the same bounded walk if those contacts have gone away.
    const bootstrap = await this.seeds();
    const seeds = [...learned, ...bootstrap];
    const result = await walkDht<{ value: FederationLookupValue; peer: string }>({
      target: addressHash,
      seeds: seeds.map(toDhtContact),
      localId: this.localOnionService
        ? toDhtContact({ onionService: this.localOnionService }).id
        : undefined,
      alpha: this.lookupAlpha,
      maxQueries: this.maxLookupQueries,
      signal,
      query: async (contact, key, requestSignal) => {
        const peer = { onionService: contact.endpoint };
        const candidate = await this.rpcClient.findValue(peer, key, requestSignal);
        requestSignal.throwIfAborted();
        const value = candidate && (!acceptValue || acceptValue(candidate)) ? candidate : undefined;
        const introductions = value ? [] : await this.rpcClient.findNode(peer, key, requestSignal);
        requestSignal.throwIfAborted();
        // Only an actual successful response can promote a discovered peer.
        await this.localLookup.ping(peer, requestSignal).catch(() => {});
        return {
          contacts: introductions.map(toDhtContact),
          ...(value ? { value: { value, peer: contact.endpoint } } : {}),
        };
      },
    });
    if (result.value) {
      return {
        source: bootstrap.some((peer) => peer.onionService === result.value!.peer)
          ? "bootstrap"
          : "discovered",
        value: result.value.value,
      };
    }
    return {
      source:
        result.status === "converged" && (!this.maintenance || this.maintenance.joined)
          ? "missing"
          : "unavailable",
    };
  }
}

function validatePeer(peer: FederationLookupPeer): FederationLookupPeer {
  return normalizeFederationLookupPeer(peer);
}

function toDhtContact(peer: FederationLookupPeer): DhtContact {
  const normalized = normalizeFederationLookupPeer(peer);
  return {
    id: routingKeyToBytes(normalized.routingId!).toString("hex"),
    endpoint: normalized.onionService,
  };
}

function normalizeLimit(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0 || value > 128) {
    throw new Error(`Federation lookup ${label} must be an integer between 1 and 128`);
  }
  return value;
}
