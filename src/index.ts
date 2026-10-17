export type * from "./contracts.js";
export { generateAddress, deriveAddress, validateAddress } from "./address.js";
export { FederationError } from "./errors.js";
import type { Federation, FederationConfiguration } from "./contracts.js";
import { FederationRuntime } from "./runtime.js";
import { torConnector } from "./transport.js";
/** Uses a separately operated Tor process; never falls back to direct networking. */
export function createFederation(config: FederationConfiguration): Federation {
  return new FederationRuntime(config, torConnector(config.tor));
}
