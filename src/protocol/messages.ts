import type { EncryptedMessage } from "../contracts.js";
import { hashAddress } from "../address.js";
import { fail } from "../errors.js";
export const messagePath = "/federation/v1/message/receive";
export const legacyMessagePath = "/federation/message/receive";
export const messageMaxBytes = 256 * 1024;
export const acceptance = Object.freeze({
  type: "unolock.federation.delivery.accepted.v3",
  accepted: true,
});
function text(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value) > max)
    fail("invalid-data", `Invalid ${label}`);
  return value;
}
export function encodeMessage(message: EncryptedMessage): Uint8Array {
  // Validate before serialization to bound fields and preserve node normalization.
  const normalized = normalizeMessage(message);
  const result = Buffer.from(
    JSON.stringify([
      1,
      normalized.messageId,
      normalized.senderAddressHash,
      normalized.sealedHeader,
      normalized.encryptedAttachmentDescriptors,
    ]),
  );
  if (result.length > messageMaxBytes)
    fail("limit-exceeded", "Message envelope exceeds the wire limit");
  return result;
}
export function decodeMessage(bytes: Uint8Array): EncryptedMessage {
  if (!bytes.length || bytes.length > messageMaxBytes)
    fail("limit-exceeded", "Message envelope exceeds the wire limit");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail("invalid-data", "Invalid message envelope");
  }
  if (!Array.isArray(value) || value.length !== 5 || value[0] !== 1)
    fail("invalid-data", "Invalid message envelope");
  return normalizeMessage({
    messageId: value[1],
    senderAddressHash: value[2],
    sealedHeader: value[3],
    encryptedAttachmentDescriptors: value[4],
  });
}
function normalizeMessage(message: EncryptedMessage): EncryptedMessage {
  if (!Number.isSafeInteger(message.messageId) || message.messageId <= 0)
    fail("invalid-data", "Invalid message id");
  const senderAddressHash = hashAddress(
    text(
      typeof message.senderAddressHash === "string"
        ? message.senderAddressHash.trim().toLowerCase()
        : message.senderAddressHash,
      64,
      "sender address hash",
    ),
  );
  const sealedHeader = text(message.sealedHeader, 512 * 1024, "message header");
  // Existing node readers interpret an empty legacy attachment slot as [].
  const attachments = message.encryptedAttachmentDescriptors || [];
  if (!Array.isArray(attachments) || attachments.length > 20)
    fail("invalid-data", "Too many attachments");
  return {
    messageId: message.messageId,
    senderAddressHash,
    sealedHeader,
    encryptedAttachmentDescriptors: attachments.map((item) =>
      text(item, 128 * 1024, "attachment archive"),
    ),
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
