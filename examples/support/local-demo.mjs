// Local-demo infrastructure. Nothing here is a production persistence or policy adapter.
import { setTimeout as delay } from "node:timers/promises";
import { protocol } from "@techsologic/federation-privacy-library";

/**
 * @param {{validateSealedHeader: (sealedHeader: string) => boolean}} providers
 */
export function createDemoInbox({ validateSealedHeader }) {
  /** @type {Map<string, {envelope: Uint8Array, messageId: number}>} */
  const messages = new Map();
  /** @type {import("@techsologic/federation-privacy-library").AuthorizationHandler} */
  const authorization = {
    // Deliberately public demo policy: admit messages, reject every archive
    // operation. Real applications resolve authority and policy from trusted
    // records; this does not authenticate the sender inside a sealed header.
    async resolveAuthority(request) {
      return request.operation === "message-receive"
        ? { keys: [], bindings: protocol.protocolDocument({ demoPublicInbox: true }) }
        : null;
    },
    async authorize(request) {
      return request.operation === "message-receive" ? "allow" : "deny";
    },
  };
  /** @type {import("@techsologic/federation-privacy-library").MessageReceiver} */
  const receiver = {
    async receive(stream, metadata) {
      // Message envelopes are bounded by the library at 256 KiB. Consume the
      // ENTIRE stream even on a duplicate callback. Archives need streaming
      // staging instead of this small-message memory buffer.
      const envelope = new Uint8Array(await new Response(stream).arrayBuffer());
      metadata.signal.throwIfAborted();
      // The library cannot inspect the encrypted application header. The
      // receiving application must decrypt as needed and validate its signature
      // before committing any message effect.
      if (!validateSealedHeader(metadata.sealedHeader)) {
        const error = /** @type {Error & {retryable: boolean}} */ (
          new Error("Application message signature failed")
        );
        error.retryable = false;
        throw error;
      }
      if (!messages.has(metadata.deliveryId)) {
        messages.set(metadata.deliveryId, { envelope, messageId: metadata.messageId });
      }
      // Production: await an atomic, durable insert-if-absent keyed by
      // deliveryId before resolving. This Map disappears on process exit.
    },
  };
  return {
    authorization,
    receiver,
    /**
     * @param {number} messageId
     * @param {{signal: AbortSignal}} options
     */
    async waitForMessage(messageId, { signal }) {
      while (true) {
        signal.throwIfAborted();
        for (const message of messages.values()) {
          if (message.messageId === messageId) return message.envelope;
        }
        await delay(10, undefined, { signal });
      }
    },
  };
}
