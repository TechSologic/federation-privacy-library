import { generateAddress } from "../dist/index.js";
import { TestNetwork, MemoryFederationStorage } from "../dist/testing/index.js";

// Local example: actual HTTP sockets, synthetic onion routing, no Tor or credentials.
// Use createFederation and a durable adapter in a real host instead of TestNetwork.
const network = new TestNetwork();
const endpoint = (letter) => `http://${letter.repeat(56)}.onion`;
const config = (letter, peer) => ({
  storage: new MemoryFederationStorage(),
  tor: {
    onionService: endpoint(letter),
    socksProxy: { host: "127.0.0.1", port: 9050 },
    listen: { host: "127.0.0.1", port: 0 },
    bootstrap: [{ onionService: endpoint(peer) }],
  },
});
let received;
const consumed = new Promise((resolve) => {
  received = resolve;
});
const sender = network.create(config("a", "b"));
const receiver = network.create({
  ...config("b", "a"),
  // This synthetic demo admits messages. A real app supplies its own access policy.
  authorization: {
    async resolveAuthority() {
      return { keys: [], bindings: { format: "demo-policy", bytes: new Uint8Array() } };
    },
    async authorize() {
      return "allow";
    },
  },
  messages: {
    receiver: {
      async receive(stream, metadata) {
        let length = 0;
        for await (const chunk of stream) length += chunk.length;
        // A real receiver durably stores or queues the encrypted envelope here and
        // deduplicates repeated callbacks using metadata.deliveryId.
        received(length);
      },
    },
  },
});
try {
  await Promise.all([sender.start(), receiver.start()]);
  const keys = {
    publicKey: "synthetic-public-encryption-key",
    validationKey: "synthetic-public-validation-key",
  };
  const target = await generateAddress(keys);
  await receiver.addresses.register({
    identity: target.identity,
    keys: {
      publicKey: keys.publicKey,
      validationKeys: [{ id: 1, validationKey: keys.validationKey }],
    },
    policy: { allowAttachments: false, maxAttachmentBytes: 0 },
    enabled: true,
  });
  const source = sender.messages.source({
    messageId: 1,
    senderAddressHash: "1".repeat(64),
    sealedHeader: "synthetic-already-encrypted-header",
    encryptedAttachmentDescriptors: [],
  });
  const transfer = await sender.messages.send(target.address, source);
  const outcome = await transfer.wait({ signal: AbortSignal.timeout(5000) });
  if (outcome.status !== "completed") throw new Error("Transfer did not complete");
  console.log(
    `Node custody confirmed; receiver consumed ${await consumed} encrypted-envelope bytes.`,
  );
} finally {
  await Promise.all([sender.stop(), receiver.stop()]);
}
