import { randomInt } from "node:crypto";
import type * as C from "./contracts.js";
import type { FederationConfiguration, FederationEvent } from "./api.js";
import { FederationRuntime } from "./runtime.js";
import { torConnector } from "./transport.js";
import { FederationError, integer } from "./errors.js";
import { ObserverDispatcher } from "./observers.js";
import { FederationSubmissionError } from "./submission.js";
import { FederationLookupCoordinator } from "./host/lookup.js";
import { FederationLookupRpcClient } from "./protocol/lookupRpcClient.js";
import { LookupFederationDeliveryTargetResolver } from "./delivery/targetResolver.js";
import { FederationDeliveryCoordinator } from "./delivery/coordinator.js";
import { FederationDeliveryWorker } from "./delivery/worker.js";
import {
  normalizeFederationDeliveryId,
  normalizeFederationDeliveryInput,
  createFederationDeliveryId,
} from "./delivery/queue.js";
import type { FederationDeliveryRequest } from "./delivery/transport.js";
import { createDhtMaintenanceWorker } from "./dht/maintenanceWorker.js";
import { byteSource } from "./streams.js";
import {
  federationDeliveryPaths,
  validateFederationOnionService,
} from "./protocol/lookupRecords.js";
import { encodeMessage } from "./protocol/messages.js";

/** Internal composition root. Consumers receive its service interfaces, never its engines. */
export class FederationFacade {
  private readonly runtime?: C.Federation;
  private readonly lookup?: FederationLookupCoordinator;
  private readonly rpc?: FederationLookupRpcClient;
  private readonly delivery?: FederationDeliveryCoordinator;
  private readonly resolver?: LookupFederationDeliveryTargetResolver;
  private readonly observer = new ObserverDispatcher();
  private deliveryWorker?: FederationDeliveryWorker;
  private discoveryWorker?: ReturnType<typeof createDhtMaintenanceWorker>;
  private publicationWorker?: ReturnType<typeof createDhtMaintenanceWorker>;
  private current: C.RuntimeStatus = { state: "stopped" };
  private transition?: Promise<unknown>;
  private readonly operations = new Set<Promise<unknown>>();
  private accepting = true;
  private readonly interval: number;
  private readonly batch: number;

  constructor(
    private readonly config: FederationConfiguration,
    runtimeFactory: (config: C.FederationConfiguration) => C.Federation = (config) =>
      new FederationRuntime(config, torConnector(config.tor)),
  ) {
    const keys = new Set(["storage", "handlers", "transport", "tor", "limits", "scheduling"]);
    if (Object.keys(config).some((key) => !keys.has(key)))
      this.invalid(
        "Unsupported federation configuration; use storage, handlers and transport providers",
      );
    this.interval = integer(config.scheduling?.intervalMs ?? 60_000, 1_000, 3_600_000);
    this.batch = integer(config.scheduling?.batchSize ?? 16, 1, 128);
    const storage = config.storage;
    const atomic = [storage.addresses, storage.state, storage.lease, storage.commit];
    if (atomic.some(Boolean) && !atomic.every(Boolean))
      this.invalid("Atomic storage capabilities must be supplied together");
    if (
      !atomic.every(Boolean) &&
      (storage.archives ||
        storage.sources ||
        config.handlers?.messages ||
        config.handlers?.archives ||
        config.handlers?.authorization ||
        config.handlers?.proofs ||
        config.handlers?.routes ||
        config.limits ||
        config.tor?.listen ||
        config.tor?.socksProxy)
    )
      this.invalid(
        "Built-in message/archive handlers, sources, listener and limits require atomic runtime storage",
      );
    if (storage.publications && !storage.lookup)
      this.invalid("Publication storage requires lookup storage");
    if (storage.lookup && !config.transport?.lookup)
      this.invalid("Lookup storage requires a Tor lookup transport");
    if (
      storage.lookup &&
      (typeof storage.lookup.findPinnedValue !== "function" ||
        typeof storage.lookup.pinValue !== "function")
    )
      this.invalid("Lookup storage requires durable verified lookup pins");
    if (storage.delivery && (!storage.lookup || !config.transport?.delivery))
      this.invalid("Delivery storage requires lookup storage and Tor transports");
    if (!!storage.archives !== !!config.handlers?.archives)
      this.invalid("Archive storage and receiver must be supplied together");
    if (atomic.every(Boolean)) {
      if (
        !config.tor?.onionService ||
        !config.tor.listen ||
        !config.tor.socksProxy ||
        !config.tor.bootstrap
      )
        this.invalid("Runtime storage requires complete Tor configuration");
      // Separate capabilities may coexist, but must never own the same durable jobs.
      this.runtime = runtimeFactory({
        storage: storage as C.FederationStorage,
        tor: config.tor as C.TorConfiguration,
        sources: storage.sources,
        messages: config.handlers?.messages ? { receiver: config.handlers.messages } : undefined,
        archives:
          storage.archives && config.handlers?.archives
            ? { store: storage.archives, receiver: config.handlers.archives }
            : undefined,
        authorization: config.handlers?.authorization,
        proofs: config.handlers?.proofs,
        routes: config.handlers?.routes,
        listener: { onState: (status) => this.emit({ type: "runtime", status }) },
        limits: config.limits,
      });
    }
    if (config.transport?.lookup)
      this.rpc = new FederationLookupRpcClient({
        transport: config.transport.lookup,
        localOnionService: config.tor?.onionService,
      });
    if (storage.lookup) {
      this.lookup = new FederationLookupCoordinator({
        localLookup: storage.lookup,
        rpcClient: this.rpc!,
        bootstrapPeers: [...(config.tor?.bootstrap ?? [])],
        localOnionService: config.tor?.onionService,
        publishQueue: storage.publications,
        maxRetryBatch: this.batch,
        isAddressActive: config.handlers?.isAddressActive,
      });
      this.resolver = new LookupFederationDeliveryTargetResolver(this.lookup, storage.lookup);
    }
    if (storage.delivery)
      this.delivery = new FederationDeliveryCoordinator({
        queue: storage.delivery,
        transport: config.transport!.delivery!,
        targetResolver: this.resolver!,
        routingCache: storage.routing,
        maxRetryBatch: this.batch,
        deliveryStatusSink: config.handlers?.deliveryStatus
          ? {
              setDeliveryStatus: async (input) => {
                try {
                  await config.handlers!.deliveryStatus!.setDeliveryStatus(input);
                } catch (error) {
                  throw new FederationSubmissionError(
                    input.deliveryId,
                    input.status === "delivered" ? "accepted" : "queued",
                    error,
                  );
                }
              },
            }
          : undefined,
        observer: { onError: () => this.emit({ type: "error", operation: "delivery" }) },
      });
  }

  private invalid(message: string): never {
    throw new FederationError("invalid-data", message);
  }
  private require<T>(value: T | undefined, name: string): T {
    if (!value)
      throw new FederationError("unavailable", `${name} storage or transport is not configured`);
    return value;
  }
  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.accepting)
      return Promise.reject(new FederationError("unavailable", "Federation is stopped", true));
    const result = Promise.resolve().then(operation);
    this.operations.add(result);
    void result.then(
      () => this.operations.delete(result),
      () => this.operations.delete(result),
    );
    return result;
  }
  private emit(event: FederationEvent): void {
    const handlers = this.config.handlers;
    if (handlers?.onEvent)
      this.observer.dispatch(handlers, () => handlers.onEvent!(structuredClone(event)));
  }

  /** Address registration plus host-owned lookup/publication persistence. */
  readonly addresses = {
    discoveryStatus: () => ({ joined: this.lookup?.joined === true }),
    register: (...args: Parameters<C.AddressApi["register"]>) =>
      this.track(() =>
        this.require(this.runtime, "Address registration").addresses.register(...args),
      ),
    get: (...args: Parameters<C.AddressApi["get"]>) =>
      this.require(this.runtime, "Address registration").addresses.get(...args),
    list: (...args: Parameters<C.AddressApi["list"]>) =>
      this.require(this.runtime, "Address registration").addresses.list(...args),
    update: (...args: Parameters<C.AddressApi["update"]>) =>
      this.track(() =>
        this.require(this.runtime, "Address registration").addresses.update(...args),
      ),
    remove: (...args: Parameters<C.AddressApi["remove"]>) =>
      this.track(() =>
        this.require(this.runtime, "Address registration").addresses.remove(...args),
      ),
    lookup: (...args: Parameters<C.AddressApi["lookup"]>) =>
      this.track(() => this.require(this.runtime, "Address lookup").addresses.lookup(...args)),
    publish: (...args: Parameters<C.AddressApi["publish"]>) =>
      this.track(() =>
        this.require(this.runtime, "Address publication").addresses.publish(...args),
      ),
    resolve: (hash: string, options: C.CallOptions = {}) =>
      this.track(() => this.require(this.lookup, "Lookup").resolve(hash, options.signal)),
    resolveTargets: (
      hash: string,
      expectedValidationFingerprint?: string,
      options: C.CallOptions = {},
    ) =>
      this.track(() =>
        this.require(this.resolver, "Lookup").resolveTargets({
          addressHash: hash,
          expectedValidationFingerprint,
          signal: options.signal,
        }),
      ),
    publishRecord: (hash: string, options: C.CallOptions & { now?: number } = {}) =>
      this.track(() => this.require(this.lookup, "Publication").publishLocalValue(hash, options)),
    processPublications: (options: C.CallOptions & { now?: number; limit?: number } = {}) =>
      this.track(() => this.require(this.lookup, "Publication").processPendingPublishes(options)),
    refreshPeers: (options: C.CallOptions = {}) =>
      this.track(() => this.require(this.lookup, "Discovery").refreshPeers(options.signal)),
  };

  readonly messages = {
    source: (message: C.EncryptedMessage): C.DataSource => byteSource(encodeMessage(message)),
    send: (...args: Parameters<C.MessageApi["send"]>) =>
      this.track(() => this.require(this.runtime, "Message transfers").messages.send(...args)),
    /** Exact encoded envelopes for hosts with an existing durable delivery queue.
     * Always returns the caller's stable identifier, including immediate custody.
     */
    submit: (
      request: FederationDeliveryRequest,
      options: { now?: number; deliveryId?: string } = {},
    ) =>
      this.track(async () => {
        let id = options.deliveryId ?? createFederationDeliveryId();
        try {
          id = normalizeFederationDeliveryId(id);
          normalizeFederationDeliveryInput({ ...request, deliveryId: id });
          validateFederationOnionService(request.onionService);
          if (
            !federationDeliveryPaths.includes(
              request.deliveryPath as (typeof federationDeliveryPaths)[number],
            )
          )
            this.invalid("Invalid delivery path");
          this.require(this.delivery, "Delivery");
        } catch (error) {
          throw new FederationSubmissionError(id, "not-queued", error);
        }
        try {
          const result = await this.require(this.delivery, "Delivery").submit(request, {
            ...options,
            deliveryId: id,
          });
          return { ...result, deliveryId: id };
        } catch (error) {
          if (error instanceof FederationSubmissionError) throw error;
          throw new FederationSubmissionError(id, "unknown", error);
        }
      }),
    processDue: (options: { now?: number; limit?: number } = {}) =>
      this.track(() => this.require(this.delivery, "Delivery").processDue(options)),
    wakePending: (options: { now?: number; limit?: number } = {}) =>
      this.track(() => this.require(this.delivery, "Delivery").wakePendingForStartup(options)),
    listUndeliverable: (limit?: number) =>
      this.require(this.delivery, "Delivery").listUndeliverable(limit),
  };

  /** Bounded wire operations; returned key records remain untrusted until verified by the host. */
  readonly peers = {
    ping: (peer: Parameters<FederationLookupRpcClient["ping"]>[0], options: C.CallOptions = {}) =>
      this.track(() => this.require(this.rpc, "Lookup transport").ping(peer, options.signal)),
    findValue: (
      peer: Parameters<FederationLookupRpcClient["findValue"]>[0],
      hash: string,
      options: C.CallOptions = {},
    ) =>
      this.track(() =>
        this.require(this.rpc, "Lookup transport").findValue(peer, hash, options.signal),
      ),
    findNode: (
      peer: Parameters<FederationLookupRpcClient["findNode"]>[0],
      key: string,
      options: C.CallOptions = {},
    ) =>
      this.track(() =>
        this.require(this.rpc, "Lookup transport").findNode(peer, key, options.signal),
      ),
    putValue: (
      peer: Parameters<FederationLookupRpcClient["putValue"]>[0],
      value: Parameters<FederationLookupRpcClient["putValue"]>[1],
      options: C.CallOptions = {},
    ) =>
      this.track(() =>
        this.require(this.rpc, "Lookup transport").putValue(peer, value, options.signal),
      ),
    getReceiveAddressPublicKey: (
      peer: Parameters<FederationLookupRpcClient["getReceiveAddressPublicKey"]>[0],
      hash: string,
      options: C.CallOptions = {},
    ) =>
      this.track(() =>
        this.require(this.rpc, "Lookup transport").getReceiveAddressPublicKey(
          peer,
          hash,
          options.signal,
        ),
      ),
    wake: (): void => this.discoveryWorker?.wake(),
  };

  get archives(): C.ArchiveApi {
    return this.require(this.runtime, "Archives").archives;
  }
  get transfers(): C.TransferApi {
    return this.require(this.runtime, "Transfers").transfers;
  }
  get limits(): C.FederationLimits {
    return this.require(this.runtime, "Runtime limits").limits;
  }
  status(): C.RuntimeStatus {
    return this.runtime?.status() ?? { ...this.current };
  }

  start(options: C.CallOptions = {}): Promise<C.RuntimeStatus> {
    if (this.transition) return this.transition.then(() => this.start(options));
    if (this.current.state !== "stopped") return Promise.resolve(this.status());
    const operation = this.startOnce(options);
    this.transition = operation;
    void operation.then(
      () => {
        this.transition = undefined;
      },
      () => {
        this.transition = undefined;
      },
    );
    return operation;
  }
  private async startOnce(options: C.CallOptions): Promise<C.RuntimeStatus> {
    options.signal?.throwIfAborted();
    this.current = { state: "starting" };
    this.accepting = true;
    try {
      await this.runtime?.start(options);
      const scheduling = this.config.scheduling;
      this.delivery?.resumeProcessing();
      if (this.delivery && scheduling?.delivery !== false) {
        this.deliveryWorker = new FederationDeliveryWorker({
          coordinator: this.delivery,
          intervalMs: this.interval,
          batchLimit: this.batch,
          observer: {
            onBatchProcessed: (summary) => this.emit({ type: "delivery", summary }),
            onStartupWake: (queued) => this.emit({ type: "delivery-wake", queued }),
            onError: () => this.emit({ type: "error", operation: "delivery" }),
          },
        });
        this.deliveryWorker.start();
      }
      if (this.lookup && scheduling?.discovery !== false) {
        this.discoveryWorker = createDhtMaintenanceWorker({
          run: async (signal) => {
            const summary = await this.lookup!.refreshPeers(signal);
            if (summary) this.emit({ type: "discovery", summary });
          },
          onError: () => this.emit({ type: "error", operation: "discovery" }),
          delayMs: () => randomInt(60_000, 90_001),
        });
        this.discoveryWorker.start();
      }
      if (this.lookup && this.config.storage.publications && scheduling?.publication !== false) {
        this.publicationWorker = createDhtMaintenanceWorker({
          run: async (signal) => {
            await this.config.handlers?.preparePublications?.({ signal, limit: this.batch });
            signal.throwIfAborted();
            const summary = await this.lookup!.processPendingPublishes({
              signal,
              limit: this.batch,
            });
            this.emit({ type: "publication", summary });
          },
          onError: () => this.emit({ type: "error", operation: "publication" }),
          delayMs: () => this.interval,
          minWakeDelayMs: this.interval,
        });
        this.publicationWorker.start();
      }
      this.current = { state: "ready" };
      return this.status();
    } catch (error) {
      await this.stopOnce();
      throw error;
    }
  }
  stop(options?: { deadlineMs?: number }): Promise<void> {
    if (this.transition)
      return this.transition.then(
        () => this.stop(options),
        () => this.stop(options),
      );
    const operation = this.stopOnce(options);
    this.transition = operation;
    void operation.then(
      () => {
        this.transition = undefined;
      },
      () => {
        this.transition = undefined;
      },
    );
    return operation;
  }
  private async stopOnce(options?: { deadlineMs?: number }): Promise<void> {
    this.accepting = false;
    this.current = { state: "stopping" };
    // Stop worker scheduling first, then drain every accepted caller before stores close.
    const stopped = await Promise.allSettled([
      this.discoveryWorker?.stop(),
      this.publicationWorker?.stop(),
      this.deliveryWorker?.stop(),
      this.delivery?.stopProcessing(),
      this.runtime?.stop(options),
    ]);
    await Promise.allSettled([...this.operations]);
    this.discoveryWorker = undefined;
    this.publicationWorker = undefined;
    this.deliveryWorker = undefined;
    this.current = { state: "stopped" };
    const failure = stopped.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}
