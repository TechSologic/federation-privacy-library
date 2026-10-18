import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  createFederation,
  deriveAddress,
  generateAddress,
  protocol,
} from "@techsologic/federation-privacy-library";
import { MemoryFederationStorage } from "@techsologic/federation-privacy-library/adapters";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { createDemoInbox } from "./support/local-demo.mjs";

// Run with Tor: node examples/two-nodes.mjs /path/to/tor-config.json
// Run offline: npm run example (the external runner supplies a loopback SOCKS proxy).
// Both paths execute this same application code through the public factory.
// Keys/ciphertext and the memory providers are illustrative, not production storage.

/**
 * Two independent application nodes, configured through the consumer API.
 * @param {{
 *   senderTor: import("@techsologic/federation-privacy-library").TorConfiguration,
 *   receiverTor: import("@techsologic/federation-privacy-library").TorConfiguration
 * }} configuration
 */
export async function runTwoNodes({ senderTor, receiverTor }) {
  // 1. Supply storage, handlers, and Tor configuration to the public factory.
  const applicationSigningKeys = generateKeyPairSync("ed25519");
  /** @param {string} sealedHeader */
  const validateSealedHeader = (sealedHeader) => {
    try {
      const value = JSON.parse(Buffer.from(sealedHeader, "base64url").toString("utf8"));
      return (
        Object.keys(value).sort().join(",") === "ciphertext,signature,type" &&
        value.type === "demo.application-signed-ciphertext.v1" &&
        verify(
          null,
          Buffer.from(value.ciphertext, "base64url"),
          applicationSigningKeys.publicKey,
          Buffer.from(value.signature, "base64url"),
        )
      );
    } catch {
      return false;
    }
  };
  const inbox = createDemoInbox({ validateSealedHeader });
  const receiverRouteKeys = ml_dsa65.keygen();
  /** @satisfies {import("@techsologic/federation-privacy-library").FederationConfiguration} */
  const senderConfiguration = {
    storage: new MemoryFederationStorage(),
    tor: senderTor,
  };
  /** @satisfies {import("@techsologic/federation-privacy-library").FederationConfiguration} */
  const receiverConfiguration = {
    storage: new MemoryFederationStorage(),
    tor: receiverTor,
    handlers: {
      messages: inbox.receiver,
      authorization: inbox.authorization,
      routes: {
        async authorize(request) {
          return {
            signature: Buffer.from(
              ml_dsa65.sign(request.canonicalRequest, receiverRouteKeys.secretKey),
            ).toString("base64url"),
          };
        },
      },
    },
  };
  const sender = createFederation(senderConfiguration);
  const receiver = createFederation(receiverConfiguration);

  try {
    await Promise.all([sender.start(), receiver.start()]);
    console.log("1. Both application nodes started.");

    // 2. The receiving CLIENT supplies its public keys and generates an address.
    // Keep private keys in the application/client; the library never needs them.
    const receiverKeys = {
      publicKey: "synthetic-recipient-public-encryption-key",
      validationKey: Buffer.from(receiverRouteKeys.publicKey).toString("base64url"),
    };
    const destination = await generateAddress(receiverKeys);

    // The receiving HOST registers only the derived identity and public data.
    // Registration also queues publication; it does not wait for global visibility.
    await receiver.addresses.register({
      identity: destination.identity,
      keys: {
        publicKey: receiverKeys.publicKey,
        validationKeys: [{ id: 1, validationKey: receiverKeys.validationKey }],
      },
      policy: { allowAttachments: false, maxAttachmentBytes: 0 },
      enabled: true,
    });
    console.log("2. Recipient address registered; publication scheduled.");

    // 3. Share destination.address privately with the sending client, outside the
    // library. Derive its identity there; hosts need not store the full address.
    const recipientIdentity = await deriveAddress(destination.address);
    const recipient = await sender.addresses.lookup(recipientIdentity, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!recipient) throw new Error("Recipient address is not available yet");
    // lookup checks the public keys against the commitments in the address.
    assert.equal(recipient.keys.publicKey, receiverKeys.publicKey);
    console.log("3. Recipient discovered and address-bound public keys verified.");

    // 4. The sending CLIENT encrypts/signs using those verified public keys and
    // its own protocol. This fixture stands in for that already-encrypted result.
    // messages.source() encodes fields; it DOES NOT encrypt plaintext.
    const origin = await generateAddress({
      publicKey: "synthetic-sender-public-encryption-key",
      validationKey: "synthetic-sender-public-validation-key",
    });
    const ciphertext = Buffer.from("synthetic-ciphertext-produced-by-the-sending-client");
    const sealedHeader = Buffer.from(
      JSON.stringify({
        type: "demo.application-signed-ciphertext.v1",
        ciphertext: ciphertext.toString("base64url"),
        signature: sign(null, ciphertext, applicationSigningKeys.privateKey).toString("base64url"),
      }),
    ).toString("base64url");
    /** @type {import("@techsologic/federation-privacy-library").EncryptedMessage} */
    const encryptedMessage = {
      messageId: 1,
      senderAddressHash: origin.identity.addressHash,
      sealedHeader,
      encryptedAttachmentDescriptors: [],
    };
    /** @type {import("@techsologic/federation-privacy-library").DataSource} */
    const source = sender.messages.source(encryptedMessage);

    // 5. Queue the exact encrypted envelope. In an application, persist this ID
    // and envelope in the outbox BEFORE submitting and reuse both on exact retries.
    const operationId = "demo-message-1";
    const transfer = await sender.messages.send(recipientIdentity, source, undefined, {
      operationId,
    });
    console.log("4. Encrypted envelope queued in the sender's store.");

    // wait() observes the transfer. Aborting this wait does not cancel delivery;
    // use transfer.cancel() if cancellation is intended.
    const outcome = await transfer.wait({ signal: AbortSignal.timeout(60_000) });
    if (outcome.status !== "completed") {
      throw new Error(`Message transfer ended with ${outcome.status}`);
    }
    console.log("5. Remote node accepted custody (not a read receipt).");

    // 6. Receiver processing is separate from custody. Its handler consumes the
    // complete envelope and deduplicates by metadata.deliveryId. This demo waits
    // for that separate application effect and checks the exact received bytes.
    const received = await inbox.waitForMessage(encryptedMessage.messageId, {
      signal: AbortSignal.timeout(60_000),
    });
    assert.deepEqual(received, new Uint8Array(protocol.encodeMessage(encryptedMessage)));
    console.log("6. Receiving app validated its signature and stored the exact envelope.");

    // 7. An exact submission retry returns the same transfer, not another message.
    const retried = await sender.messages.send(recipientIdentity, source, undefined, {
      operationId,
    });
    assert.equal(retried.id, transfer.id);
    console.log("7. Exact retry recovered the same transfer.");
  } finally {
    // Close application admission before stopping; close provider connections after.
    await Promise.all([sender.stop(), receiver.stop()]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const configurationPath = process.argv[2];
  if (!configurationPath) {
    throw new Error(
      "Supply a Tor configuration JSON file; see examples/README.md, or run npm run example offline",
    );
  }
  await runTwoNodes(JSON.parse(await readFile(configurationPath, "utf8")));
}
