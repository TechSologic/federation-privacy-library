/** Public configuration: providers supply effects; the facade owns orchestration. */
import type * as C from "./contracts.js";
import type {
  LookupStorage,
  PublicationStorage,
  ClaimedPublicationStorage,
} from "./host/storage.js";
import type { FederationDeliveryQueue } from "./delivery/queue.js";
import type { FederationDeliveryRoutingCache } from "./delivery/targetResolver.js";
import type {
  FederationDeliveryStatusSink,
  FederationDeliveryProcessSummary,
} from "./delivery/coordinator.js";
import type { FederationTransport } from "./delivery/transport.js";
import type { FederationLookupRpcHttpTransport } from "./protocol/lookupRpcClient.js";
import type { FederationLookupPublishSummary } from "./host/lookup.js";
import type { DhtMaintenanceSummary } from "./dht/maintenance.js";

/** Atomic runtime state and existing host queues are independent capabilities.
 * Supply all three atomic-state capabilities together, or none. Never attach
 * both engines to the same jobs. Providers own durability and bounded retention.
 */
export type FederationStorage = (
  | C.FederationStorage
  | {
      readonly addresses?: never;
      readonly state?: never;
      readonly lease?: never;
      readonly commit?: never;
    }
) & {
  readonly lookup?: LookupStorage;
  readonly publications?: PublicationStorage | ClaimedPublicationStorage;
  readonly delivery?: FederationDeliveryQueue;
  readonly routing?: FederationDeliveryRoutingCache;
  readonly archives?: C.ArchiveStore;
  readonly sources?: C.SourceResolver;
};

export type FederationEvent =
  | { readonly type: "runtime"; readonly status: C.RuntimeStatus }
  | { readonly type: "delivery"; readonly summary: FederationDeliveryProcessSummary }
  | { readonly type: "delivery-wake"; readonly queued: number }
  | { readonly type: "publication"; readonly summary: FederationLookupPublishSummary }
  | { readonly type: "discovery"; readonly summary: DhtMaintenanceSummary }
  | { readonly type: "error"; readonly operation: "delivery" | "publication" | "discovery" };

/** Durable handlers are awaited. Events are bounded, best-effort diagnostics. */
export interface FederationHandlers {
  readonly messages?: C.MessageReceiver;
  readonly archives?: C.ArchiveReceiver;
  readonly authorization?: C.AuthorizationHandler;
  readonly proofs?: C.ProofProvider;
  readonly routes?: C.AddressRouteProofProvider;
  readonly deliveryStatus?: FederationDeliveryStatusSink;
  isAddressActive?(addressHash: string): Promise<boolean>;
  /** Host-owned eligibility sweep, before a publication round. No federation I/O required. */
  preparePublications?(options: C.CallOptions & { readonly limit: number }): Promise<void>;
  onEvent?(event: FederationEvent): void | Promise<void>;
}

/** Existing hosts inject bounded Tor I/O. Omit this to use the runtime Tor connector. */
export interface FederationTransportProvider {
  readonly lookup?: FederationLookupRpcHttpTransport;
  readonly delivery?: FederationTransport;
}

export interface FederationConfiguration {
  readonly storage: FederationStorage;
  readonly handlers?: FederationHandlers;
  readonly transport?: FederationTransportProvider;
  /** Required for the built-in listener; existing hosts may provide only identity/seeds. */
  readonly tor?: Partial<C.TorConfiguration>;
  /** Limits for atomic runtime capabilities; existing host queue policy is preserved. */
  readonly limits?: Partial<C.FederationLimits>;
  readonly scheduling?: {
    readonly delivery?: boolean;
    readonly discovery?: boolean;
    readonly publication?: boolean;
    readonly intervalMs?: number;
    readonly batchSize?: number;
  };
}

export type {
  LookupStorage,
  LookupPinStorage,
  PublicationStorage,
  PublicationClaim,
  ClaimedPublicationStorage,
} from "./host/storage.js";
export type {
  FederationDeliveryQueue,
  FederationQueuedDeliveryRecord,
  FederationDeliveryQueueStatus,
} from "./delivery/queue.js";
export type {
  FederationDeliveryRequest,
  FederationDeliveryResult,
  FederationDeliveryTargetUpdate,
  FederationTransport,
} from "./delivery/transport.js";
export type {
  FederationDeliveryTarget,
  FederationDeliveryTargetResolution,
  FederationDeliveryProcessSummary,
  FederationDeliveryStatusSink,
} from "./delivery/coordinator.js";
export type { FederationDeliveryRoutingCache } from "./delivery/targetResolver.js";
export type {
  FederationLookupPeer,
  FederationLookupValue,
  ReceiveLookupTarget,
  FederationDeliveryPath,
  AddressFormat,
  AddressHashSuite,
  AddressHashDescriptor,
  ReceiveLookupRecordPlaintext,
  SealedReceiveLookupValue,
} from "./protocol/lookupRecords.js";
export type {
  AddressRouteAuthorization,
  AddressRouteAuthorizationInput,
} from "./protocol/addressRoutes.js";
export type {
  FederationReceiveAddressPublicKey,
  FederationLookupRpcHttpTransport,
} from "./protocol/lookupRpcClient.js";
export type { FederationLookupResolution, FederationLookupPublishSummary } from "./host/lookup.js";
export type { DhtContact, DhtRoutingEntry, DhtBucketSnapshot } from "./dht/routingTable.js";
