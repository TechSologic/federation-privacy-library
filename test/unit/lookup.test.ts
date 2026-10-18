import { FederationLookupRpcClient } from "../../src/protocol/lookupRpcClient.js";
import test from "node:test";
import assert from "node:assert/strict";
import { FederationError } from "../../src/errors.js";
import {
  type FederationLookupRpcHttpTransport,
  validateReceiveLookupRecordPlaintext,
  validateSealedReceiveLookupValue,
  normalizeReceiveLookupTargets,
  validateLookupValueBytes,
  normalizeSha256HexAddressHash,
  deriveFederationRoutingId,
  routingKeyToBytes,
  encodeLookupValue,
  decodeLookupValue,
  type ReceiveLookupTarget,
} from "../../src/protocol/index.js";

const addressHash = "a".repeat(64);
const onion = `http://${"b".repeat(56)}.onion`;
const peer = { onionService: onion };
const target: ReceiveLookupTarget = {
  ...peer,
  deliveryPath: "/federation/v1/message/receive",
  priority: 0,
};
const common = {
  type: "unolock.receive.lookup.v1",
  recordKey: addressHash,
  createdAt: 1234,
  recordNonce: "YQ",
  recordCommitment: "Yg",
};
const record = { ...common, targets: [target] };
const missing = { type: "unolock.grid.findValue.response.v1", found: false, addressHash };
const invalid = (error: unknown) =>
  error instanceof FederationError && error.code === "invalid-data";

class RecordingTransport implements FederationLookupRpcHttpTransport {
  readonly calls: Array<{ onion: string; path: string; body: unknown; signal?: AbortSignal }> = [];
  constructor(public response: unknown) {}
  async postJson(onion: string, path: string, body: unknown, signal?: AbortSignal) {
    this.calls.push({ onion, path, body, signal });
    return this.response;
  }
}

test("lookup records preserve legacy primary, first duplicate and deterministic ordering", () => {
  assert.deepEqual(
    validateReceiveLookupRecordPlaintext({ ...common, primary: target }, addressHash),
    record,
  );
  const legacy = { ...target, deliveryPath: "/federation/message/receive" as const };
  assert.deepEqual(normalizeReceiveLookupTargets([{ ...target, priority: 2 }, target, legacy]), [
    legacy,
    { ...target, priority: 2 },
  ]);
  assert.deepEqual(decodeLookupValue(encodeLookupValue(record)), record);
  // Preserve historical replacement decoding and syntactic base64url acceptance.
  assert.equal(decodeLookupValue(Buffer.from([34, 255, 34])), "\uFFFD");
  assert.equal(
    validateReceiveLookupRecordPlaintext({ ...record, recordNonce: "a" }, addressHash).recordNonce,
    "a",
  );
});

test("lookup validation binds keys, rejects extra fields and bounds targets and opaque values", () => {
  const badRecords = [
    null,
    [],
    {},
    { ...record, extra: true },
    { ...record, primary: target },
    { ...record, targets: [] },
    { ...record, targets: Array(9).fill(target) },
    { ...record, createdAt: Number.MAX_SAFE_INTEGER + 1 },
    { ...record, recordNonce: "=" },
    ...[
      null,
      {},
      { ...target, onionService: "http://example.com" },
      { ...target, deliveryPath: "/other" },
      { ...target, priority: 4 },
      { ...target, priority: 0.5 },
      { ...target, extra: true },
    ].map((t) => ({ ...record, targets: [t] })),
  ];
  for (const value of badRecords)
    assert.throws(() => validateReceiveLookupRecordPlaintext(value, addressHash), invalid);
  assert.throws(() => validateReceiveLookupRecordPlaintext(record, "c".repeat(64)), invalid);
  assert.equal(validateLookupValueBytes(new Uint8Array(16 * 1024)).length, 16 * 1024);
  for (const size of [0, 16 * 1024 + 1])
    assert.throws(() => validateLookupValueBytes(new Uint8Array(size)), invalid);
  const sealed = {
    type: "unolock.receive.lookup.sealed.v1",
    recordKey: addressHash,
    cipherSuite: "AES-256-GCM",
    nonce: "YQ",
    aad: "YQ",
    ciphertext: "YQ",
    tag: "YQ",
  };
  assert.deepEqual(validateSealedReceiveLookupValue(sealed, addressHash), sealed);
  for (const value of [
    { ...sealed, cipherSuite: "none" },
    { ...sealed, extra: 1 },
    { ...sealed, tag: "" },
  ])
    assert.throws(() => validateSealedReceiveLookupValue(value, addressHash), invalid);
  assert.throws(() => validateSealedReceiveLookupValue(sealed, "c".repeat(64)), invalid);
});

test("routing preserves normalized hashes and derives identity from hostname independently of port", () => {
  assert.equal(normalizeSha256HexAddressHash(` ${addressHash.toUpperCase()} `), addressHash);
  assert.equal(deriveFederationRoutingId(onion), deriveFederationRoutingId(`${onion}:8080`));
  assert.deepEqual(
    routingKeyToBytes(` ${addressHash.toUpperCase()} `),
    Buffer.from(addressHash, "hex"),
  );
  assert.deepEqual(
    routingKeyToBytes(deriveFederationRoutingId(onion)),
    Buffer.from(deriveFederationRoutingId(onion), "base64url"),
  );
  assert.throws(() => routingKeyToBytes("short"), invalid);
});

test("RPC preserves exact request paths, bytes, normalized hashes and cancellation signal", async () => {
  const transport = new RecordingTransport({
    type: "unolock.grid.ping.response.v1",
    ok: true,
    checkedAt: 1234,
  });
  const client = new FederationLookupRpcClient({ transport, localOnionService: onion });
  const signal = new AbortController().signal;
  assert.deepEqual(await client.ping(peer, signal), { ok: true, checkedAt: 1234 });
  transport.response = { ...missing, found: true, lookupValue: "AQID", storedAt: 1234 };
  assert.deepEqual(await client.findValue(peer, ` ${addressHash.toUpperCase()} `, signal), {
    addressHash,
    lookupValue: Buffer.from([1, 2, 3]),
    storedAt: 1234,
  });
  transport.response = {
    type: "unolock.grid.putValue.response.v1",
    stored: true,
    addressHash,
    storedAt: 1234,
  };
  const bytes = new Uint8Array([1, 2, 3]);
  const stored = await client.putValue(peer, { addressHash, lookupValue: bytes }, signal);
  bytes[0] = 9;
  assert.deepEqual(stored.lookupValue, new Uint8Array([1, 2, 3]));
  transport.response = { type: "unolock.grid.findNode.response.v1", peers: [peer] };
  assert.deepEqual(await client.findNode(peer, addressHash, signal), [
    { ...peer, routingId: deriveFederationRoutingId(onion) },
  ]);
  assert.deepEqual(transport.calls, [
    {
      onion,
      path: "/.well-known/unolock-grid/v1/ping",
      body: { type: "unolock.grid.ping.v1", onionService: onion },
      signal,
    },
    {
      onion,
      path: "/.well-known/unolock-grid/v1/find-value",
      body: { type: "unolock.grid.findValue.v1", addressHash },
      signal,
    },
    {
      onion,
      path: "/.well-known/unolock-grid/v1/put-value",
      body: { type: "unolock.grid.putValue.v1", addressHash, lookupValue: "AQID" },
      signal,
    },
    {
      onion,
      path: "/.well-known/unolock-grid/v1/find-node",
      body: { type: "unolock.grid.findNode.v1", routingKey: addressHash },
      signal,
    },
  ]);
});

test("RPC rejects invalid destinations and requests before transport; propagates abort and transport errors", async () => {
  const transport = new RecordingTransport(missing);
  const client = new FederationLookupRpcClient({ transport });
  for (const endpoint of [
    "https://example.com",
    `${onion}/path`,
    `${onion}?query`,
    onion.replace("http:", "https:"),
  ])
    await assert.rejects(client.findValue({ onionService: endpoint }, addressHash), invalid);
  await assert.rejects(client.ping(peer), invalid);
  await assert.rejects(client.findValue(peer, "bad"), invalid);
  await assert.rejects(
    client.putValue(peer, { addressHash, lookupValue: new Uint8Array(16 * 1024 + 1) }),
    invalid,
  );
  await assert.rejects(client.findNode(peer, "bad"), invalid);
  const controller = new AbortController();
  const aborted = new Error("synthetic cancellation");
  controller.abort(aborted);
  await assert.rejects(
    client.findValue(peer, addressHash, controller.signal),
    (e) => e === aborted,
  );
  assert.equal(transport.calls.length, 0);
  const unavailable = new Error("synthetic unavailable");
  const failing = new FederationLookupRpcClient({
    transport: {
      async postJson() {
        throw unavailable;
      },
    },
  });
  await assert.rejects(failing.findValue(peer, addressHash), (e) => e === unavailable);
});

test("RPC accepts a lookup response at the full decoded byte limit", async () => {
  const bytes = Buffer.alloc(16 * 1024, 0x7f);
  const transport = new RecordingTransport({
    ...missing,
    found: true,
    lookupValue: bytes.toString("base64url"),
    storedAt: 1,
  });
  const client = new FederationLookupRpcClient({ transport });
  assert.deepEqual((await client.findValue(peer, addressHash))?.lookupValue, bytes);
  transport.response = {
    ...missing,
    found: true,
    lookupValue: Buffer.alloc(bytes.length + 1, 0x7f).toString("base64url"),
    storedAt: 1,
  };
  await assert.rejects(client.findValue(peer, addressHash), invalid);
});

test("RPC validates absence as strictly as presence and binds response to request", async () => {
  const transport = new RecordingTransport(missing);
  const client = new FederationLookupRpcClient({ transport });
  assert.equal(await client.findValue(peer, addressHash), undefined);
  for (const response of [
    null,
    {},
    { ...missing, extra: true },
    { ...missing, lookupValue: "YQ" },
    { ...missing, found: "false" },
    { ...missing, addressHash: "b".repeat(64) },
    { ...missing, found: true, lookupValue: "A".repeat(21_847), storedAt: 1 },
    { ...missing, found: true, lookupValue: "a", storedAt: 1 },
    { ...missing, found: true, lookupValue: "YQ", storedAt: 0 },
  ]) {
    transport.response = response;
    await assert.rejects(client.findValue(peer, addressHash), invalid);
  }
  // Historical peers may use noncanonical trailing base64 bits.
  transport.response = { ...missing, found: true, lookupValue: "YR", storedAt: 1 };
  assert.deepEqual((await client.findValue(peer, addressHash))?.lookupValue, Buffer.from("a"));
  for (const peers of [
    Array(65).fill(peer),
    [{ ...peer, routingId: "attacker-chosen" }],
    [{ onionService: "http://example.com" }],
  ]) {
    transport.response = { type: "unolock.grid.findNode.response.v1", peers };
    await assert.rejects(client.findNode(peer, addressHash), invalid);
  }
});

test("public key response retains bounded legacy metadata without granting authority", async () => {
  const response = {
    type: "unolock.receiveAddress.publicKey.response.v1",
    found: true,
    addressHash,
    publicKey: "opaque-key",
    allowAttachments: true,
    maxAttachmentBytes: 5 * 1024 ** 3,
  };
  const transport = new RecordingTransport(response);
  const client = new FederationLookupRpcClient({ transport });
  assert.deepEqual(await client.getReceiveAddressPublicKey(peer, addressHash), {
    publicKey: "opaque-key",
    validationKeys: [],
    custodyDelegation: undefined,
    allowAttachments: true,
    maxAttachmentBytes: 5 * 1024 ** 3,
  });
  assert.equal(
    transport.calls[0].path,
    "/.well-known/unolock-federation/v1/receive-address/public-key",
  );
  assert.deepEqual(transport.calls[0].body, {
    type: "unolock.receiveAddress.publicKey.v1",
    addressHash,
  });
  const delegation = {
    type: "unolock.federation.custody-delegation.v1",
    addressHash,
    validationKey: "a".repeat(2603),
    custodyKey: "b".repeat(2603),
    signature: "c".repeat(4412),
  };
  transport.response = {
    ...response,
    custodyDelegation: delegation,
    validationKeys: [{ id: 1_785_162_848, validationKey: "key" }],
  };
  assert.deepEqual(
    (await client.getReceiveAddressPublicKey(peer, addressHash))?.custodyDelegation,
    delegation,
  );
  for (const bad of [
    { maxAttachmentBytes: 5 * 1024 ** 3 + 1 },
    { publicKey: "a".repeat(8193) },
    { validationKeys: Array(33).fill({ id: 0, validationKey: "key" }) },
    { validationKeys: [{ id: 4_102_444_801, validationKey: "key" }] },
    { validationKeys: [{ id: 0, validationKey: "key", extra: true }] },
    { custodyDelegation: { ...delegation, signature: "bad" } },
    { addressHash: "b".repeat(64) },
  ]) {
    transport.response = { ...response, ...bad };
    await assert.rejects(client.getReceiveAddressPublicKey(peer, addressHash), invalid);
  }
});

test("all RPC instances share bounded admission until the actual transport settles, even after abort", async () => {
  const releases: Array<(response: unknown) => void> = [];
  const transport: FederationLookupRpcHttpTransport = {
    postJson: async () => new Promise((resolve) => releases.push(resolve)),
  };
  const clients = [
    new FederationLookupRpcClient({ transport }),
    new FederationLookupRpcClient({ transport }),
  ];
  const controller = new AbortController();
  const pending = Array.from({ length: 32 }, (_, i) =>
    clients[i % 2].findValue(peer, addressHash, controller.signal),
  );
  try {
    controller.abort(); // A misbehaving transport cannot release its admission slot early.
    await assert.rejects(
      clients[1].findNode(peer, addressHash),
      (e: unknown) => e instanceof FederationError && e.code === "limit-exceeded" && e.retryable,
    );
    assert.equal(releases.length, 32);
  } finally {
    releases.forEach((resolve) => resolve(missing));
    await Promise.all(pending);
  }
  const next = clients[0].findValue(peer, addressHash);
  releases.at(-1)!(missing);
  assert.equal(await next, undefined);
});
