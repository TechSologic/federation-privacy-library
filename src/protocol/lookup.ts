import { onion } from "../address.js";
import { fail, integer } from "../errors.js";
import { messagePath, legacyMessagePath } from "./messages.js";
import { openAddressRouteAuthorization, type AddressRouteAuthorization } from "./addressRoutes.js";
import { validateSealedReceiveLookupValue } from "./lookupRecords.js";

export const gridPath = "/.well-known/unolock-grid/v1/";
// A 16 KiB sealed value expands to ~22 KiB inside its base64url JSON envelope.
export const lookupRequestMaxBytes = (path: string): number =>
  path === gridPath + "put-value" ? 32 * 1024 : 8192;
export const keyPath = "/.well-known/unolock-federation/v1/receive-address/public-key";
export const replicaLeaseMs = 24 * 60 * 60_000;
export interface LookupTarget {
  onionService: string;
  deliveryPath: string;
  priority: number;
}
export type LookupRecord = AddressRouteAuthorization;
export function object(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, any> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail("invalid-data", "Invalid protocol document");
  const value = input as Record<string, any>;
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  )
    fail("invalid-data", "Invalid protocol fields");
  return value;
}
export function json(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("invalid-data", "Invalid protocol JSON");
  }
}
export function base64(value: unknown, maxBytes: number): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil((maxBytes * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    fail("invalid-data", "Invalid encoded bytes");
  const bytes = Buffer.from(value, "base64url");
  if (!bytes.length || bytes.length > maxBytes || bytes.toString("base64url") !== value)
    fail("invalid-data", "Invalid encoded bytes");
  return bytes;
}
export function validateLookupEnvelope(encoded: string, addressHash: string): void {
  validateSealedReceiveLookupValue(json(base64(encoded, 16 * 1024)), addressHash);
}
export function decodeLookup(
  encoded: string,
  addressHash: string,
  validationFingerprint: string,
): LookupRecord {
  return openAddressRouteAuthorization(json(base64(encoded, 16 * 1024)), {
    addressHash,
    validationFingerprint,
  });
}
