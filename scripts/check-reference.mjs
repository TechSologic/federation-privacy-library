// Optional local compatibility check. Default tests never depend on another checkout.
// Run after build with the reference checkout's tsx loader and UNOLOCK_NODE_SOURCE set.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { encodeMessage, decodeMessage } from "../dist/protocol/messages.js";
import { newLookup, decodeLookup } from "../dist/protocol/lookup.js";
import {
  archiveMaxBytes,
  canonical,
  document,
  verifyRequestProof,
  verifyPointer,
  gatewayLocator,
} from "../dist/protocol/archives.js";
import { generateAddress } from "../dist/index.js";
import { TestNetwork, MemoryFederationStorage } from "../dist/testing/index.js";
const root = process.env.UNOLOCK_NODE_SOURCE;
assert.ok(root, "Set UNOLOCK_NODE_SOURCE to the reference node checkout");
const load = (path) => import(pathToFileURL(resolve(root, "src", path)).href);
const [messages, lookup, access, pointer, archiveWire, locator, limits] = await Promise.all([
  load("federation/federationMessageEnvelope.ts"),
  load("federation/receiveAddressLookup.ts"),
  load("storage/federationSpaceAccess.ts"),
  load("storage/mutableArchivePointer.ts"),
  load("storage/federationArchiveWire.ts"),
  load("storage/nodeGatewayLocator.ts"),
  load("storage/archiveTransferLimits.ts"),
]);
const input = {
  messageId: 42,
  senderAddressHash: "1".repeat(64),
  header: "synthetic-encrypted-header",
  attachments: ["synthetic-encrypted-descriptor"],
};
const localMessage = {
  messageId: input.messageId,
  senderAddressHash: input.senderAddressHash,
  sealedHeader: input.header,
  encryptedAttachmentDescriptors: input.attachments,
};
assert.deepEqual(
  encodeMessage(localMessage),
  Buffer.from(messages.encodeFederationEyesMessageEnvelope(input)),
);
assert.deepEqual(messages.decodeFederationEyesMessageEnvelope(encodeMessage(localMessage)), input);
assert.deepEqual(decodeMessage(messages.encodeFederationEyesMessageEnvelope(input)), localMessage);
const hash = "2".repeat(64),
  endpoint = `http://${"a".repeat(56)}.onion`;
const encoded = newLookup(hash, endpoint);
const decoded = JSON.parse(Buffer.from(encoded, "base64url"));
assert.deepEqual(
  lookup.validateReceiveLookupRecordPlaintext(decoded, hash),
  decodeLookup(encoded, hash),
);
assert.equal(
  gatewayLocator("syntheticarchive1", endpoint),
  locator.buildNodeGatewayLocator({ archiveId: "syntheticarchive1", onionService: endpoint }),
);
assert.equal(archiveMaxBytes, limits.maxArchiveCiphertextBytes);
const keys = generateKeyPairSync("ed25519");
const bindings = {
  spaceAccessRef: "synthetic-authority",
  spaceAuthorityId: "synthetic-authority",
  signingKeyId: "synthetic-key",
  writerAccessId: "synthetic-writer",
  spaceKeyEpochHash: "synthetic-epoch",
  canWrite: true,
};
const trusted = {
  keys: [
    {
      keyId: bindings.signingKeyId,
      publicKey: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    },
  ],
  bindings: document(bindings),
};
const request = {
  archiveID: "syntheticarchive1",
  contentSha256: "a".repeat(64),
  contentLength: 21,
  currentEtag: "",
};
const unsigned = {
  type: "unolock.federation.archive-request.v1",
  spaceAccessRef: bindings.spaceAccessRef,
  operation: "write",
  archiveID: request.archiveID,
  requestHash: access.federationArchiveRequestHash(request),
  issuedAt: Date.now(),
  expiresAt: Date.now() + 120000,
  nonce: randomBytes(16).toString("base64url"),
  signatureAlgorithm: "Ed25519",
};
const proof = {
  ...unsigned,
  signature: sign(null, canonical(unsigned), keys.privateKey).toString("base64url"),
};
assert.equal(
  access.verifyFederationArchiveRequest(
    proof,
    { ...bindings, publicKey: keys.publicKey },
    { operation: "write", archiveID: request.archiveID, request },
  ).ok,
  true,
);
verifyRequestProof(proof, trusted, "write", request.archiveID, request);
const write = {
  locator: gatewayLocator(request.archiveID, endpoint),
  archiveID: request.archiveID,
  md5: "AAAAAAAAAAAAAAAAAAAAAA==",
  currentEtag: "",
  writeGrant: proof,
  contentSha256: request.contentSha256,
  contentLength: 21,
};
const response = {
  type: "unolock.federation.archive.put.response.v1",
  result: "SUCCESS",
  state: "COMMITTED",
  etag: "synthetic-etag",
};
assert.equal(
  archiveWire.archiveWriteResponse(write, 200, response.etag, response).etag,
  response.etag,
);
console.log(
  "Reference node codecs accept library messages, lookup records, archive locators, limits, signed request proofs and committed upload receipts.",
);
const pointerBody = {
  version: 1,
  archiveId: request.archiveID,
  contentCid: `uobj:v1:sha256:${Buffer.from(request.contentSha256, "hex").toString("base64url")}`,
  contentHash: `sha256:${request.contentSha256}`,
  previousPointerHash: "",
  previousContentHash: "",
  sequence: 1,
  writerAccessId: bindings.writerAccessId,
  signingKeyId: bindings.signingKeyId,
  spaceAuthorityId: bindings.spaceAuthorityId,
  spaceKeyEpochHash: bindings.spaceKeyEpochHash,
  issuedAt: Date.now(),
  signatureAlgorithm: "Ed25519",
};
const pointerUnsigned = {
  ...pointerBody,
  pointerHash: pointer.computeMutableArchivePointerHash(pointerBody),
};
const signedPointer = {
  ...pointerUnsigned,
  signature: sign(
    null,
    pointer.mutableArchivePointerSigningPayload(pointerUnsigned),
    keys.privateKey,
  ).toString("base64url"),
};
assert.equal(
  pointer.verifyMutableArchivePointer(signedPointer, { ...bindings, publicKey: keys.publicKey }).ok,
  true,
);
assert.equal(
  verifyPointer(signedPointer, request.archiveID, null, trusted).hash,
  signedPointer.pointerHash,
);

const { createFederationLookupRpcServer } = await load("federation/federationLookupRpcServer.ts");
const { InMemoryFederationLookupService } = await load(
  "federation/inMemoryFederationLookupService.ts",
);
const target = await generateAddress({
  publicKey: "reference-synthetic-encryption",
  validationKey: "reference-synthetic-validation",
});
const service = new InMemoryFederationLookupService([], undefined, endpoint);
await service.putValue({
  addressHash: target.identity.addressHash,
  lookupValue: Buffer.from(newLookup(target.identity.addressHash, endpoint), "base64url"),
});
const app = createFederationLookupRpcServer({ lookup: service, localOnionService: endpoint });
app.post("/.well-known/unolock-federation/v1/receive-address/public-key", async () => ({
  type: "unolock.receiveAddress.publicKey.response.v1",
  found: true,
  addressHash: target.identity.addressHash,
  publicKey: "reference-synthetic-encryption",
  validationKeys: [{ id: 1, validationKey: "reference-synthetic-validation" }],
  allowAttachments: false,
  maxAttachmentBytes: 0,
}));
app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) =>
  done(null, body),
);
let accepted = false;
app.post("/federation/v1/message/receive", async (req, reply) => {
  assert.equal(req.headers["x-unolock-address-hash"], target.identity.addressHash);
  messages.decodeFederationEyesMessageEnvelope(req.body);
  accepted = true;
  reply.code(202);
  return { type: "unolock.federation.delivery.accepted.v3", accepted: true };
});
await app.listen({ host: "127.0.0.1", port: 0 });
const network = new TestNetwork();
network.attach(endpoint, app.server.address().port);
const sender = network.create({
  storage: new MemoryFederationStorage(),
  tor: {
    onionService: `http://${"b".repeat(56)}.onion`,
    socksProxy: { host: "127.0.0.1", port: 9050 },
    listen: { host: "127.0.0.1", port: 0 },
    bootstrap: [{ onionService: endpoint }],
  },
});
try {
  await sender.start();
  assert.ok(await sender.addresses.lookup(target.address));
  const transfer = await sender.messages.send(target.address, sender.messages.source(localMessage));
  assert.equal((await transfer.wait({ signal: AbortSignal.timeout(5000) })).status, "completed");
  assert.ok(accepted);
} finally {
  await sender.stop();
  await app.close();
}
console.log(
  "The library also resolves through the reference node's actual DHT HTTP server and sends its message format over a local socket.",
);
const managed = process.env.UNOLOCK_MANAGED_SOURCE;
if (managed) {
  const access = await import(
    pathToFileURL(resolve(managed, "managed-federation/src/federation-space-access.mjs")).href
  );
  const delivery = await import(
    pathToFileURL(resolve(managed, "managed-federation/src/federationDeliveryAcceptance.mjs")).href
  );
  assert.equal(
    access.verifyFederationArchiveRequest(
      proof,
      { ...bindings, signatureAlgorithm: "Ed25519", publicKey: trusted.keys[0].publicKey },
      { operation: "write", archiveID: request.archiveID, request },
    ).ok,
    true,
  );
  assert.equal(
    delivery.isFederationDeliveryAccepted(202, {
      type: "unolock.federation.delivery.accepted.v3",
      accepted: true,
    }),
    true,
  );
  console.log(
    "Managed-server verification also accepts the same archive proof and node custody response.",
  );
}
