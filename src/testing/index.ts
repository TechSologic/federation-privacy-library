import type { Federation, FederationConfiguration } from "../contracts.js";
import { FederationRuntime } from "../runtime.js";
import { localConnect } from "../transport.js";
import { fail } from "../errors.js";
import { integer } from "../errors.js";
import { onion } from "../address.js";
export { byteSource as memorySource } from "../streams.js";
export { MemoryFederationStorage } from "../adapters/memory.js";

/** Test-only socket routing. Nodes still communicate through the production HTTP codecs.
 * This registry contains endpoints only, never addresses, content, or shared DHT state.
 */
export class TestNetwork {
  private readonly ports = new Map<string, number>();
  private readonly blocked = new Set<string>();
  block(endpoint: string) {
    this.blocked.add(endpoint);
  }
  unblock(endpoint: string) {
    this.blocked.delete(endpoint);
  }
  /** Attach a disposable reference protocol server to this test network. */
  attach(endpoint: string, port: number) {
    onion(endpoint);
    integer(port, 1, 65535);
    this.ports.set(endpoint, port);
  }
  create(config: FederationConfiguration): Federation {
    return new FederationRuntime(
      config,
      {
        connect: async (endpoint, signal) => {
          const port = this.ports.get(endpoint);
          if (!port || this.blocked.has(endpoint))
            fail("unavailable", "Test peer is offline", true);
          return localConnect("127.0.0.1", port, signal);
        },
      },
      {
        pollMs: 10,
        retryMs: 30,
        onListening: (port) => {
          this.ports.set(config.tor.onionService, port);
        },
        onStopped: () => {
          this.ports.delete(config.tor.onionService);
        },
      },
    );
  }
}
