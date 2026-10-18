// Adapted from UnoLock node; see NOTICE.md. SPDX-License-Identifier: AGPL-3.0-only
import { FederationError } from "../errors.js";
import {
  lookupObject,
  lookupText,
  lookupInteger,
  lookupLiteral,
  lookupArray,
  parseLookupDocument,
} from "./lookupValidation.js";

export const ADDRESS_HASH_SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

const base64urlPattern = /^[A-Za-z0-9_-]+$/;
const onionServicePattern = /^http:\/\/[a-z2-7]{56}\.onion(?::[0-9]{1,5})?$/;
// A sealed ML-DSA-65 route contains a 1,952-byte key and 3,309-byte signature.
export const MAX_LOOKUP_VALUE_BYTES = 16 * 1024;
export const MAX_RECEIVE_LOOKUP_TARGETS = 8;

export const federationDeliveryPaths = [
  "/federation/v1/message/receive",
  "/federation/message/receive",
] as const;

export type FederationDeliveryPath = (typeof federationDeliveryPaths)[number];

export const federationReceiveAddressPublicKeyPath =
  "/.well-known/unolock-federation/v1/receive-address/public-key";

export type AddressFormat = "eyes-v1-21char" | "unolock-ra-v1";
export type AddressHashSuite = "sha256-hex" | "blake3-256-base64url";

export interface AddressHashDescriptor {
  addressHash: string;
  addressFormat: AddressFormat;
  hashSuite: AddressHashSuite;
}

/** A peer hint, not a verified identity or proof of liveness. Hosts may extend it. */
export interface FederationLookupPeer {
  onionService: string;
  routingId?: string;
}

export interface FederationLookupValue {
  addressHash: string;
  lookupValue: Uint8Array;
  storedAt: number;
}

export interface ReceiveLookupTarget {
  onionService: string;
  deliveryPath: FederationDeliveryPath;
  priority: number;
}

export interface ReceiveLookupRecordTargets {
  type: "unolock.receive.lookup.v1";
  recordKey: string;
  targets: ReceiveLookupTarget[];
  createdAt: number;
  recordNonce: string;
  recordCommitment: string;
}
export type ReceiveLookupRecordPlaintext =
  | ReceiveLookupRecordTargets
  | (Omit<ReceiveLookupRecordTargets, "targets"> & { primary: ReceiveLookupTarget });
export interface SealedReceiveLookupValue {
  type: "unolock.receive.lookup.sealed.v1";
  recordKey: string;
  cipherSuite: "AES-256-GCM";
  nonce: string;
  aad: string;
  ciphertext: string;
  tag: string;
}

function parseTarget(input: unknown): ReceiveLookupTarget {
  const v = lookupObject(input, ["onionService", "deliveryPath", "priority"]);
  const deliveryPath = lookupText(v.deliveryPath);
  if (!federationDeliveryPaths.includes(deliveryPath as FederationDeliveryPath))
    throw new FederationError("invalid-data", "Invalid delivery path");
  return {
    onionService: lookupText(v.onionService, 1, Infinity, onionServicePattern),
    deliveryPath: deliveryPath as FederationDeliveryPath,
    priority: lookupInteger(v.priority, 0, 3),
  };
}

function parsePlaintext(input: unknown): ReceiveLookupRecordPlaintext {
  const v = lookupObject(
    input,
    ["type", "recordKey", "createdAt", "recordNonce", "recordCommitment"],
    ["targets", "primary"],
  );
  // The historical wire format accepts exactly one routing representation.
  const hasTargets = "targets" in v;
  if (hasTargets === "primary" in v)
    throw new FederationError("invalid-data", "Invalid lookup targets");
  const common = {
    type: lookupLiteral(v.type, "unolock.receive.lookup.v1"),
    recordKey: lookupText(v.recordKey),
    createdAt: lookupInteger(v.createdAt, 1),
    recordNonce: lookupText(v.recordNonce, 1, Infinity, base64urlPattern),
    recordCommitment: lookupText(v.recordCommitment, 1, Infinity, base64urlPattern),
  };
  return hasTargets
    ? { ...common, targets: lookupArray(v.targets, 1, MAX_RECEIVE_LOOKUP_TARGETS).map(parseTarget) }
    : { ...common, primary: parseTarget(v.primary) };
}

function parseSealed(input: unknown): SealedReceiveLookupValue {
  const v = lookupObject(input, [
    "type",
    "recordKey",
    "cipherSuite",
    "nonce",
    "aad",
    "ciphertext",
    "tag",
  ]);
  return {
    type: lookupLiteral(v.type, "unolock.receive.lookup.sealed.v1"),
    recordKey: lookupText(v.recordKey),
    cipherSuite: lookupLiteral(v.cipherSuite, "AES-256-GCM"),
    nonce: lookupText(v.nonce, 1, Infinity, base64urlPattern),
    aad: lookupText(v.aad, 1, Infinity, base64urlPattern),
    ciphertext: lookupText(v.ciphertext, 1, Infinity, base64urlPattern),
    tag: lookupText(v.tag, 1, Infinity, base64urlPattern),
  };
}

export function normalizeSha256HexAddressHash(value: unknown): string {
  if (typeof value !== "string") {
    throw new FederationError("invalid-data", "addressHash must be a SHA-256 receive address hash");
  }
  const normalized = value.trim().toLowerCase();
  if (!ADDRESS_HASH_SHA256_HEX_PATTERN.test(normalized)) {
    throw new FederationError("invalid-data", "addressHash must be a SHA-256 receive address hash");
  }
  return normalized;
}

export function validateFederationOnionService(value: unknown): string {
  if (typeof value !== "string" || !onionServicePattern.test(value)) {
    throw new FederationError(
      "invalid-data",
      "Federation peer must be an http v3 onion service URL",
    );
  }
  return value;
}

export function validateLookupValueBytes(value: Uint8Array): Uint8Array {
  if (value.byteLength === 0 || value.byteLength > MAX_LOOKUP_VALUE_BYTES) {
    throw new FederationError("invalid-data", "Receive Address lookup value size is invalid");
  }
  return value;
}

export function validateAddressHashDescriptor(input: AddressHashDescriptor): AddressHashDescriptor {
  if (input.addressFormat === "eyes-v1-21char" && input.hashSuite !== "sha256-hex") {
    throw new FederationError("invalid-data", "Address hash suite does not match address format");
  }
  if (input.addressFormat === "unolock-ra-v1" && input.hashSuite !== "blake3-256-base64url") {
    throw new FederationError("invalid-data", "Address hash suite does not match address format");
  }

  if (input.hashSuite === "sha256-hex") {
    return {
      ...input,
      addressHash: normalizeSha256HexAddressHash(input.addressHash),
    };
  }

  if (!base64urlPattern.test(input.addressHash) || input.addressHash.length < 32) {
    throw new FederationError(
      "invalid-data",
      "addressHash must be a base64url receive address hash",
    );
  }

  return input;
}

export function validateReceiveLookupRecordPlaintext(
  input: unknown,
  expectedAddressHash: string,
): ReceiveLookupRecordTargets {
  const parsed = parseLookupDocument(
    () => parsePlaintext(input),
    "Invalid federated Receive Address lookup record",
  );
  if (parsed.recordKey !== expectedAddressHash) {
    throw new FederationError(
      "invalid-data",
      "Lookup record key does not match receive address hash",
    );
  }
  const targets = "targets" in parsed ? parsed.targets : [parsed.primary];
  return {
    type: parsed.type,
    recordKey: parsed.recordKey,
    targets: normalizeReceiveLookupTargets(targets),
    createdAt: parsed.createdAt,
    recordNonce: parsed.recordNonce,
    recordCommitment: parsed.recordCommitment,
  };
}

export function validateSealedReceiveLookupValue(
  input: unknown,
  expectedAddressHash: string,
): SealedReceiveLookupValue {
  const parsed = parseLookupDocument(
    () => parseSealed(input),
    "Invalid federated Receive Address lookup record",
  );
  if (parsed.recordKey !== expectedAddressHash) {
    throw new FederationError(
      "invalid-data",
      "Sealed lookup record key does not match receive address hash",
    );
  }
  return parsed;
}

export function encodeLookupValue(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export function decodeLookupValue(value: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(value));
}

export function normalizeReceiveLookupTargets(
  targets: ReceiveLookupTarget[],
): ReceiveLookupTarget[] {
  if (
    !Array.isArray(targets) ||
    targets.length === 0 ||
    targets.length > MAX_RECEIVE_LOOKUP_TARGETS
  ) {
    throw new FederationError("invalid-data", "Receive Address lookup target count is invalid");
  }
  const seen = new Set<string>();
  const normalized: ReceiveLookupTarget[] = [];
  for (const target of targets) {
    const onionService = validateFederationOnionService(target.onionService);
    if (!federationDeliveryPaths.includes(target.deliveryPath)) {
      throw new FederationError(
        "invalid-data",
        "Receive Address lookup target delivery path is invalid",
      );
    }
    if (!Number.isInteger(target.priority) || target.priority < 0 || target.priority > 3) {
      throw new FederationError(
        "invalid-data",
        "Receive Address lookup target priority is invalid",
      );
    }
    const key = `${onionService}\0${target.deliveryPath}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({
      onionService,
      deliveryPath: target.deliveryPath,
      priority: target.priority,
    });
  }
  if (normalized.length === 0) {
    throw new FederationError("invalid-data", "Receive Address lookup target count is invalid");
  }
  return normalized.sort(
    (left, right) =>
      left.priority - right.priority ||
      left.onionService.localeCompare(right.onionService) ||
      left.deliveryPath.localeCompare(right.deliveryPath),
  );
}
