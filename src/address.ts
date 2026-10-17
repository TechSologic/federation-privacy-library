import { createHash, randomBytes } from "node:crypto";
import type { AddressIdentity, AddressKeys, Destination, LocalAddress } from "./contracts.js";
import { fail, integer } from "./errors.js";
const pattern = /^ul3_([A-Za-z0-9_-]{32,64})\.([A-Za-z0-9_-]{22,64})\.([A-Za-z0-9_-]{22,64})$/;
export function fingerprint(key: string, validation = false): string {
  if (typeof key !== "string" || !key.length || Buffer.byteLength(key) > 8192)
    fail("invalid-data", "Invalid public key");
  return createHash("sha256")
    .update(
      validation
        ? "unolock-receive-address-v3-validation-key"
        : "unolock-receive-address-v2-public-key",
    )
    .update("\0")
    .update(key)
    .digest("base64url")
    .slice(0, 32);
}
export function validateAddress(address: string): boolean {
  return typeof address === "string" && pattern.test(address);
}
export async function deriveAddress(address: string): Promise<AddressIdentity> {
  const parsed = typeof address === "string" ? pattern.exec(address) : null;
  if (!parsed) fail("invalid-data", "A current receive address is required");
  return {
    addressHash: createHash("sha256")
      .update("unolock-receive-address-v2-secret\0")
      .update(parsed[1])
      .digest("hex"),
    encryptionFingerprint: parsed[2],
    validationFingerprint: parsed[3],
  };
}
export async function generateAddress(keys: { publicKey: string; validationKey: string }) {
  const address = `ul3_${randomBytes(32).toString("base64url")}.${fingerprint(keys.publicKey)}.${fingerprint(keys.validationKey, true)}`;
  return { address, identity: await deriveAddress(address) };
}
export function hashAddress(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    fail("invalid-data", "Invalid address hash");
  return value;
}
export async function destinationIdentity(destination: Destination): Promise<AddressIdentity> {
  if (typeof destination === "string") return deriveAddress(destination);
  hashAddress(destination?.addressHash);
  if (
    ![destination?.encryptionFingerprint, destination?.validationFingerprint].every(
      (v) => typeof v === "string" && /^[A-Za-z0-9_-]{32}$/.test(v),
    )
  )
    fail("invalid-data", "Invalid address commitment");
  return { ...destination };
}
export function verifyAddressKeys(identity: AddressIdentity, keys: AddressKeys): void {
  if (fingerprint(keys.publicKey) !== identity.encryptionFingerprint)
    fail("unauthorized", "Encryption key commitment mismatch");
  if (
    !Array.isArray(keys.validationKeys) ||
    !keys.validationKeys.length ||
    keys.validationKeys.length > 32
  )
    fail("invalid-data", "Invalid validation key set");
  const ids = new Set<number>();
  for (const key of keys.validationKeys) {
    integer(key.id, 0, 4_102_444_800);
    if (ids.has(key.id)) fail("invalid-data", "Duplicate validation key id");
    ids.add(key.id);
    fingerprint(key.validationKey, true);
  }
  if (
    !keys.validationKeys.some(
      (key) => fingerprint(key.validationKey, true) === identity.validationFingerprint,
    )
  )
    fail("unauthorized", "Validation key commitment mismatch");
}
export async function validateLocalAddress(record: LocalAddress): Promise<LocalAddress> {
  const copy = structuredClone(record);
  await destinationIdentity(copy.identity);
  verifyAddressKeys(copy.identity, copy.keys);
  if (typeof copy.enabled !== "boolean" || typeof copy.policy?.allowAttachments !== "boolean")
    fail("invalid-data", "Invalid address policy");
  integer(copy.policy.maxAttachmentBytes, 0, 5 * 1024 ** 3);
  if (copy.expiresAt !== undefined) integer(copy.expiresAt, 1);
  return copy;
}
export function onion(value: string): string {
  if (typeof value !== "string" || !/^http:\/\/[a-z2-7]{56}\.onion(?::[0-9]{1,5})?$/.test(value))
    fail("invalid-data", "A v3 onion HTTP endpoint is required");
  const url = new URL(value);
  if (url.port) integer(Number(url.port), 1, 65535);
  return value;
}
export function nodeId(endpoint: string): string {
  return createHash("sha256")
    .update(new URL(onion(endpoint)).hostname)
    .digest("hex");
}
