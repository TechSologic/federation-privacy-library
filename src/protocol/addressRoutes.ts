import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { fingerprint } from "../address.js";
import { FederationError } from "../errors.js";
import {
  normalizeReceiveLookupTargets,
  normalizeSha256HexAddressHash,
  validateSealedReceiveLookupValue,
  type ReceiveLookupTarget,
  type SealedReceiveLookupValue,
} from "./lookupRecords.js";
import {
  lookupArray,
  lookupInteger,
  lookupLiteral,
  lookupObject,
  lookupText,
  parseLookupDocument,
} from "./lookupValidation.js";

const base64urlPattern = /^[A-Za-z0-9_-]+$/;
const validationFingerprintPattern = /^[A-Za-z0-9_-]{32}$/;
const routeNonceBytes = 32;
const sealNonceBytes = 12;
const sealTagBytes = 16;
const mlDsa65PublicKeyBytes = 1952;
const mlDsa65SignatureBytes = 3309;
const routeClockSkewMs = 5 * 60_000;
export const addressRouteMaximumLifetimeMs = 48 * 60 * 60_000;

export interface AddressRouteAuthorizationInput {
  readonly type: "unolock.receive.route.v1";
  readonly recordKey: string;
  readonly targets: readonly ReceiveLookupTarget[];
  readonly issuedAt: number;
  /** Zero authorizes the original node for the address lifetime. Finite expiry
   * never permits replacing an already pinned node binding. */
  readonly expiresAt: number;
  readonly nonce: string;
  readonly validationKey: string;
}

export interface AddressRouteAuthorization extends AddressRouteAuthorizationInput {
  readonly signature: string;
}

function exactBase64url(value: unknown, bytes: number, name: string): Uint8Array {
  if (typeof value !== "string" || !base64urlPattern.test(value))
    throw new FederationError("invalid-data", `Invalid ${name}`);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== bytes || decoded.toString("base64url") !== value)
    throw new FederationError("invalid-data", `Invalid ${name}`);
  return decoded;
}

function parseTarget(input: unknown): ReceiveLookupTarget {
  const value = lookupObject(input, ["onionService", "deliveryPath", "priority"]);
  return normalizeReceiveLookupTargets([
    {
      onionService: lookupText(value.onionService),
      deliveryPath: lookupText(value.deliveryPath) as ReceiveLookupTarget["deliveryPath"],
      priority: lookupInteger(value.priority, 0, 3),
    },
  ])[0]!;
}

function normalizeAuthorizationInput(input: unknown): AddressRouteAuthorizationInput {
  return parseLookupDocument(() => {
    const value = lookupObject(input, [
      "type",
      "recordKey",
      "targets",
      "issuedAt",
      "expiresAt",
      "nonce",
      "validationKey",
    ]);
    const recordKey = normalizeSha256HexAddressHash(value.recordKey);
    const targets = normalizeReceiveLookupTargets(
      lookupArray(value.targets, 1, 8).map(parseTarget),
    );
    const issuedAt = lookupInteger(value.issuedAt, 1);
    // Zero is a standing authorization for this address on its original host.
    const expiresAt = lookupInteger(value.expiresAt, 0);
    const nonce = lookupText(value.nonce, 1, 64, base64urlPattern);
    const validationKey = lookupText(value.validationKey, 1, 8192, base64urlPattern);
    exactBase64url(nonce, routeNonceBytes, "route nonce");
    exactBase64url(validationKey, mlDsa65PublicKeyBytes, "route validation key");
    return {
      type: lookupLiteral(value.type, "unolock.receive.route.v1"),
      recordKey,
      targets,
      issuedAt,
      expiresAt,
      nonce,
      validationKey,
    };
  }, "Invalid authorized Receive Address route");
}

/** Canonical bytes a client signs with its Receive Address ML-DSA-65 key. */
export function addressRouteSigningBytes(input: AddressRouteAuthorizationInput): Uint8Array {
  const route = normalizeAuthorizationInput(input);
  return new TextEncoder().encode(
    JSON.stringify([
      "unolock.receive.route.authorization.v1",
      route.type,
      route.recordKey,
      route.targets,
      route.issuedAt,
      route.expiresAt,
      route.nonce,
      route.validationKey,
    ]),
  );
}

export function verifyAddressRouteAuthorization(
  input: unknown,
  expected: {
    readonly addressHash: string;
    readonly validationFingerprint: string;
    readonly now?: number;
  },
): AddressRouteAuthorization {
  const value = parseLookupDocument(
    () =>
      lookupObject(input, [
        "type",
        "recordKey",
        "targets",
        "issuedAt",
        "expiresAt",
        "nonce",
        "validationKey",
        "signature",
      ]),
    "Invalid authorized Receive Address route",
  );
  const { signature: submittedSignature, ...unsigned } = value;
  const route = normalizeAuthorizationInput(unsigned);
  const addressHash = normalizeSha256HexAddressHash(expected.addressHash);
  if (route.recordKey !== addressHash)
    throw new FederationError("unauthorized", "Route is bound to a different Receive Address");
  if (
    typeof expected.validationFingerprint !== "string" ||
    !validationFingerprintPattern.test(expected.validationFingerprint) ||
    fingerprint(route.validationKey, true) !== expected.validationFingerprint
  )
    throw new FederationError("unauthorized", "Route validation key commitment mismatch");
  const now = expected.now ?? Date.now();
  if (
    route.issuedAt > now + routeClockSkewMs ||
    (route.expiresAt !== 0 &&
      (route.expiresAt <= now ||
        route.expiresAt <= route.issuedAt ||
        route.expiresAt - route.issuedAt > addressRouteMaximumLifetimeMs))
  )
    throw new FederationError(
      "unauthorized",
      "Receive Address route is outside its validity window",
    );
  const signature = lookupText(submittedSignature, 1, 5000, base64urlPattern);
  const signatureBytes = exactBase64url(signature, mlDsa65SignatureBytes, "route signature");
  const publicKey = exactBase64url(
    route.validationKey,
    mlDsa65PublicKeyBytes,
    "route validation key",
  );
  let verified = false;
  try {
    verified = ml_dsa65.verify(signatureBytes, addressRouteSigningBytes(route), publicKey);
  } catch {
    verified = false;
  }
  if (!verified)
    throw new FederationError("unauthorized", "Receive Address route signature failed");
  return { ...route, signature };
}

function routeSealKey(validationFingerprint: string): Buffer {
  if (!validationFingerprintPattern.test(validationFingerprint))
    throw new FederationError("invalid-data", "Invalid route opening commitment");
  return createHash("sha256")
    .update("unolock-receive-address-route-seal-v1\0")
    .update(validationFingerprint)
    .digest();
}

function routeAad(addressHash: string): Buffer {
  return Buffer.from(
    `unolock.receive.lookup.sealed.v1\0${normalizeSha256HexAddressHash(addressHash)}`,
  );
}

/** Seal a verified client-signed route for replication by nodes that do not know the address. */
export function sealAddressRouteAuthorization(
  input: AddressRouteAuthorization,
  expected: {
    readonly addressHash: string;
    readonly validationFingerprint: string;
    readonly now?: number;
  },
): SealedReceiveLookupValue {
  const route = verifyAddressRouteAuthorization(input, expected);
  const nonce = randomBytes(sealNonceBytes);
  const aad = routeAad(route.recordKey);
  const cipher = createCipheriv("aes-256-gcm", routeSealKey(expected.validationFingerprint), nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(route), "utf8"), cipher.final()]);
  return {
    type: "unolock.receive.lookup.sealed.v1",
    recordKey: route.recordKey,
    cipherSuite: "AES-256-GCM",
    nonce: nonce.toString("base64url"),
    aad: aad.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

/** Open and verify a replicated route before any target is contacted or cached. */
export function openAddressRouteAuthorization(
  input: unknown,
  expected: {
    readonly addressHash: string;
    readonly validationFingerprint: string;
    readonly now?: number;
  },
): AddressRouteAuthorization {
  const sealed = validateSealedReceiveLookupValue(input, expected.addressHash);
  const nonce = exactBase64url(sealed.nonce, sealNonceBytes, "route seal nonce");
  const tag = exactBase64url(sealed.tag, sealTagBytes, "route seal tag");
  const aad = routeAad(expected.addressHash);
  if (sealed.aad !== aad.toString("base64url"))
    throw new FederationError("unauthorized", "Route seal context mismatch");
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      routeSealKey(expected.validationFingerprint),
      nonce,
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([
      decipher.update(exactBase64urlVariable(sealed.ciphertext, "route ciphertext")),
      decipher.final(),
    ]);
  } catch {
    throw new FederationError("unauthorized", "Receive Address route could not be opened");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
  } catch {
    throw new FederationError("invalid-data", "Invalid authorized Receive Address route");
  }
  return verifyAddressRouteAuthorization(parsed, expected);
}

function exactBase64urlVariable(value: unknown, name: string): Uint8Array {
  if (typeof value !== "string" || !base64urlPattern.test(value))
    throw new FederationError("invalid-data", `Invalid ${name}`);
  const bytes = Buffer.from(value, "base64url");
  if (!bytes.length || bytes.toString("base64url") !== value)
    throw new FederationError("invalid-data", `Invalid ${name}`);
  return bytes;
}

export function newAddressRouteNonce(): string {
  return randomBytes(routeNonceBytes).toString("base64url");
}
