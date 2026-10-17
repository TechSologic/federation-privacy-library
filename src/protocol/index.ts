/** Encoding helpers only; signing keys and content encryption remain application-owned. */
export {
  document as protocolDocument,
  canonical as canonicalJsonBytes,
  gatewayLocator as archiveGatewayLocator,
} from "./archives.js";
