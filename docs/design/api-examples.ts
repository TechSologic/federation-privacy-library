/**
 * Type-checkable design examples, not a runnable installation example.
 * All storage/proof implementations are supplied by the embedding application.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createFederation } from "./proposed-api.js";
import type {
  AddressIdentity, ArchiveInfo, ArchiveReference, ArchiveSource, ArchiveStore,
  ArchiveReceiveMetadata, AuthorizationHandler, ByteStream, CallOptions,
  DataSource, EncryptedMessage, Federation, FederationStorage,
  MessageMetadata, ProofProvider, SourceResolver, TorConfiguration, TransferListener,
  ByteRange,
} from "./proposed-api.js";

interface ApplicationMessageStorage {
  /** Takes durable custody, through an atomic local admission or a durable queue.
   * Exact repeats must not repeat application effects. Differing bytes conflict.
   */
  store(stream: ByteStream, metadata: MessageMetadata): Promise<void>;
}
interface ApplicationStaging {
  /** Atomically records the durable interval; partial failure leaves no completed interval. */
  write(stream: ByteStream, metadata: ArchiveReceiveMetadata): Promise<void>;
}
interface ApplicationArchiveSources {
  describe(sourceId: string): Promise<ArchiveInfo>;
  open(sourceId: string, options: CallOptions & { readonly range?: ByteRange }): Promise<ByteStream>;
  resolve(sourceId: string, options: CallOptions): Promise<DataSource<ArchiveInfo> | null>;
}

/** The node and managed service can each implement these objects differently. */
export function configureHost(input: {
  storage: FederationStorage;
  tor: TorConfiguration;
  messages: ApplicationMessageStorage;
  staging: ApplicationStaging;
  archives: ArchiveStore;
  sources: ApplicationArchiveSources;
  authorization: AuthorizationHandler;
  proofs: ProofProvider;
}): Federation {
  const sources: SourceResolver = {
    resolve: (sourceId, options) => input.sources.resolve(sourceId, options),
  };
  return createFederation({
    storage: input.storage,
    tor: input.tor,
    sources,
    messages: {
      receiver: {
        async receive(stream, metadata) {
          await input.messages.store(stream, metadata);
        },
      },
    },
    archives: {
      receiver: {
        async receive(stream, metadata) {
          await input.staging.write(stream, metadata);
        },
      },
      // This adapter must address the same staged bytes as input.staging.
      store: input.archives,
    },
    authorization: input.authorization,
    proofs: input.proofs,
  });
}

/** The caller has already encrypted these fields. The library supplies framing. */
export async function sendMessage(
  federation: Federation,
  destination: AddressIdentity,
  content: EncryptedMessage,
  listener: TransferListener,
) {
  const source = federation.messages.source(content);
  return federation.messages.send(destination, source, listener);
}

/** The underlying data may be a file, an in-memory object or remote storage. */
export async function sendArchive(
  federation: Federation,
  destination: AddressIdentity,
  archive: ArchiveReference,
  sourceId: string,
  data: ApplicationArchiveSources,
  listener: TransferListener,
) {
  const source: ArchiveSource = {
    sourceId,
    archive,
    expectedRevision: null,
    describe: () => data.describe(sourceId),
    open: options => data.open(sourceId, options),
  };
  return federation.archives.send(destination, source, listener);
}

/** Startup is explicit; importing or configuring does not open listeners or launch Tor. */
export async function startHost(federation: Federation) {
  return federation.start();
}

/** After restart, an operation is located by identity and gets a new observer. */
export async function observeExisting(
  federation: Federation,
  operationId: string,
  listener: TransferListener,
) {
  const transfer = await federation.transfers.get(operationId);
  if (!transfer) return null;
  const unsubscribe = transfer.listen(listener);
  return { transfer, unsubscribe };
}

/** Human-facing progress should use counts/states, not raw destinations or proofs. */
export function progressListener(report: (message: string) => void): TransferListener {
  return {
    onEvent(event) {
      if (event.type === "progress") {
        report(`${event.snapshot.bytesTransferred} of ${event.snapshot.totalBytes} encrypted bytes`);
      } else if (event.type === "completed" && event.result.kind === "message") {
        report("The remote endpoint accepted custody.");
      } else {
        report(event.snapshot.state);
      }
    },
  };
}
