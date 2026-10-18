// Adapted from UnoLock node; see NOTICE.md. SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import { FederationError } from "../errors.js";
import type { FederationLookupPeer } from "./lookupRecords.js";
import {
  ADDRESS_HASH_SHA256_HEX_PATTERN,
  validateFederationOnionService,
} from "./lookupRecords.js";

export const FEDERATION_ROUTING_ID_BYTES = 32;

const base64urlPattern = /^[A-Za-z0-9_-]+$/;

export function deriveFederationRoutingId(onionService: string): string {
  const normalized = validateFederationOnionService(onionService);
  return createHash("sha256").update(new URL(normalized).hostname).digest("base64url");
}

export function normalizeFederationLookupPeer(peer: FederationLookupPeer): FederationLookupPeer {
  const onionService = validateFederationOnionService(peer.onionService);
  return { ...peer, onionService, routingId: deriveFederationRoutingId(onionService) };
}

export function routingKeyToBytes(value: string): Buffer {
  if (typeof value !== "string") {
    throw new FederationError("invalid-data", "Federation routing key is invalid");
  }
  const normalized = value.trim();
  if (ADDRESS_HASH_SHA256_HEX_PATTERN.test(normalized.toLowerCase())) {
    return Buffer.from(normalized.toLowerCase(), "hex");
  }
  if (!base64urlPattern.test(normalized)) {
    throw new FederationError("invalid-data", "Federation routing key is invalid");
  }
  const decoded = Buffer.from(normalized, "base64url");
  if (decoded.byteLength !== FEDERATION_ROUTING_ID_BYTES) {
    throw new FederationError("invalid-data", "Federation routing key is invalid");
  }
  return decoded;
}
