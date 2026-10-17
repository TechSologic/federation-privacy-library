import type { EncryptedMessage } from "../contracts.js";
import { hashAddress } from "../address.js";
import { fail, integer } from "../errors.js";
export const messagePath = "/federation/v1/message/receive";
export const legacyMessagePath = "/federation/message/receive";
export const messageMaxBytes = 256 * 1024;
export const acceptance = Object.freeze({
  type: "unolock.federation.delivery.accepted.v3",
  accepted: true,
});
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value) > max)
    fail("invalid-data", "Invalid encrypted message field");
  return value;
}
export function encodeMessage(message: EncryptedMessage): Uint8Array {
  const result = Buffer.from(
    JSON.stringify([
      1,
      message.messageId,
      message.senderAddressHash,
      message.sealedHeader,
      message.encryptedAttachmentDescriptors,
    ]),
  );
  decodeMessage(result);
  return result;
}
export function decodeMessage(bytes: Uint8Array): EncryptedMessage {
  if (!bytes.length || bytes.length > messageMaxBytes)
    fail("limit-exceeded", "Message envelope exceeds the wire limit");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("invalid-data", "Invalid message envelope");
  }
  if (!Array.isArray(value) || value.length !== 5 || value[0] !== 1)
    fail("invalid-data", "Invalid message envelope");
  integer(value[1] as number, 1);
  if (!Array.isArray(value[4]) || value[4].length > 20)
    fail("invalid-data", "Invalid encrypted attachments");
  return {
    messageId: value[1],
    senderAddressHash: hashAddress(text(value[2], 64).trim().toLowerCase()),
    sealedHeader: text(value[3], 512 * 1024),
    encryptedAttachmentDescriptors: value[4].map((item) => text(item, 128 * 1024)),
  };
}
export function isAcceptance(status: number, value: unknown): boolean {
  if (status !== 202 || !value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body).sort().join(",");
  if (body.accepted !== true) return false;
  return body.type === acceptance.type
    ? keys === "accepted,type"
    : body.type === "unolock.federation.delivery.accepted.v2" &&
        keys === "accepted,signature,type" &&
        typeof body.signature === "string" &&
        /^[A-Za-z0-9_-]{4412}$/.test(body.signature);
}
