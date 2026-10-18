import type { FederationLookupPeer, FederationLookupValue } from "../protocol/lookupRecords.js";
/** Durable, encrypted first-verified bindings. Never expire, evict or overwrite
 * pins automatically. Capacity/storage failures must fail closed. pinValue is an
 * atomic insert-if-absent and returns the winner, including concurrent inserts.
 * Only the library's verified resolution path may call pinValue; DHT replicas
 * must remain in separate storage. Return isolated byte snapshots.
 */
export interface LookupPinStorage {
  findPinnedValue(addressHash: string): Promise<FederationLookupValue | undefined>;
  pinValue(input: FederationLookupValue): Promise<FederationLookupValue>;
}

/** Application persistence for discovery records, verified pins and peers.
 * Encrypt values, routing indexes and backups at rest. */
export interface LookupStorage extends LookupPinStorage {
  // Only local address-publication code may create authoritative records.
  putValue(input: {
    addressHash: string;
    lookupValue: Uint8Array;
    now?: number;
  }): Promise<FederationLookupValue>;

  putReplica(input: {
    addressHash: string;
    lookupValue: Uint8Array;
    now?: number;
  }): Promise<FederationLookupValue>;

  findOwnedValue(addressHash: string): Promise<FederationLookupValue | undefined>;

  findValue(addressHash: string): Promise<FederationLookupValue | undefined>;

  findNode(routingKey: string): Promise<FederationLookupPeer[]>;

  /** Optional dynamic introductions, e.g. a bounded application configuration cache. */
  findBootstrapPeers?(): Promise<FederationLookupPeer[]>;

  configureRouting(localOnionService: string): void;

  findPeersForMaintenance(limit?: number): FederationLookupPeer[] | Promise<FederationLookupPeer[]>;

  recordPeerFailure(peer: FederationLookupPeer, startedAt: number): Promise<void>;

  offerPeerCandidate(peer: FederationLookupPeer): boolean;

  findPeerCandidates(): FederationLookupPeer[] | Promise<FederationLookupPeer[]>;

  // Stores a peer only after its onion service answered an outbound probe.
  ping(peer: FederationLookupPeer, signal?: AbortSignal): Promise<{ ok: true; checkedAt: number }>;
}

/** A host may nominate jobs from a distributed index. Claiming must atomically
 * acquire exclusive, expiring ownership and return the exact owned snapshot.
 * Eligibility and retention checks belong to the host. Undefined means another
 * worker owns the job, it is inactive, or it no longer exists. Completion must
 * condition on the same lease token and generation; an expired/superseded claim
 * must never complete replacement work. Abort leaves intent recoverable.
 */
export interface PublicationClaim {
  readonly value: FederationLookupValue;
  complete(success: boolean, options: { signal?: AbortSignal }): Promise<void>;
}

export interface ClaimedPublicationStorage {
  listDue(
    now: number,
    limit: number,
    options?: { signal?: AbortSignal },
  ): Promise<{ addressHash: string }[]>;
  claim(
    addressHash: string,
    options: { signal?: AbortSignal },
  ): Promise<PublicationClaim | undefined>;
  requestRepair(now: number): Promise<void>;
}

export interface PublicationRecord {
  addressHash: string;
  attempts: number;
  nextAttemptAt: number;
  updatedAt: number;
  publishedAt?: number;
}

export interface PublicationStorage {
  enqueue(input: { addressHash: string; now?: number }): Promise<PublicationRecord>;

  listDue(
    now: number,
    limit: number,
    options?: { signal?: AbortSignal },
  ): Promise<PublicationRecord[]>;

  countPending(): Promise<number>;

  markSucceeded(input: { addressHash: string; now?: number }): Promise<void>;

  markFailed(input: { addressHash: string; now?: number }): Promise<PublicationRecord>;
  remove(addressHash: string): Promise<void>;
  requestRepair(now: number): Promise<void>;
}
