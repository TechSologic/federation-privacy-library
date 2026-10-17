import { createHash, randomBytes } from "node:crypto";
import { hashAddress, onion } from "../address.js";
import { fail, integer } from "../errors.js";
import { messagePath, legacyMessagePath } from "./messages.js";

export const gridPath = "/.well-known/unolock-grid/v1/";
export const keyPath = "/.well-known/unolock-federation/v1/receive-address/public-key";
export const replicaLeaseMs = 24 * 60 * 60_000;
export interface LookupTarget {
  onionService: string;
  deliveryPath: string;
  priority: number;
}
export interface LookupRecord {
  type: "unolock.receive.lookup.v1";
  recordKey: string;
  targets: LookupTarget[];
  createdAt: number;
  recordNonce: string;
  recordCommitment: string;
}
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
export function newLookup(addressHash: string, endpoint: string): string {
  hashAddress(addressHash);
  onion(endpoint);
  const targets = [{ onionService: endpoint, deliveryPath: messagePath, priority: 0 }];
  const recordNonce = randomBytes(32).toString("base64url");
  const recordCommitment = createHash("sha256")
    .update(`${addressHash}\0${recordNonce}\0${JSON.stringify(targets)}`)
    .digest("base64url");
  return Buffer.from(
    JSON.stringify({
      type: "unolock.receive.lookup.v1",
      recordKey: addressHash,
      targets,
      createdAt: Date.now(),
      recordNonce,
      recordCommitment,
    }),
  ).toString("base64url");
}
export function decodeLookup(encoded: string, addressHash: string): LookupRecord {
  const parsed = json(base64(encoded, 4096));
  const v = object(
    parsed,
    ["type", "recordKey", "createdAt", "recordNonce", "recordCommitment"],
    ["targets", "primary"],
  );
  if (
    v.type !== "unolock.receive.lookup.v1" ||
    v.recordKey !== addressHash ||
    "targets" in v === "primary" in v
  )
    fail("invalid-data", "Invalid lookup record");
  integer(v.createdAt, 1);
  base64(v.recordNonce, 4096);
  base64(v.recordCommitment, 4096);
  const targets = v.targets ?? [v.primary];
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 8)
    fail("invalid-data", "Invalid lookup targets");
  const normalized: LookupTarget[] = targets.map((target) => {
    const t = object(target, ["onionService", "deliveryPath", "priority"]);
    onion(t.onionService);
    integer(t.priority, 0, 3);
    if (![messagePath, legacyMessagePath].includes(t.deliveryPath))
      fail("invalid-data", "Invalid delivery path");
    return { onionService: t.onionService, deliveryPath: t.deliveryPath, priority: t.priority };
  });
  // This commitment is protocol metadata, not a signature granting route authority.
  return {
    ...v,
    targets: normalized.sort(
      (a, b) => a.priority - b.priority || a.onionService.localeCompare(b.onionService),
    ),
  } as LookupRecord;
}
