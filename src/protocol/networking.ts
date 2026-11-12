import { isIP } from "node:net";
import { fail, integer } from "../errors.js";
import { validateFederationOnionService } from "./lookupRecords.js";
import { lookupObject, lookupText, lookupBoolean, lookupLiteral } from "./lookupValidation.js";

/** A separate capability protocol: legacy signed Receive Address routes never change. */
export const federationNetworkingPath = "/.well-known/unolock-federation/v1/networking";
export const federationDirectPathPrefix = "/federation-direct";
export const federationNetworkingLeaseMs = 5 * 60_000;
export const federationNetworkingMaxBytes = 4096;

export interface FederationNetworkingDescriptor {
  readonly type: "unolock.federation.networking.v1";
  readonly onionService: string;
  readonly enabled: boolean;
  readonly directOrigin?: string;
  readonly challenge: string;
  readonly expiresAt: number;
}

export function normalizeFederationDirectOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 || value !== value.trim())
    fail("invalid-data", "Invalid direct federation origin");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("invalid-data", "Invalid direct federation origin");
  }
  const host = url.hostname;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    isIP(host) ||
    host.startsWith("[") ||
    host.endsWith(".") ||
    !host.includes(".") ||
    host.length > 253 ||
    !host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    /(?:^|\.)(?:onion|localhost|local|internal)$/.test(host) ||
    host.endsWith(".home.arpa")
  )
    fail("invalid-data", "Direct federation requires a public HTTPS domain origin");
  if (url.port) integer(Number(url.port), 1, 65535);
  return url.origin;
}

export function federationNetworkingChallenge(input: unknown): string {
  const value = lookupObject(input, ["type", "challenge"]);
  lookupLiteral(value.type, "unolock.federation.networking.request.v1");
  return lookupText(value.challenge, 43, 43, /^[A-Za-z0-9_-]{43}$/);
}

/** Shape and freshness only. Trust requires reading through the selected onion endpoint. */
export function validateFederationNetworkingDescriptor(
  input: unknown,
  expected: { readonly challenge: string; readonly onionService?: string; readonly now?: number },
): FederationNetworkingDescriptor {
  const value = lookupObject(
    input,
    ["type", "onionService", "enabled", "challenge", "expiresAt"],
    ["directOrigin"],
  );
  lookupLiteral(value.type, "unolock.federation.networking.v1");
  const onionService = validateFederationOnionService(value.onionService);
  const enabled = lookupBoolean(value.enabled);
  const challenge = lookupText(value.challenge, 43, 43, /^[A-Za-z0-9_-]{43}$/);
  const now = expected.now ?? Date.now();
  const expiresAt = integer(value.expiresAt as number, now + 1, now + federationNetworkingLeaseMs);
  if (
    challenge !== expected.challenge ||
    (expected.onionService !== undefined && onionService !== expected.onionService)
  )
    fail("unauthorized", "Federation networking identity or challenge mismatch");
  if (enabled !== (value.directOrigin !== undefined))
    fail("invalid-data", "Federation direct capability does not match its origin");
  return {
    type: "unolock.federation.networking.v1",
    onionService,
    enabled,
    challenge,
    expiresAt,
    ...(enabled ? { directOrigin: normalizeFederationDirectOrigin(value.directOrigin) } : {}),
  };
}
