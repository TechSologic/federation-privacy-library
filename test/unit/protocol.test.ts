import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deriveAddress, generateAddress, validateAddress } from "../../src/index.js";
import { verifyAddressKeys } from "../../src/address.js";
import { decodeMessage, encodeMessage, isAcceptance } from "../../src/protocol/messages.js";
import { byteSource, collect, tracked } from "../../src/streams.js";
import { message } from "../helpers.js";

test("wire message is exactly the existing five-element version-one array", () => {
  const expected = `[1,1,"${"1".repeat(64)}","opaque-encrypted-header",[]]`;
  assert.equal(Buffer.from(encodeMessage(message)).toString(), expected);
  assert.deepEqual(decodeMessage(Buffer.from(expected)), message);
  for (const invalid of ["{}", '[2,1,"x","y",[]]', expected.slice(0, -1) + ",0]"])
    assert.throws(() => decodeMessage(Buffer.from(invalid)));
  assert.equal(
    isAcceptance(202, { type: "unolock.federation.delivery.accepted.v3", accepted: true }),
    true,
  );
  assert.equal(
    isAcceptance(200, { type: "unolock.federation.delivery.accepted.v3", accepted: true }),
    false,
  );
  assert.equal(
    isAcceptance(202, {
      type: "unolock.federation.delivery.accepted.v3",
      accepted: true,
      deliveredToUser: true,
    }),
    false,
  );
});
test("address derivation hashes the secret with the established domain separator", async () => {
  const secret = "s".repeat(43);
  const full = `ul3_${secret}.${"e".repeat(32)}.${"v".repeat(32)}`;
  assert.equal(validateAddress(full), true);
  assert.deepEqual(await deriveAddress(full), {
    addressHash: createHash("sha256")
      .update("unolock-receive-address-v2-secret\0" + secret)
      .digest("hex"),
    encryptionFingerprint: "e".repeat(32),
    validationFingerprint: "v".repeat(32),
  });
  const first = await generateAddress({ publicKey: "encryption", validationKey: "validation" });
  const second = await generateAddress({ publicKey: "encryption", validationKey: "validation" });
  assert.notEqual(first.address, second.address);
  assert.equal(first.identity.encryptionFingerprint, second.identity.encryptionFingerprint);
  await assert.rejects(deriveAddress("invalid"));
});
test("address verification returns only the validation key committed by the address", async () => {
  const committed = "recipient-validation-key";
  const generated = await generateAddress({
    publicKey: "recipient-encryption-key",
    validationKey: committed,
  });
  assert.deepEqual(
    verifyAddressKeys(generated.identity, {
      publicKey: "recipient-encryption-key",
      validationKeys: [
        { id: 1, validationKey: committed },
        { id: 2, validationKey: "attacker-added-validation-key" },
      ],
    }),
    {
      publicKey: "recipient-encryption-key",
      validationKeys: [{ id: 1, validationKey: committed }],
    },
  );
});
test("streams enforce length, digest, ranges and early receiver completion", async () => {
  const source = byteSource(new Uint8Array([1, 2, 3, 4]));
  assert.deepEqual(
    await collect(await source.open({ range: { offset: 1, length: 2 } }), 2),
    Buffer.from([2, 3]),
  );
  await assert.rejects(source.open({ range: { offset: 3, length: 2 } }));
  await assert.rejects(collect(await source.open({}), 3), /exceeds/);
  const checked = tracked(
    await source.open({}),
    await source.describe(),
    new AbortController().signal,
    () => {},
  );
  assert.throws(checked.assertComplete, /before consuming/);
  await collect(checked.stream, 4);
  checked.assertComplete();
  const corrupt = tracked(
    await source.open({}),
    { byteLength: 4, sha256: "bad" },
    new AbortController().signal,
    () => {},
  );
  await assert.rejects(collect(corrupt.stream, 4), /integrity/);
});

test("message codec preserves node normalization and legacy empty attachment slots", () => {
  const expected = `[1,42,"${"a".repeat(64)}","sealed",[]]`;
  assert.equal(
    Buffer.from(
      encodeMessage({
        messageId: 42,
        senderAddressHash: "A".repeat(64),
        sealedHeader: "sealed",
        encryptedAttachmentDescriptors: [],
      }),
    ).toString(),
    expected,
  );
  for (const empty of [null, false, 0, ""]) {
    assert.deepEqual(
      decodeMessage(Buffer.from(JSON.stringify([1, 42, "A".repeat(64), "sealed", empty]))),
      {
        messageId: 42,
        senderAddressHash: "a".repeat(64),
        sealedHeader: "sealed",
        encryptedAttachmentDescriptors: [],
      },
    );
  }
  for (const invalid of [true, {}, [""], Array(21).fill("sealed")]) {
    assert.throws(() =>
      decodeMessage(Buffer.from(JSON.stringify([1, 42, "a".repeat(64), "sealed", invalid]))),
    );
  }
});

test("message text decoding matches the existing node replacement semantics", () => {
  const bytes = Buffer.concat([
    Buffer.from(`[1,42,"${"a".repeat(64)}","`),
    Buffer.from([0xff]),
    Buffer.from('",[]]'),
  ]);
  assert.equal(decodeMessage(bytes).sealedHeader, "\uFFFD");
});
