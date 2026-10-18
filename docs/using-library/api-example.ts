import {
  createFederation,
  generateAddress,
  type AddressIdentity,
  type AddressRouteProofProvider,
  type ArchiveInfo,
  type ArchiveReadReceiver,
  type ArchiveReference,
  type ArchiveSource,
  type AuthorizationHandler,
  type EncryptedMessage,
  type Federation,
  type FederationConfiguration,
  type LocalAddress,
  type MessageReceiver,
  type TorConfiguration,
} from "@techsologic/federation-privacy-library";

/** Application providers, implemented by the host rather than by this example. */
export interface MessagingProviders {
  /** Durable atomic address/state/lease/commit capabilities, not a memory store. */
  readonly storage: FederationConfiguration["storage"];
  /** A separately operated Tor process forwards this onion service to listen. */
  readonly tor: TorConfiguration;
  readonly authorization: AuthorizationHandler;
  /** Bridge exact route bytes to the client that owns the validation signing key. */
  readonly routes: AddressRouteProofProvider;
  /** Consume the full stream, durably enqueue by deliveryId, then resolve.
   * Exact repeated callbacks must resolve without duplicating application effects.
   */
  readonly inbox: MessageReceiver;
}

/** Host startup. Keep this instance alive while the application serves requests. */
export async function startMessagingNode(providers: MessagingProviders): Promise<Federation> {
  const federation = createFederation({
    storage: providers.storage,
    tor: providers.tor,
    handlers: {
      authorization: providers.authorization,
      messages: providers.inbox,
      routes: providers.routes,
    },
  });
  try {
    await federation.start();
    return federation;
  } catch (error) {
    await federation.stop();
    throw error;
  }
}

/** Receiving CLIENT: public keys come from your application's crypto protocol.
 * Keep private keys client-side. This utility does not create encryption keys.
 */
export async function prepareReceiveAddress(publicKey: string, validationKey: string) {
  const { address, identity } = await generateAddress({ publicKey, validationKey });
  const registration: LocalAddress = {
    identity,
    keys: { publicKey, validationKeys: [{ id: 1, validationKey }] },
    policy: { allowAttachments: false, maxAttachmentBytes: 0 },
    enabled: true,
  };
  // Send registration to the host. Share address privately with sending clients;
  // do not persist the full address in server-side federation state or logs.
  return { address, registration };
}

/** Receiving HOST: only public registration data crosses this boundary. */
export async function registerReceiveAddress(federation: Federation, registration: LocalAddress) {
  // Registration persists locally and queues publication; visibility is asynchronous.
  return federation.addresses.register(registration);
}

/** Sending HOST: the client derives destination from the privately shared address,
 * looks up address-bound recipient keys, and encrypts/signs BEFORE this call.
 * The receiving application validates that signature after decryption; the
 * federation library deliberately treats the sealed header as opaque.
 * Persist operationId + destination + exact encryptedMessage in your outbox first.
 */
export async function queueEncryptedMessage(
  federation: Federation,
  destination: AddressIdentity,
  encryptedMessage: EncryptedMessage,
  operationId: string,
) {
  // Encodes the protocol envelope; it does not encrypt the message.
  const source = federation.messages.source(encryptedMessage);
  return federation.messages.send(destination, source, undefined, { operationId });
}

/** Status request, including after restart: use the persisted operationId. */
export async function waitForMessageCustody(
  federation: Federation,
  operationId: string,
  signal: AbortSignal,
) {
  const transfer = await federation.transfers.get(operationId);
  if (!transfer) throw new Error("Transfer is absent or its retention period has ended");
  // A timeout aborts this wait, not the delivery. Use transfer.cancel() to cancel.
  const outcome = await transfer.wait({ signal });
  switch (outcome.status) {
    case "completed":
      // Endpoint custody, not recipient processing, decryption, or a read receipt.
      return outcome.result;
    case "failed":
      throw new Error(`Transfer failed: ${outcome.failure.code}`);
    case "cancelled":
      throw new Error("Transfer was cancelled");
  }
}

/** Archive-capable host: also configure storage.archives + storage.sources and
 * handlers.archives + client-signed proofs alongside authorization.
 * source.describe() returns ciphertext length + SHA-256 (unpadded base64url).
 * source.open({ range, signal }) reopens the exact immutable ciphertext interval.
 */
export async function uploadEncryptedArchive(
  federation: Federation,
  destination: AddressIdentity,
  source: ArchiveSource,
  operationId: string,
  signal: AbortSignal,
) {
  const transfer = await federation.archives.send(destination, source, undefined, { operationId });
  const outcome = await transfer.wait({ signal });
  if (outcome.status !== "completed" || outcome.result.kind !== "archive-send") {
    throw new Error(`Archive upload ended with ${outcome.status}`);
  }
  // A mutable upload may be staged: publish it separately with commitVersion()
  // using a client-signed successor and the expected predecessor.
  return outcome.result;
}

/** Download using length/digest from trusted application metadata.
 * The receiver stages bytes and exposes them only after verified completion.
 */
export async function readEncryptedArchive(
  federation: Federation,
  destination: AddressIdentity,
  archive: ArchiveReference,
  expectedInfo: ArchiveInfo,
  receiver: ArchiveReadReceiver,
  operationId: string,
  signal: AbortSignal,
) {
  const transfer = await federation.archives.read(destination, archive, receiver, undefined, {
    operationId,
    expectedInfo,
  });
  return transfer.wait({ signal });
}

/** Shutdown: close application admission, then stop, then close provider stores. */
export async function stopMessagingNode(federation: Federation): Promise<void> {
  await federation.stop();
}
