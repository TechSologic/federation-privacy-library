/** Encoding helpers only; signing keys and content encryption remain application-owned. */
export {
  document as protocolDocument,
  canonical as canonicalJsonBytes,
  gatewayLocator as archiveGatewayLocator,
} from "./archives.js";

/** Existing message wire format and custody response; no recipient authority. */
export {
  encodeMessage,
  decodeMessage,
  messageMaxBytes,
  messagePath,
  legacyMessagePath,
  acceptance as messageAcceptance,
  isAcceptance as isMessageAcceptance,
} from "./messages.js";

/** Incremental lookup protocol adoption; hosts retain transport, policy, and persistence. */
export * from "./lookupRecords.js";
export * from "./addressRoutes.js";
export * from "./lookupRouting.js";
export type {
  FederationLookupRpcHttpTransport,
  FederationReceiveAddressPublicKey,
} from "./lookupRpcClient.js";
