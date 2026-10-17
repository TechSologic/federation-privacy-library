import { setTimeout as delay } from "node:timers/promises";
import type { AuthorizationHandler, FederationConfiguration, LocalAddress } from "../src/index.js";
import { generateAddress } from "../src/index.js";
import { MemoryFederationStorage } from "../src/adapters/memory.js";
export const endpoint = (letter: string) => `http://${letter.repeat(56)}.onion`;
export const allow: AuthorizationHandler = {
  async resolveAuthority() {
    return { keys: [], bindings: { format: "test-policy", bytes: new Uint8Array() } };
  },
  async authorize() {
    return "allow";
  },
};
export function config(letter: string, peers: string[] = []): FederationConfiguration {
  return {
    storage: new MemoryFederationStorage(),
    authorization: allow,
    tor: {
      onionService: endpoint(letter),
      socksProxy: { host: "127.0.0.1", port: 9050 },
      listen: { host: "127.0.0.1", port: 0 },
      bootstrap: peers.map((letter) => ({ onionService: endpoint(letter) })),
    },
  };
}
export async function address(): Promise<{ address: string; record: LocalAddress }> {
  const keys = { publicKey: "synthetic-encryption-key", validationKey: "synthetic-validation-key" };
  const generated = await generateAddress(keys);
  return {
    address: generated.address,
    record: {
      identity: generated.identity,
      keys: {
        publicKey: keys.publicKey,
        validationKeys: [{ id: 4_000_000_000, validationKey: keys.validationKey }],
      },
      policy: { allowAttachments: true, maxAttachmentBytes: 5 * 1024 ** 3 },
      enabled: true,
    },
  };
}
export async function eventually(
  check: () => Promise<boolean> | boolean,
  timeout = 5000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Condition did not become true");
    await delay(10);
  }
}
export const message = {
  messageId: 1,
  senderAddressHash: "1".repeat(64),
  sealedHeader: "opaque-encrypted-header",
  encryptedAttachmentDescriptors: [],
};
