import test from "node:test";
import assert from "node:assert/strict";
import { archivePolicy } from "../archive-adapter.js";
import {
  canonical,
  document,
  readDocument,
  shaHex,
  verifyRequestProof,
} from "../../src/protocol/archives.js";
import { generateAddress } from "../../src/index.js";
import { verifyAddressKeys } from "../../src/address.js";
test("lookup keys must satisfy both address commitments", async () => {
  const generated = await generateAddress({
    publicKey: "key-one",
    validationKey: "validation-one",
  });
  assert.throws(
    () =>
      verifyAddressKeys(generated.identity, {
        publicKey: "wrong-key",
        validationKeys: [{ id: 1, validationKey: "validation-one" }],
      }),
    /commitment/,
  );
  assert.throws(
    () =>
      verifyAddressKeys(generated.identity, {
        publicKey: "key-one",
        validationKeys: [{ id: 1, validationKey: "wrong-validation" }],
      }),
    /commitment/,
  );
  verifyAddressKeys(generated.identity, {
    publicKey: "key-one",
    validationKeys: [{ id: 4_000_000_000, validationKey: "validation-one" }],
  });
});
test("archive proofs bind exact operation, target, request, authority and time", async () => {
  const policy = archivePolicy();
  const archive = { id: "syntheticarchive1", locator: "synthetic-locator" };
  const request = { archiveID: archive.id };
  const signal = new AbortController().signal;
  const canonicalRequest = canonical(request);
  const requestHash = shaHex(canonicalRequest);
  const proof = readDocument(
    (
      await policy.proofs.provide({
        operation: "archive-read",
        target: { archive },
        canonicalRequest,
        requestHash,
        signal,
      })
    )[0],
  );
  const authority = await policy.authorization.resolveAuthority({
    operation: "archive-read",
    target: { archive },
    canonicalRequest,
    requestHash,
    submitted: [document(proof)],
    signal,
  });
  assert.ok(authority);
  verifyRequestProof(proof, authority, "read", archive.id, request);
  assert.throws(() => verifyRequestProof(proof, authority, "write", archive.id, request));
  assert.throws(() => verifyRequestProof(proof, authority, "read", "another-archive", request));
  assert.throws(() =>
    verifyRequestProof(proof, authority, "read", archive.id, {
      archiveID: archive.id,
      extra: true,
    }),
  );
  assert.throws(() =>
    verifyRequestProof({ ...proof, expiresAt: 1 }, authority, "read", archive.id, request),
  );
  assert.throws(() =>
    verifyRequestProof(
      { ...proof, signature: "A".repeat(86) },
      authority,
      "read",
      archive.id,
      request,
    ),
  );
});
