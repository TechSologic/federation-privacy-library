// Adapted from UnoLock node; see NOTICE.md. SPDX-License-Identifier: AGPL-3.0-only
import { FederationError } from "../errors.js";
import {
  lookupObject,
  lookupText,
  lookupInteger,
  lookupLiteral,
  lookupBoolean,
  lookupArray,
  parseLookupDocument,
} from "./lookupValidation.js";
import {
  type FederationLookupPeer,
  type FederationLookupValue,
  federationReceiveAddressPublicKeyPath,
  normalizeSha256HexAddressHash,
  validateFederationOnionService,
  validateLookupValueBytes,
  MAX_LOOKUP_VALUE_BYTES,
} from "./lookupRecords.js";
import { normalizeFederationLookupPeer, routingKeyToBytes } from "./lookupRouting.js";
import { DhtAdmission, DhtCapacityError } from "../dht/admission.js";
/** Legacy wire metadata only. Parsing does not verify a signature or grant authority. */
export interface FederationCustodyDelegation {
  type: "unolock.federation.custody-delegation.v1";
  addressHash: string;
  validationKey: string;
  custodyKey: string;
  signature: string;
}

// Shared by every client instance loaded from this package instance, including maintenance.
const outboundDhtAdmission = new DhtAdmission(32);

/** Production adapters must use Tor SOCKS, bound response bytes/time, honor cancellation,
 * and reject redirects. The client never opens sockets, logs routes, or persists data. */
export interface FederationLookupRpcHttpTransport {
  postJson(
    peerOnionService: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export interface FederationLookupRpcClientOptions {
  transport: FederationLookupRpcHttpTransport;
  localOnionService?: string;
}

export interface FederationReceiveAddressPublicKey {
  custodyDelegation?: FederationCustodyDelegation;
  publicKey: string;
  validationKeys: { id: number; validationKey: string }[];
  allowAttachments: boolean;
  maxAttachmentBytes: number;
}

const maxFederatedAttachmentBytes = 5 * 1024 * 1024 * 1024;
const maxFederatedValidationKeyId = 4_102_444_800;
const base64urlPattern = /^[A-Za-z0-9_-]+$/;

function parsePingResponse(input: unknown) {
  const v = lookupObject(input, ["type", "ok", "checkedAt"]);
  lookupLiteral(v.type, "unolock.grid.ping.response.v1");
  return { ok: lookupLiteral(v.ok, true), checkedAt: lookupInteger(v.checkedAt, 1) };
}
function parseFindValueResponse(input: unknown) {
  const v = lookupObject(input, ["type", "found", "addressHash"], ["lookupValue", "storedAt"]);
  lookupLiteral(v.type, "unolock.grid.findValue.response.v1");
  const addressHash = lookupText(v.addressHash, 1, 128);
  if (!lookupBoolean(v.found)) {
    lookupObject(input, ["type", "found", "addressHash"]);
    return { found: false as const, addressHash };
  }
  return {
    found: true as const,
    addressHash,
    lookupValue: lookupText(
      v.lookupValue,
      1,
      Math.ceil((MAX_LOOKUP_VALUE_BYTES * 4) / 3),
      base64urlPattern,
    ),
    storedAt: lookupInteger(v.storedAt, 1),
  };
}
function parsePutValueResponse(input: unknown) {
  const v = lookupObject(input, ["type", "stored", "addressHash", "storedAt"]);
  lookupLiteral(v.type, "unolock.grid.putValue.response.v1");
  lookupLiteral(v.stored, true);
  return { addressHash: lookupText(v.addressHash, 1, 128), storedAt: lookupInteger(v.storedAt, 1) };
}
function parseFindNodeResponse(input: unknown) {
  const v = lookupObject(input, ["type", "peers"]);
  lookupLiteral(v.type, "unolock.grid.findNode.response.v1");
  return {
    peers: lookupArray(v.peers, 0, 64).map((input) => {
      const peer = lookupObject(input, ["onionService"]);
      return { onionService: lookupText(peer.onionService, 1, 128) };
    }),
  };
}
function parseCustodyDelegation(input: unknown): FederationCustodyDelegation {
  const v = lookupObject(input, [
    "type",
    "addressHash",
    "validationKey",
    "custodyKey",
    "signature",
  ]);
  return {
    type: lookupLiteral(v.type, "unolock.federation.custody-delegation.v1"),
    addressHash: lookupText(v.addressHash, 64, 64, /^[a-f0-9]{64}$/),
    validationKey: lookupText(v.validationKey, 2603, 2603, base64urlPattern),
    custodyKey: lookupText(v.custodyKey, 2603, 2603, base64urlPattern),
    signature: lookupText(v.signature, 4412, 4412, base64urlPattern),
  };
}
function parsePublicKeyResponse(input: unknown) {
  const v = lookupObject(
    input,
    ["type", "found", "addressHash"],
    ["custodyDelegation", "publicKey", "validationKeys", "allowAttachments", "maxAttachmentBytes"],
  );
  lookupLiteral(v.type, "unolock.receiveAddress.publicKey.response.v1");
  const addressHash = lookupText(v.addressHash, 1, 128);
  if (!lookupBoolean(v.found)) {
    lookupObject(input, ["type", "found", "addressHash"]);
    return { found: false as const, addressHash };
  }
  return {
    found: true as const,
    addressHash,
    custodyDelegation:
      v.custodyDelegation === undefined ? undefined : parseCustodyDelegation(v.custodyDelegation),
    publicKey: lookupText(v.publicKey, 1, 8192),
    validationKeys: lookupArray(v.validationKeys === undefined ? [] : v.validationKeys, 0, 32).map(
      (input) => {
        const key = lookupObject(input, ["id", "validationKey"]);
        return {
          id: lookupInteger(key.id, 0, maxFederatedValidationKeyId),
          validationKey: lookupText(key.validationKey, 1, 8192),
        };
      },
    ),
    allowAttachments: lookupBoolean(v.allowAttachments),
    maxAttachmentBytes: lookupInteger(v.maxAttachmentBytes, 0, maxFederatedAttachmentBytes),
  };
}

/** Bounded lookup wire client. Results are untrusted hints/metadata, never recipient authority.
 * Address key commitments and final application authorization must still be verified. */
export class FederationLookupRpcClient {
  private readonly transport: FederationLookupRpcHttpTransport;
  private readonly localOnionService?: string;

  constructor(options: FederationLookupRpcClientOptions) {
    this.transport = options.transport;
    this.localOnionService = options.localOnionService
      ? validateFederationOnionService(options.localOnionService)
      : undefined;
  }

  async ping(
    peer: FederationLookupPeer,
    signal?: AbortSignal,
  ): Promise<{ ok: true; checkedAt: number }> {
    if (!this.localOnionService) {
      throw new FederationError("invalid-data", "Local federation onion service is not configured");
    }
    const body = await this.post(
      peer,
      "/.well-known/unolock-grid/v1/ping",
      {
        type: "unolock.grid.ping.v1",
        onionService: this.localOnionService,
      },
      signal,
    );
    const response = parseLookupDocument(
      () => parsePingResponse(body),
      "Invalid federation lookup response",
    );
    return {
      ok: response.ok,
      checkedAt: response.checkedAt,
    };
  }

  async findValue(
    peer: FederationLookupPeer,
    addressHash: string,
    signal?: AbortSignal,
  ): Promise<FederationLookupValue | undefined> {
    const normalized = normalizeSha256HexAddressHash(addressHash);
    const body = await this.post(
      peer,
      "/.well-known/unolock-grid/v1/find-value",
      {
        type: "unolock.grid.findValue.v1",
        addressHash: normalized,
      },
      signal,
    );
    const response = parseLookupDocument(
      () => parseFindValueResponse(body),
      "Invalid federation lookup response",
    );
    const responseAddressHash = normalizeSha256HexAddressHash(response.addressHash);
    if (responseAddressHash !== normalized) {
      throw new FederationError("invalid-data", "Federation lookup response hash mismatch");
    }
    if (!response.found) {
      return undefined;
    }
    return {
      addressHash: responseAddressHash,
      lookupValue: validateLookupValueBytes(Buffer.from(response.lookupValue, "base64url")),
      storedAt: response.storedAt,
    };
  }

  async putValue(
    peer: FederationLookupPeer,
    input: {
      addressHash: string;
      lookupValue: Uint8Array;
    },
    signal?: AbortSignal,
  ): Promise<FederationLookupValue> {
    const addressHash = normalizeSha256HexAddressHash(input.addressHash);
    const lookupValue = validateLookupValueBytes(input.lookupValue);
    const body = await this.post(
      peer,
      "/.well-known/unolock-grid/v1/put-value",
      {
        type: "unolock.grid.putValue.v1",
        addressHash,
        lookupValue: Buffer.from(lookupValue).toString("base64url"),
      },
      signal,
    );
    const response = parseLookupDocument(
      () => parsePutValueResponse(body),
      "Invalid federation lookup response",
    );
    const responseAddressHash = normalizeSha256HexAddressHash(response.addressHash);
    if (responseAddressHash !== addressHash) {
      throw new FederationError("invalid-data", "Federation lookup response hash mismatch");
    }
    return {
      addressHash: responseAddressHash,
      lookupValue: new Uint8Array(lookupValue),
      storedAt: response.storedAt,
    };
  }

  async findNode(
    peer: FederationLookupPeer,
    routingKey: string,
    signal?: AbortSignal,
  ): Promise<FederationLookupPeer[]> {
    routingKeyToBytes(routingKey);
    const body = await this.post(
      peer,
      "/.well-known/unolock-grid/v1/find-node",
      {
        type: "unolock.grid.findNode.v1",
        routingKey,
      },
      signal,
    );
    const response = parseLookupDocument(
      () => parseFindNodeResponse(body),
      "Invalid federation lookup response",
    );
    return response.peers.map(normalizeFederationLookupPeer);
  }

  async getReceiveAddressPublicKey(
    peer: FederationLookupPeer,
    addressHash: string,
    signal?: AbortSignal,
  ): Promise<FederationReceiveAddressPublicKey | undefined> {
    const normalized = normalizeSha256HexAddressHash(addressHash);
    const body = await this.post(
      peer,
      federationReceiveAddressPublicKeyPath,
      {
        type: "unolock.receiveAddress.publicKey.v1",
        addressHash: normalized,
      },
      signal,
    );
    const response = parseLookupDocument(
      () => parsePublicKeyResponse(body),
      "Invalid federation lookup response",
    );
    const responseAddressHash = normalizeSha256HexAddressHash(response.addressHash);
    if (responseAddressHash !== normalized) {
      throw new FederationError("invalid-data", "Federation public key response hash mismatch");
    }
    if (!response.found) {
      return undefined;
    }
    return {
      publicKey: response.publicKey,
      custodyDelegation: response.custodyDelegation,
      validationKeys: response.validationKeys,
      allowAttachments: response.allowAttachments,
      maxAttachmentBytes: response.maxAttachmentBytes,
    };
  }

  private async post(
    peer: FederationLookupPeer,
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const peerOnionService = validateFederationOnionService(peer.onionService);
    try {
      return await outboundDhtAdmission.run(
        () => this.transport.postJson(peerOnionService, path, body, signal),
        signal,
      );
    } catch (error) {
      if (error instanceof DhtCapacityError)
        throw new FederationError("limit-exceeded", error.message, true);
      throw error;
    }
  }
}
