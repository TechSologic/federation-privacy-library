import { createHash, createPublicKey, verify } from "node:crypto";
import type {
  ArchiveReference,
  ArchiveVersion,
  ProtocolDocument,
  TrustedAuthority,
} from "../contracts.js";
import { fail, integer } from "../errors.js";
import { base64, json, object } from "./lookup.js";
import { onion } from "../address.js";

export const archivePath = "/federation/v1/archive/";
export const archiveMaxBytes = 5 * 1024 ** 3 + 512 * 16;
export const partBytes = 8 * 1024 ** 2;
export function canonical(value: unknown): Uint8Array {
  const normalize = (input: any): any =>
    Array.isArray(input)
      ? input.map(normalize)
      : input && typeof input === "object"
        ? Object.fromEntries(
            Object.keys(input)
              .sort()
              .map((key) => [key, normalize(input[key])]),
          )
        : input;
  return Buffer.from(JSON.stringify(normalize(value)));
}
export const shaHex = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
export function document(value: unknown): ProtocolDocument {
  const encoded = canonical(value);
  if (encoded.length > 64 * 1024) fail("limit-exceeded", "Protocol document is too large");
  return { format: "unolock-json-v1", bytes: encoded };
}
export function readDocument(value: ProtocolDocument | undefined): any {
  if (!value) return {};
  if (value.format !== "unolock-json-v1" || value.bytes.length > 64 * 1024)
    fail("invalid-data", "Unsupported protocol document encoding");
  return json(value.bytes);
}
export function boundedText(value: unknown, max = 512): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > max ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    fail("invalid-data", "Invalid archive identifier");
  return value;
}
export function archiveReference(value: ArchiveReference): ArchiveReference {
  boundedText(value.id, 256);
  boundedText(value.locator, 4096);
  if (!/^[\x21-\x7e]+$/.test(value.id))
    fail("invalid-data", "Archive identifier must use the protocol character set");
  if (value.locator.startsWith("unodegw2_")) {
    const locator = object(json(base64(value.locator.slice(9), 4096)), [
      "type",
      "archiveID",
      "onionService",
    ]);
    if (
      locator.type !== "unolock.node.archive.gateway.locator.v2" ||
      locator.archiveID !== value.id
    )
      fail("invalid-data", "Archive locator identity mismatch");
    onion(locator.onionService);
  }
  return { ...value };
}
export function gatewayLocator(id: string, endpoint: string): string {
  boundedText(id, 256);
  onion(endpoint);
  return (
    "unodegw2_" +
    Buffer.from(
      JSON.stringify({
        type: "unolock.node.archive.gateway.locator.v2",
        archiveID: id,
        onionService: endpoint,
      }),
    ).toString("base64url")
  );
}
function verifySignature(
  payload: unknown,
  signature: unknown,
  authority: TrustedAuthority,
  keyId: unknown,
) {
  if (authority.keys.length > 32) fail("unauthorized", "Invalid trusted key set");
  const key = authority.keys.find((key) => key.keyId === keyId);
  if (!key) fail("unauthorized", "No trusted signing key");
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(base64(key.publicKey, 1024)),
      format: "der",
      type: "spki",
    });
    if (
      publicKey.asymmetricKeyType !== "ed25519" ||
      !verify(null, canonical(payload), publicKey, base64(signature, 64))
    )
      fail("unauthorized", "Archive signature verification failed");
  } catch {
    fail("unauthorized", "Archive signature verification failed");
  }
}
export function verifyRequestProof(
  value: unknown,
  authority: TrustedAuthority,
  operation: string,
  archiveID: string,
  request: unknown,
) {
  const p = object(value, [
    "type",
    "spaceAccessRef",
    "operation",
    "archiveID",
    "requestHash",
    "issuedAt",
    "expiresAt",
    "nonce",
    "signatureAlgorithm",
    "signature",
  ]);
  const binding = readDocument(authority.bindings);
  if (
    p.type !== "unolock.federation.archive-request.v1" ||
    p.signatureAlgorithm !== "Ed25519" ||
    p.operation !== operation ||
    p.archiveID !== archiveID ||
    p.requestHash !== shaHex(canonical(request)) ||
    p.spaceAccessRef !== (binding.spaceAccessRef ?? binding.spaceAuthorityId)
  )
    fail("unauthorized", "Archive proof scope mismatch");
  boundedText(p.spaceAccessRef);
  boundedText(p.signature);
  integer(p.issuedAt, 0);
  integer(p.expiresAt, 0);
  if (
    !/^[A-Za-z0-9_-]{22}$/.test(p.nonce) ||
    p.expiresAt < Date.now() ||
    p.issuedAt > Date.now() + 60_000 ||
    p.expiresAt < p.issuedAt ||
    p.expiresAt - p.issuedAt > 300_000
  )
    fail("unauthorized", "Archive proof is expired or invalid");
  const { signature, ...unsigned } = p;
  verifySignature(unsigned, signature, authority, binding.signingKeyId);
}
export function parsePointer(value: unknown, archiveId: string): Record<string, any> {
  const p = object(value, [
    "version",
    "archiveId",
    "contentCid",
    "contentHash",
    "pointerHash",
    "previousPointerHash",
    "previousContentHash",
    "sequence",
    "writerAccessId",
    "signingKeyId",
    "spaceAuthorityId",
    "spaceKeyEpochHash",
    "issuedAt",
    "signatureAlgorithm",
    "signature",
  ]);
  if (
    p.version !== 1 ||
    p.archiveId !== archiveId ||
    p.signatureAlgorithm !== "Ed25519" ||
    !/^sha256:[a-f0-9]{64}$/.test(p.contentHash) ||
    p.contentCid !==
      `uobj:v1:sha256:${Buffer.from(p.contentHash.slice(7), "hex").toString("base64url")}`
  )
    fail("invalid-data", "Invalid archive version");
  for (const name of [
    "archiveId",
    "pointerHash",
    "writerAccessId",
    "signingKeyId",
    "spaceAuthorityId",
    "spaceKeyEpochHash",
    "signature",
  ])
    boundedText(p[name]);
  if (
    typeof p.previousPointerHash !== "string" ||
    p.previousPointerHash.length > 128 ||
    typeof p.previousContentHash !== "string" ||
    (p.previousContentHash !== "" && !/^sha256:[a-f0-9]{64}$/.test(p.previousContentHash))
  )
    fail("invalid-data", "Invalid predecessor");
  integer(p.sequence, 1);
  integer(p.issuedAt, 0);
  const { signature: _signature, pointerHash, ...hashBody } = p;
  if (createHash("sha256").update(canonical(hashBody)).digest("base64url") !== pointerHash)
    fail("invalid-data", "Version hash mismatch");
  return p;
}
export function verifyPointer(
  value: unknown,
  archiveId: string,
  predecessor: string | null | undefined,
  authority: TrustedAuthority,
): ArchiveVersion {
  const p = parsePointer(value, archiveId);
  const binding = readDocument(authority.bindings);
  if (
    binding.canWrite !== true ||
    (predecessor !== undefined && p.previousPointerHash !== (predecessor ?? "")) ||
    ["writerAccessId", "signingKeyId", "spaceAuthorityId", "spaceKeyEpochHash"].some(
      (key) => binding[key] !== p[key],
    )
  )
    fail("unauthorized", "Version authority mismatch");
  const { signature, ...unsigned } = p;
  verifySignature(unsigned, signature, authority, p.signingKeyId);
  return {
    hash: p.pointerHash,
    predecessor: p.previousPointerHash || null,
    sequence: p.sequence,
    issuedAt: p.issuedAt,
    signed: document(p),
  };
}
