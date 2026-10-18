/**
 * Federation Privacy Library — protocol and runtime value contracts.
 * Experimental public contracts. See README for implemented capabilities.
 * Copyright (c) 2026 TechSologic Inc. and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export type ByteStream = ReadableStream<Uint8Array>;
export type AddressHash = string;
export type OperationId = string;
export type Revision = string;
export type SourceId = string;

export interface CallOptions {
  readonly signal?: AbortSignal;
}
export interface PageRequest {
  readonly cursor?: string;
  readonly limit: number;
}
export interface Page<T> {
  readonly items: readonly T[];
  readonly cursor?: string;
}
/** Nonnegative safe integers; length is positive; interval is [offset, offset + length). */
export interface ByteRange {
  readonly offset: number;
  readonly length: number;
}
export interface CiphertextInfo {
  readonly byteLength: number;
  /** SHA-256 of the entire encrypted object, unpadded base64url. */
  readonly sha256?: string;
}
export interface ArchiveInfo extends CiphertextInfo {
  readonly sha256: string;
}

/** Application-owned immutable bytes, retained for the documented operation lifetime. */
export interface DataSource<M extends CiphertextInfo = CiphertextInfo> {
  readonly sourceId: SourceId;
  describe(): Promise<M>;
  open(options: CallOptions & { readonly range?: ByteRange }): Promise<ByteStream>;
}
/** Resolves durable identifiers after restart; it does not return plaintext. */
export interface SourceResolver {
  resolve(sourceId: SourceId, options: CallOptions): Promise<DataSource<ArchiveInfo> | null>;
}

export interface AddressIdentity {
  readonly addressHash: AddressHash;
  readonly encryptionFingerprint: string;
  readonly validationFingerprint: string;
}
/** A full receive address or its public derived identity; never persist its secret in server state. */
export type Destination = string | AddressIdentity;
export interface ValidationKey {
  readonly id: number;
  readonly validationKey: string;
}
export interface AddressKeys {
  readonly publicKey: string;
  readonly validationKeys: readonly ValidationKey[];
}
export interface DeliveryPolicy {
  readonly allowAttachments: boolean;
  readonly maxAttachmentBytes: number;
}
export interface LocalAddress {
  readonly identity: AddressIdentity;
  readonly keys: AddressKeys;
  readonly policy: DeliveryPolicy;
  readonly enabled: boolean;
  readonly expiresAt?: number;
}
export interface Stored<T> {
  readonly value: T;
  readonly revision: Revision;
}
export type PublicationState = "pending" | "published" | "disabled";
export interface AddressRegistration {
  readonly record: Stored<LocalAddress>;
  readonly publication: PublicationState;
}
export interface ResolvedAddress {
  readonly identity: AddressIdentity;
  readonly keys: AddressKeys;
  readonly policy: DeliveryPolicy;
  /** Zero denotes a standing host binding. It does not override host admission policy. */
  readonly expiresAt: number;
  readonly routes: {
    readonly messageOnionService: string;
    readonly archiveOnionService?: string;
  };
}
export interface AddressApi {
  register(record: LocalAddress, options?: CallOptions): Promise<AddressRegistration>;
  get(addressHash: AddressHash, options?: CallOptions): Promise<AddressRegistration | null>;
  list(query: PageRequest, options?: CallOptions): Promise<Page<AddressRegistration>>;
  update(
    record: LocalAddress,
    expectedRevision: Revision,
    options?: CallOptions,
  ): Promise<AddressRegistration>;
  remove(
    addressHash: AddressHash,
    expectedRevision: Revision,
    options?: CallOptions,
  ): Promise<void>;
  /** Null means a completed lookup found no result; temporary unavailability rejects. */
  lookup(destination: Destination, options?: CallOptions): Promise<ResolvedAddress | null>;
  /** Persists publication intent; does not wait for every peer to observe it. */
  publish(addressHash: AddressHash, options?: CallOptions): Promise<void>;
}
/** Offline utilities; using them does not require a running federation instance. */

export interface AddressStore {
  get(addressHash: AddressHash): Promise<Stored<LocalAddress> | null>;
  list(query: PageRequest & { readonly enabled?: boolean }): Promise<Page<Stored<LocalAddress>>>;
}
export interface StateKey {
  readonly collection: string;
  readonly key: string;
}
export interface StateRecord {
  readonly key: StateKey;
  /** Versioned, library-owned encoding. Backend treats this as opaque bytes. */
  readonly bytes: Uint8Array;
  readonly dueAt?: number;
}
export interface FederationStateStore {
  /** State can contain encrypted payloads plus sensitive routing and operation
   * metadata. Production adapters must encrypt records and indexes at rest,
   * with keys managed separately from the stored data.
   */
  get(key: StateKey): Promise<Stored<StateRecord> | null>;
  list(
    query: PageRequest & { readonly collection: string; readonly dueBefore?: number },
  ): Promise<Page<Stored<StateRecord>>>;
}
export type StorageMutation =
  | {
      readonly kind: "address";
      readonly key: AddressHash;
      readonly expectedRevision: Revision | null;
      readonly value: LocalAddress | null;
    }
  | {
      readonly kind: "state";
      readonly key: StateKey;
      readonly expectedRevision: Revision | null;
      readonly value: StateRecord | null;
    };
export type StorageCommit =
  | { readonly outcome: "committed"; readonly revisions: readonly (Revision | null)[] }
  | { readonly outcome: "conflict" }
  | { readonly outcome: "fenced" };
/** Monotonically increasing ownership token issued by the storage adapter. */
export interface StorageFence {
  readonly owner: string;
  readonly epoch: number;
}
export interface FederationLeaseStore {
  /** Atomically claims an absent or expired lease and increments its epoch. */
  claim(owner: string, expiresAt: number): Promise<StorageFence | null>;
  /** Renews only the exact, unexpired fence. */
  renew(fence: StorageFence, expiresAt: number): Promise<boolean>;
  /** Releases only the exact fence; stale releases have no effect. */
  release(fence: StorageFence): Promise<void>;
}
/** One configurable storage object, with focused address and state interfaces.
 * Every production implementation must encrypt records, blobs, indexes, commit
 * journals and backups at rest. Applications own key separation and rotation.
 */
export interface FederationStorage {
  readonly addresses: AddressStore;
  readonly state: FederationStateStore;
  readonly lease: FederationLeaseStore;
  /** All mutations or none. Null expectation means absent; null value deletes.
   * A retry of the same commitId, exact batch, and valid fence returns the original result.
   * The adapter must atomically reject a stale or expired fence.
   */
  commit(
    commitId: string,
    changes: readonly StorageMutation[],
    fence: StorageFence,
  ): Promise<StorageCommit>;
}

export interface TransferFailure {
  readonly code:
    | "unavailable"
    | "not-found"
    | "unauthorized"
    | "conflict"
    | "invalid-data"
    | "source-unavailable"
    | "receiver-unavailable"
    | "storage"
    | "limit-exceeded"
    | "cancelled"
    | "internal";
  readonly retryable: boolean;
  /** Sanitized explanation, excluding raw addresses, routes, proofs and content. */
  readonly message: string;
}
export type TransferState =
  | "queued"
  | "running"
  | "retrying"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed";
export interface TransferSnapshot {
  readonly id: OperationId;
  readonly kind: "message" | "archive-send" | "archive-read";
  readonly state: TransferState;
  readonly attempt: number;
  readonly bytesTransferred: number;
  readonly totalBytes: number;
  readonly nextAttemptAt?: number;
  readonly failure?: TransferFailure;
}
export type TransferEvent =
  | { readonly type: "progress"; readonly snapshot: TransferSnapshot }
  | { readonly type: "state"; readonly snapshot: TransferSnapshot }
  | {
      readonly type: "retry";
      readonly snapshot: TransferSnapshot;
      readonly failure: TransferFailure;
    }
  | {
      readonly type: "completed";
      readonly snapshot: TransferSnapshot;
      readonly result: TransferResult;
    }
  | { readonly type: "cancelled"; readonly snapshot: TransferSnapshot }
  | {
      readonly type: "failed";
      readonly snapshot: TransferSnapshot;
      readonly failure: TransferFailure;
    };
export interface TransferListener {
  onEvent(event: TransferEvent): void | Promise<void>;
}
export type TransferResult =
  | { readonly kind: "message"; readonly outcome: "delivered" }
  | {
      readonly kind: "archive-send";
      readonly outcome: "staged" | "committed";
      readonly archive: ArchiveReference;
      readonly info: ArchiveInfo;
      readonly receipt: ProtocolDocument;
    }
  | {
      readonly kind: "archive-read";
      readonly outcome: "received";
      readonly archive: ArchiveReference;
      readonly range?: ByteRange;
    };
export type TransferOutcome =
  | { readonly status: "completed"; readonly result: TransferResult }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly failure: TransferFailure };
export interface Transfer {
  readonly id: OperationId;
  status(options?: CallOptions): Promise<TransferSnapshot>;
  /** Resolves to a terminal outcome; waiting may be aborted without cancelling the transfer. */
  wait(options?: CallOptions): Promise<TransferOutcome>;
  cancel(options?: CallOptions): Promise<TransferSnapshot>;
  resume(options?: CallOptions): Promise<TransferSnapshot>;
  /** Returns an unsubscribe function. A late listener first receives a current snapshot. */
  listen(listener: TransferListener): () => void;
}
export interface TransferApi {
  get(id: OperationId, options?: CallOptions): Promise<Transfer | null>;
  list(query: PageRequest, options?: CallOptions): Promise<Page<TransferSnapshot>>;
}
export interface SendOptions extends CallOptions {
  /** Stable application idempotency key for an exact retry of submission. */
  readonly operationId?: OperationId;
}
/** Submission failures have an exported constructor and an explicit durable outcome. */
export type SubmissionError = import("./submission.js").FederationSubmissionError;

export interface EncryptedMessage {
  readonly messageId: number;
  readonly senderAddressHash: AddressHash;
  /** Application-encrypted header containing an application signature. The
   * library deliberately cannot decrypt or verify that signature.
   */
  readonly sealedHeader: string;
  readonly encryptedAttachmentDescriptors: readonly string[];
}
export interface MessageMetadata extends EncryptedMessage, CiphertextInfo {
  /** Stable deduplication identity for this destination and exact envelope. */
  readonly deliveryId: string;
  readonly destinationAddressHash: AddressHash;
  readonly signal: AbortSignal;
}
/** An explicit terminal receiver rejection is not retried; other failures are bounded. */
export interface ReceiveError extends Error {
  readonly retryable: boolean;
}
export interface MessageReceiver {
  /** Reads the complete encoded encrypted envelope. May persist it in a durable
   * application queue. Resolution means durable node custody; exact repeats
   * resolve successfully without duplicating effects. The receiving application
   * MUST decrypt and validate its signature before any message effect. The
   * federation library does not validate application message signatures.
   */
  receive(stream: ByteStream, metadata: MessageMetadata): Promise<void>;
}
export interface MessageApi {
  /** Encodes existing encrypted, application-signed fields into the current
   * protocol envelope. It performs neither encryption nor signature validation.
   */
  source(message: EncryptedMessage): DataSource;
  /** Source streams a complete encoded envelope. Resolves after durable local queuing. */
  send(
    destination: Destination,
    source: DataSource,
    listener?: TransferListener,
    options?: SendOptions,
  ): Promise<Transfer>;
}

export interface ArchiveReference {
  readonly id: string;
  readonly locator: string;
}
export interface ArchiveCollection {
  readonly id: string;
  readonly locator: string;
  readonly authorityArchiveId: string;
}
/** A bounded document carried in its existing protocol encoding; no provider credentials. */
export interface ProtocolDocument {
  readonly format: string;
  readonly bytes: Uint8Array;
}
export interface ArchiveDescription {
  readonly archive: ArchiveReference;
  readonly revision: Revision | null;
  readonly info?: ArchiveInfo;
  /** Existing public control fields plus opaque encrypted application metadata. */
  readonly metadata: ProtocolDocument;
}
export type ArchiveList =
  | { readonly outcome: "listed"; readonly page: Page<ArchiveDescription> }
  | { readonly outcome: "deleted"; readonly deletedAt: number; readonly expiresAt: number };
export interface ArchiveSource extends DataSource<ArchiveInfo> {
  readonly archive: ArchiveReference;
  /** Null requires no existing committed object; otherwise compare the exact revision. */
  readonly expectedRevision: Revision | null;
}
export interface ArchiveReceiveMetadata {
  readonly operationId: OperationId;
  readonly stageId: string;
  readonly archive: ArchiveReference;
  /** Whole-object digest may arrive only with multipart completion. */
  readonly info: CiphertextInfo;
  readonly expectedRevision: Revision | null;
  /** Byte interval in this receive call; an upload may be received in multiple parts. */
  readonly range: ByteRange;
  /** Storage ownership that the receiver must reject after it becomes stale. */
  readonly fence: StorageFence;
  readonly signal: AbortSignal;
}
export interface ArchiveReceiver {
  /** Resolves after the supplied interval is durably staged, still invisible to readers.
   * The receiver must atomically reject metadata.fence after a newer lease is issued.
   */
  receive(stream: ByteStream, metadata: ArchiveReceiveMetadata): Promise<void>;
}
export interface ArchiveReadReceiver {
  /** Consumes one requested remote read; no local archive commit is implied. */
  receive(
    stream: ByteStream,
    metadata: {
      readonly operationId: OperationId;
      readonly archive: ArchiveReference;
      readonly info: ArchiveInfo;
      readonly range: ByteRange;
      /** Digest of the bytes in this receive call. */
      readonly streamSha256: string;
      readonly signal: AbortSignal;
    },
  ): Promise<void>;
}
export interface ArchiveVersion {
  readonly hash: string;
  readonly predecessor: string | null;
  readonly sequence: number;
  readonly issuedAt: number;
  readonly signed: ProtocolDocument;
}
export type VersionCommit =
  | { readonly outcome: "committed"; readonly version: ArchiveVersion }
  | { readonly outcome: "conflict"; readonly current: ArchiveVersion | null };
export interface ArchiveRequestOptions extends CallOptions {
  /** Overrides the configured provider for this operation only. */
  readonly proofs?: ProofProvider;
  /** Trusted operation context, including authority and existing control metadata. */
  readonly context?: ProtocolDocument;
  /** Trusted authority used to authenticate returned signed version heads. */
  readonly authority?: TrustedAuthority;
}
export type ArchiveHeadFreshness =
  | {
      /** Explicit first-use trust: no previously observed head is available. */
      readonly minimumSequence: 0;
      readonly hashAtMinimum?: never;
    }
  | {
      /** Last trusted sequence observed by the application. */
      readonly minimumSequence: number;
      /** Exact trusted hash at minimumSequence. */
      readonly hashAtMinimum: string;
    };
export interface ArchiveHeadOptions extends ArchiveRequestOptions {
  readonly freshness: ArchiveHeadFreshness;
}
export type ArchiveReadOptions =
  | {
      readonly range?: undefined;
      readonly expectedInfo: ArchiveInfo;
    }
  | {
      readonly range: ByteRange;
      readonly expectedInfo: ArchiveInfo;
      /** Trusted digest of exactly the requested range. */
      readonly expectedRangeSha256: string;
    };
export interface ArchiveApi {
  create(
    destination: Destination,
    input: {
      readonly collection: ArchiveCollection;
      readonly description: ProtocolDocument;
    },
    options?: ArchiveRequestOptions,
  ): Promise<ArchiveDescription>;
  list(
    destination: Destination,
    collection: ArchiveCollection,
    query: PageRequest,
    options?: ArchiveRequestOptions,
  ): Promise<ArchiveList>;
  remove(
    destination: Destination,
    archive: ArchiveReference,
    options?: ArchiveRequestOptions,
  ): Promise<void>;
  send(
    destination: Destination,
    source: ArchiveSource,
    listener?: TransferListener,
    options?: SendOptions & ArchiveRequestOptions,
  ): Promise<Transfer>;
  read(
    destination: Destination,
    archive: ArchiveReference,
    receiver: ArchiveReadReceiver,
    listener: TransferListener | undefined,
    options: SendOptions & ArchiveRequestOptions & ArchiveReadOptions,
  ): Promise<Transfer>;
  head(
    destination: Destination,
    archive: ArchiveReference,
    options: ArchiveHeadOptions,
  ): Promise<ArchiveVersion | null>;
  commitVersion(
    destination: Destination,
    archive: ArchiveReference,
    input: {
      readonly expectedPredecessor: string | null;
      readonly signedSuccessor: ProtocolDocument;
    },
    options?: ArchiveRequestOptions,
  ): Promise<VersionCommit>;
}

/** Data access used when this host serves peers. Protocol/auth checks remain in the library. */
export interface ArchiveStoreCall {
  /** Adapters must stop cancellable work and perform no later durable mutation after abort. */
  readonly signal: AbortSignal;
}
export interface ArchiveStore {
  /** Mutating methods must atomically reject stale fences against the same lease
   * authority used by FederationStorage.
   */
  create(
    operationId: OperationId,
    collection: ArchiveCollection,
    description: ProtocolDocument,
    fence: StorageFence,
    options: ArchiveStoreCall,
  ): Promise<ArchiveDescription>;
  /** Cursor values must be authenticated and scoped to this exact collection. */
  list(
    collection: ArchiveCollection,
    query: PageRequest,
    options: ArchiveStoreCall,
  ): Promise<ArchiveList>;
  stat(archive: ArchiveReference, options: ArchiveStoreCall): Promise<ArchiveDescription | null>;
  open(
    archive: ArchiveReference,
    options: ArchiveStoreCall & { readonly range?: ByteRange },
  ): Promise<ByteStream>;
  remove(
    operationId: OperationId,
    archive: ArchiveReference,
    fence: StorageFence,
    options: ArchiveStoreCall,
  ): Promise<void>;
  inspectStage(
    stageId: string,
    options: ArchiveStoreCall,
  ): Promise<
    | { readonly state: "absent" }
    | {
        readonly state: "staged";
        readonly metadata: Omit<ArchiveReceiveMetadata, "signal" | "range">;
        readonly ranges: readonly ByteRange[];
      }
    | { readonly state: "committing" }
    | {
        readonly state: "committed";
        readonly archive: ArchiveReference;
        readonly info: ArchiveInfo;
        readonly revision: Revision;
      }
  >;
  openStage(
    stageId: string,
    options: ArchiveStoreCall & { readonly range?: ByteRange },
  ): Promise<ByteStream>;
  /** Called only after complete encrypted length and integrity verification.
   * For mutable archives this commits immutable content, not the visible head.
   * stat/open continue to follow the accepted head until commitVersion succeeds.
   */
  commitStage(
    stageId: string,
    archive: ArchiveReference,
    verified: ArchiveInfo,
    expectedRevision: Revision | null,
    fence: StorageFence,
    options: ArchiveStoreCall,
  ): Promise<
    | { readonly outcome: "committed"; readonly revision: Revision }
    | { readonly outcome: "conflict" }
  >;
  discardStage(
    stageId: string,
    fence: StorageFence,
    options: ArchiveStoreCall,
  ): Promise<"discarded" | "already-committed" | "pending">;
  head(archive: ArchiveReference, options: ArchiveStoreCall): Promise<ArchiveVersion | null>;
  /** Atomically check the predecessor and referenced stored content before publishing
   * the verified version. Concurrent removal must not publish a dangling head. */
  commitVersion(
    operationId: OperationId,
    archive: ArchiveReference,
    expectedPredecessor: string | null,
    verifiedSuccessor: ArchiveVersion,
    fence: StorageFence,
    options: ArchiveStoreCall,
  ): Promise<VersionCommit>;
}

export type AuthorizedOperation =
  | "message-receive"
  | "archive-create"
  | "archive-list"
  | "archive-read"
  | "archive-delete"
  | "archive-write"
  | "archive-head"
  | "archive-commit"
  | "multipart-init"
  | "multipart-part"
  | "multipart-complete"
  | "multipart-abort"
  | "archive-relay";
export interface AuthorizationRequest {
  readonly operation: AuthorizedOperation;
  readonly target: {
    readonly addressHash?: AddressHash;
    readonly archive?: ArchiveReference;
    readonly collection?: ArchiveCollection;
  };
  readonly requestHash: string;
  readonly canonicalRequest: Uint8Array;
  readonly submitted: readonly ProtocolDocument[];
  readonly signal: AbortSignal;
}
export interface TrustedAuthority {
  readonly keys: readonly { readonly keyId: string | number; readonly publicKey: string }[];
  /** Existing protocol authority/scope bindings, sourced from trusted app records. */
  readonly bindings: ProtocolDocument;
  /** Trusted storage scope for legacy control requests whose outer collection
   * selector is not covered by the v1 request signature.
   */
  readonly archiveCollection?: {
    readonly id: string;
    readonly authorityArchiveId: string;
  };
}
export interface AuthorizationHandler {
  /** Bounded, read-only lookup. Submitted proofs cannot install their own authority. */
  resolveAuthority(request: AuthorizationRequest): Promise<TrustedAuthority | null>;
  /** Called after required protocol verification; no policy counters consumed here. */
  authorize(request: AuthorizationRequest, authority: TrustedAuthority): Promise<"allow" | "deny">;
}
export interface ProofProvider {
  /** May retrieve client-signed material instead of possessing a signing key. */
  provide(request: {
    readonly operation: AuthorizedOperation;
    readonly target: AuthorizationRequest["target"];
    readonly requestHash: string;
    readonly canonicalRequest: Uint8Array;
    readonly signal: AbortSignal;
  }): Promise<readonly ProtocolDocument[]>;
}
export interface AddressRouteProofProvider {
  /** Obtain a client signature over the exact route bytes. The provider may
   * bridge to a client; the federation host never receives the private key.
   * The initial standing authorization fixes the address to its original node.
   * Routine publication reuses it; a different node requires a new address.
   */
  authorize(request: {
    readonly route: import("./protocol/addressRoutes.js").AddressRouteAuthorizationInput;
    readonly canonicalRequest: Uint8Array;
    readonly signal: AbortSignal;
  }): Promise<{ readonly signature: string }>;
}
export interface TorConfiguration {
  readonly onionService: string;
  readonly socksProxy: { readonly host: string; readonly port: number };
  readonly listen: { readonly host: string; readonly port: number };
  readonly bootstrap: readonly { readonly onionService: string }[];
}
export interface RuntimeStatus {
  readonly state: "stopped" | "starting" | "ready" | "degraded" | "stopping";
  readonly reason?: "tor-unavailable" | "storage-unavailable" | "identity-mismatch" | "capacity";
}
export interface RuntimeListener {
  onState(status: RuntimeStatus): void | Promise<void>;
}
export interface FederationLimits {
  readonly maxMessageBytes: number;
  readonly maxArchiveBytes: number;
  readonly maxBufferedBytes: number;
  readonly maxConcurrentTransfers: number;
  readonly maxPendingOperations: number;
  readonly maxAttempts: number;
  readonly operationRetentionMs: number;
  /** Absolute wall-clock lifetime for protocol control requests. */
  readonly controlRequestDeadlineMs: number;
  /** Absolute wall-clock lifetime for streaming encrypted archive bytes. */
  readonly archiveRequestDeadlineMs: number;
}
export interface FederationConfiguration {
  readonly storage: FederationStorage;
  readonly tor: TorConfiguration;
  /** Required for durable archive sends, independent of whether this host serves archives. */
  readonly sources?: SourceResolver;
  /** Omission disables message admission on this host; it does not expose recipient existence. */
  readonly messages?: { readonly receiver: MessageReceiver };
  readonly archives?: {
    readonly receiver: ArchiveReceiver;
    readonly store: ArchiveStore;
  };
  /** Missing policy denies incoming application operations. */
  readonly authorization?: AuthorizationHandler;
  readonly proofs?: ProofProvider;
  readonly routes?: AddressRouteProofProvider;
  readonly listener?: RuntimeListener;
  /** Bounded runtime defaults are documented in docs/using-library/runtime.md; invalid values fail construction. */
  readonly limits?: Partial<FederationLimits>;
}
export interface Federation {
  readonly addresses: AddressApi;
  readonly messages: MessageApi;
  readonly archives: ArchiveApi;
  readonly transfers: TransferApi;
  readonly limits: FederationLimits;
  start(options?: CallOptions): Promise<RuntimeStatus>;
  status(): RuntimeStatus;
  /** Drains within the deadline, preserves durable unfinished work, releases owned streams. */
  stop(options?: { readonly deadlineMs?: number }): Promise<void>;
}
