import { FederationFacade } from "../federation.js";
import type { FederationConfiguration as PublicConfiguration } from "../api.js";
import type { Federation, FederationConfiguration } from "../contracts.js";
import { FederationRuntime, type RuntimeHooks } from "../runtime.js";
import { localConnect } from "../transport.js";
import type { Connector } from "../transport.js";
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
  connector(): Connector {
    return {
      connect: async (endpoint, signal) => {
        const port = this.ports.get(endpoint);
        if (!port || this.blocked.has(endpoint)) fail("unavailable", "Test peer is offline", true);
        return localConnect("127.0.0.1", port, signal);
      },
    };
  }
  create(config: PublicConfiguration): FederationFacade {
    return new FederationFacade(config, (runtimeConfig) => this.instantiate(runtimeConfig));
  }
  /** Adapts pre-facade regression fixtures; still exercises the public facade. */
  createRuntime(config: FederationConfiguration, hooks: RuntimeHooks = {}): Federation {
    return new FederationFacade(
      {
        storage: {
          addresses: config.storage.addresses,
          state: config.storage.state,
          lease: config.storage.lease,
          commit: config.storage.commit.bind(config.storage),
          sources: config.sources,
          archives: config.archives?.store,
        },
        tor: config.tor,
        limits: config.limits,
        handlers: {
          messages: config.messages?.receiver,
          archives: config.archives?.receiver,
          authorization: config.authorization,
          proofs: config.proofs,
          routes: config.routes,
          onEvent: (event) => {
            if (event.type === "runtime") return config.listener?.onState(event.status);
          },
        },
      },
      (runtimeConfig) => this.instantiate(runtimeConfig, hooks),
    );
  }
  private instantiate(config: FederationConfiguration, hooks: RuntimeHooks = {}): Federation {
    return new FederationRuntime(config, this.connector(), {
      pollMs: 10,
      retryMs: 30,
      ...hooks,
      onListening: (port) => {
        this.ports.set(config.tor.onionService, port);
        hooks.onListening?.(port);
      },
      onStopped: () => {
        this.ports.delete(config.tor.onionService);
        hooks.onStopped?.();
      },
    });
  }
}

/** Internal engine fixtures for compatibility tests. Production applications use createFederation. */
export * from "../delivery/index.js";
export * from "../dht/index.js";
export { FederationLookupRpcClient } from "../protocol/lookupRpcClient.js";
export type {
  FederationLookupRpcClientOptions,
  FederationLookupRpcHttpTransport,
  FederationReceiveAddressPublicKey,
} from "../protocol/lookupRpcClient.js";
export { FederationLookupCoordinator } from "../host/lookup.js";
export type { FederationLookupCoordinatorOptions } from "../host/lookup.js";
