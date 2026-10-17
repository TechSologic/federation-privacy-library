import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deriveAddress, generateAddress, validateAddress } from "../../src/index.js";
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
