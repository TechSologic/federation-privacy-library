import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type * as C from "./contracts.js";
import { destinationIdentity, hashAddress, onion, validateLocalAddress } from "./address.js";
import { fail, failure, FederationError, integer } from "./errors.js";
import { State } from "./state.js";
import { byteSource, collect, tracked } from "./streams.js";
import { HttpWire, type Connector, type WireHandler } from "./transport.js";
import { Discovery, type Publication } from "./discovery.js";
import {
  acceptance,
  decodeMessage,
  encodeMessage,
  isAcceptance,
  legacyMessagePath,
  messageMaxBytes,
  messagePath,
} from "./protocol/messages.js";
import { base64, gridPath, json, keyPath, newLookup, object } from "./protocol/lookup.js";
import { Archives, type ArchiveJob } from "./archives.js";
import { archiveMaxBytes, archivePath, canonical } from "./protocol/archives.js";

interface Work {
  snapshot: C.TransferSnapshot;
  destination: C.AddressIdentity;
  envelope: string;
  digest: string;
  createdAt: number;
  dueAt: number;
  result?: C.TransferResult;
}
interface Ingress {
  addressHash: string;
  envelope: string;
  attempt: number;
  done: boolean;
  createdAt: number;
}
export interface RuntimeHooks {
  onListening?(port: number): void;
  onStopped?(): void;
  pollMs?: number;
  retryMs?: number;
}
const defaults: C.FederationLimits = Object.freeze({
  maxMessageBytes: messageMaxBytes,
  maxArchiveBytes: archiveMaxBytes,
  maxBufferedBytes: 8 * 1024 ** 2,
  maxConcurrentTransfers: 4,
  maxPendingOperations: 1024,
  maxAttempts: 8,
  operationRetentionMs: 7 * 24 * 60 * 60_000,
});
const terminal = (state: C.TransferState) => ["completed", "cancelled", "failed"].includes(state);
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));

export class FederationRuntime implements C.Federation {
  readonly limits: C.FederationLimits;
  readonly addresses: C.AddressApi;
  readonly messages: C.MessageApi;
  readonly transfers: C.TransferApi;
  readonly archives: Archives;
  readonly state: State;
  readonly wire: HttpWire;
  readonly discovery: Discovery;
  private runtimeStatus: C.RuntimeStatus = { state: "stopped" };
  private controller = new AbortController();
  private loop?: Promise<void>;
  private heartbeat?: Promise<void>;
  private readonly listeners = new Map<string, Set<C.TransferListener>>();
  private readonly attempts = new Map<string, AbortController>();
  private readonly owner = randomUUID();
  private lockRevision?: string;
  private windowAt = 0;
  private requestCount = 0;
  private activeRequests = 0;
  private listening = false;

  constructor(
    readonly config: C.FederationConfiguration,
    connector: Connector,
    readonly hooks: RuntimeHooks = {},
  ) {
    onion(config.tor.onionService);
    this.limits = Object.freeze({ ...defaults, ...config.limits });
    for (const [name, value] of Object.entries(this.limits))
      integer(value, 1, defaults[name as keyof C.FederationLimits]);
    if (this.limits.maxBufferedBytes < this.limits.maxMessageBytes)
      fail("invalid-data", "Buffer budget must hold one message envelope");
    this.state = new State(config.storage);
    this.wire = new HttpWire(connector, config.tor);
    this.discovery = new Discovery(
      config.tor.onionService,
      config.tor.bootstrap,
      this.wire,
      this.state,
    );
    this.addresses = {
      register: (record, options) => this.saveAddress(record, null, options),
      update: (record, revision, options) => this.saveAddress(record, revision, options),
      get: async (hash, options) => {
        options?.signal?.throwIfAborted();
        hashAddress(hash);
        const record = await config.storage.addresses.get(hash);
        return record ? this.registration(record) : null;
      },
      list: async (query, options) => {
        options?.signal?.throwIfAborted();
        const page = await config.storage.addresses.list(query);
        return {
          items: await Promise.all(page.items.map((record) => this.registration(record))),
          cursor: page.cursor,
        };
      },
      remove: async (hash, revision, options) => {
        options?.signal?.throwIfAborted();
        hashAddress(hash);
        const publication = await this.state.get("publication", hash);
        const changes: C.StorageMutation[] = [
          { kind: "address", key: hash, expectedRevision: revision, value: null },
        ];
        if (publication)
          changes.push(this.state.mutation("publication", hash, publication.revision, null));
        const result = await config.storage.commit(randomUUID(), changes);
        if (result.outcome !== "committed") fail("conflict", "Address revision changed");
      },
      lookup: async (destination, options) =>
        (await this.discovery.lookup(await destinationIdentity(destination), this.signal(options)))
          ?.resolved ?? null,
      publish: async (hash, options) => {
        options?.signal?.throwIfAborted();
        hashAddress(hash);
        const record = await config.storage.addresses.get(hash);
        if (!record) fail("not-found", "Address is not registered");
        const p = await this.state.get<Publication>("publication", hash);
        if (!p) fail("storage", "Address publication state is missing");
        if (
          !(await this.state.put(
            "publication",
            hash,
            p.revision,
            { ...p.value, published: false },
            Date.now(),
          ))
        )
          fail("conflict", "Address publication changed");
      },
    };
    this.messages = {
      source: (message) => byteSource(encodeMessage(message)),
      send: (destination, source, listener, options) =>
        this.sendMessage(destination, source, listener, options),
    };
    this.transfers = {
      get: async (id, options) => {
        options?.signal?.throwIfAborted();
        return (await this.state.get("outbox", id)) ? this.transfer(id) : null;
      },
      list: async (query, options) => {
        options?.signal?.throwIfAborted();
        const page = await config.storage.state.list({ ...query, collection: "outbox" });
        return {
          items: page.items.map((item) => this.state.decode<Work>(item.value).snapshot),
          cursor: page.cursor,
        };
      },
    };
    this.archives = new Archives({
      config,
      state: this.state,
      wire: this.wire,
      limits: this.limits,
      signal: (options) => this.signal(options),
      resolve: async (destination, signal) => {
        const result = await this.discovery.lookup(await destinationIdentity(destination), signal);
        if (!result) fail("unavailable", "Archive destination is not published", true);
        return (
          result.resolved.routes.archiveOnionService ?? result.resolved.routes.messageOnionService
        );
      },
      enqueue: async (kind, destination, job, listener, options, total) => {
        const identity = await destinationIdentity(destination);
        const id = options.operationId ?? randomUUID();
        if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id))
          fail("invalid-data", "Invalid operation identifier");
        const encoded = canonical(job);
        const work: Work = {
          destination: identity,
          envelope: Buffer.from(encoded).toString("base64url"),
          digest: createHash("sha256").update(encoded).digest("base64url"),
          createdAt: Date.now(),
          dueAt: Date.now(),
          snapshot: {
            id,
            kind,
            state: "queued",
            attempt: 0,
            bytesTransferred: 0,
            totalBytes: total,
          },
        };
        try {
          const existing = await this.state.get<Work>("outbox", id);
          if (existing) this.sameSubmission(existing.value, work);
          else if (!(await this.enqueue("outbox", id, work, Date.now())))
            this.sameSubmission((await this.state.get<Work>("outbox", id))!.value, work);
        } catch (error) {
          throw this.submissionError(id, error);
        }
        const transfer = this.transfer(id);
        if (listener) transfer.listen(listener);
        return transfer;
      },
    });
  }
  private signal(options?: C.CallOptions): AbortSignal {
    if (!["ready", "degraded"].includes(this.runtimeStatus.state))
      fail("unavailable", "Federation is not running", true);
    return options?.signal
      ? AbortSignal.any([options.signal, this.controller.signal])
      : this.controller.signal;
  }
  private setStatus(status: C.RuntimeStatus) {
    this.runtimeStatus = status;
    try {
      this.config.listener?.onState({ ...status });
    } catch {
      /* Observers cannot break the runtime. */
    }
  }
  status(): C.RuntimeStatus {
    return { ...this.runtimeStatus };
  }
  async start(options?: C.CallOptions): Promise<C.RuntimeStatus> {
    if (this.runtimeStatus.state !== "stopped") fail("conflict", "Federation is already running");
    options?.signal?.throwIfAborted();
    this.setStatus({ state: "starting" });
    this.controller = new AbortController();
    try {
      const identity = await this.state.get<string>("runtime", "identity");
      if (identity && identity.value !== this.config.tor.onionService)
        fail("conflict", "Storage belongs to a different federation identity");
      if (
        !identity &&
        !(await this.state.put("runtime", "identity", null, this.config.tor.onionService))
      )
        fail("conflict", "Federation identity changed");
      const lock = await this.state.get<{ owner: string; expiresAt: number }>("runtime", "lease");
      if (lock && lock.value.expiresAt > Date.now())
        fail("conflict", "Another runtime owns this storage");
      this.lockRevision =
        (await this.state.put("runtime", "lease", lock?.revision ?? null, {
          owner: this.owner,
          expiresAt: Date.now() + 120_000,
        })) ?? undefined;
      if (!this.lockRevision) fail("conflict", "Another runtime claimed this storage");
      const port = await this.wire.start((request) => this.handle(request));
      this.listening = true;
      this.hooks.onListening?.(port);
      options?.signal?.throwIfAborted();
      try {
        await this.wire.connector.probe?.(this.controller.signal);
        this.setStatus({ state: "ready" });
      } catch {
        this.setStatus({ state: "degraded", reason: "tor-unavailable" });
      }
      for (const peer of this.config.tor.bootstrap) this.discovery.offer(peer.onionService);
      this.loop = this.run();
      this.heartbeat = this.renewLease();
      return this.status();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  async stop(options?: { deadlineMs?: number }): Promise<void> {
    if (this.runtimeStatus.state === "stopped") return;
    const deadline = options?.deadlineMs ?? 5000;
    integer(deadline, 1, 60_000);
    this.setStatus({ state: "stopping" });
    this.controller.abort();
    for (const control of this.attempts.values()) control.abort();
    await this.wire.stop();
    if (this.listening) this.hooks.onStopped?.();
    this.listening = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all([this.loop, this.heartbeat]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, deadline);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (this.lockRevision)
      await this.state.put("runtime", "lease", this.lockRevision, {
        owner: this.owner,
        expiresAt: 0,
      });
    this.lockRevision = undefined;
    this.setStatus({ state: "stopped" });
  }
  private async registration(record: C.Stored<C.LocalAddress>): Promise<C.AddressRegistration> {
    const p = await this.state.get<Publication>("publication", record.value.identity.addressHash);
    return {
      record,
      publication:
        !record.value.enabled || (record.value.expiresAt ?? Infinity) <= Date.now()
          ? "disabled"
          : p?.value.published
            ? "published"
            : "pending",
    };
  }
  private async saveAddress(
    record: C.LocalAddress,
    expectedRevision: string | null,
    options?: C.CallOptions,
  ): Promise<C.AddressRegistration> {
    options?.signal?.throwIfAborted();
    const value = await validateLocalAddress(record);
    const hash = value.identity.addressHash;
    const existing = await this.config.storage.addresses.get(hash);
    if (existing && JSON.stringify(existing.value.identity) !== JSON.stringify(value.identity))
      fail("conflict", "Address identity cannot change");
    const publication = await this.state.get<Publication>("publication", hash);
    const result = await this.config.storage.commit(randomUUID(), [
      { kind: "address", key: hash, expectedRevision, value },
      this.state.mutation(
        "publication",
        hash,
        publication?.revision ?? null,
        {
          encoded: publication?.value.encoded ?? newLookup(hash, this.config.tor.onionService),
          storedAt: Date.now(),
          published: false,
        },
        Date.now(),
      ),
    ]);
    if (result.outcome === "conflict") fail("conflict", "Address revision changed");
    return this.registration({ value, revision: result.revisions[0]! });
  }
  private async enqueue(
    collection: "outbox" | "ingress",
    id: string,
    value: Work | Ingress,
    dueAt: number,
  ): Promise<boolean> {
    for (let retry = 0; retry < 8; retry++) {
      if (await this.state.get(collection, id)) return false;
      const count = await this.state.get<number>("capacity", collection);
      if ((count?.value ?? 0) >= this.limits.maxPendingOperations)
        fail("limit-exceeded", "Federation queue is full", true);
      const result = await this.config.storage.commit(randomUUID(), [
        this.state.mutation(collection, id, null, value, dueAt),
        this.state.mutation(
          "capacity",
          collection,
          count?.revision ?? null,
          (count?.value ?? 0) + 1,
        ),
      ]);
      if (result.outcome === "committed") return true;
    }
    fail("storage", "Federation queue is busy", true);
  }
  private async sendMessage(
    destination: C.Destination,
    source: C.DataSource,
    listener?: C.TransferListener,
    options?: C.SendOptions,
  ): Promise<C.Transfer> {
    const signal = this.signal(options);
    const identity = await destinationIdentity(destination);
    const id = options?.operationId ?? randomUUID();
    if (typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(id))
      fail("invalid-data", "Invalid operation identifier");
    const info = await source.describe();
    integer(info.byteLength, 1, this.limits.maxMessageBytes);
    const encoded = await collect(
      await source.open({ signal }),
      this.limits.maxMessageBytes,
      { signal },
      info.byteLength,
    );
    decodeMessage(encoded);
    const digest = createHash("sha256").update(encoded).digest("base64url");
    if (info.sha256 && info.sha256 !== digest)
      fail("invalid-data", "Message source integrity mismatch");
    const work: Work = {
      destination: identity,
      envelope: Buffer.from(encoded).toString("base64url"),
      digest,
      createdAt: Date.now(),
      dueAt: Date.now(),
      snapshot: {
        id,
        kind: "message",
        state: "queued",
        attempt: 0,
        bytesTransferred: 0,
        totalBytes: encoded.length,
      },
    };
    try {
      const existing = await this.state.get<Work>("outbox", id);
      if (existing) this.sameSubmission(existing.value, work);
      else if (!(await this.enqueue("outbox", id, work, work.dueAt)))
        this.sameSubmission((await this.state.get<Work>("outbox", id))!.value, work);
    } catch (error) {
      throw this.submissionError(id, error);
    }
    const transfer = this.transfer(id);
    if (listener) transfer.listen(listener);
    return transfer;
  }
  private sameSubmission(existing: Work, value: Work) {
    if (
      existing.snapshot.kind !== value.snapshot.kind ||
      existing.digest !== value.digest ||
      JSON.stringify(existing.destination) !== JSON.stringify(value.destination)
    )
      fail("conflict", "Operation identifier was already used for different content");
  }
  private submissionError(id: string, error: unknown): Error {
    if (error instanceof FederationError && error.code !== "storage") return error;
    const submission = new Error(
      "Submission could not confirm durable queuing",
    ) as C.SubmissionError;
    Object.assign(submission, {
      operationId: id,
      outcome: "unknown",
      failure: {
        code: "storage",
        retryable: true,
        message: "Submission outcome is unknown; retry the same operation",
      },
    });
    return submission;
  }
  private transfer(id: string): C.Transfer {
    const status = async (options?: C.CallOptions) => {
      options?.signal?.throwIfAborted();
      const work = await this.state.get<Work>("outbox", id);
      if (!work) fail("not-found", "Transfer is no longer retained");
      return work.value;
    };
    return {
      id,
      status: async (options) => (await status(options)).snapshot,
      wait: async (options) => {
        while (true) {
          const work = await status(options);
          if (work.snapshot.state === "completed")
            return { status: "completed", result: work.result! };
          if (work.snapshot.state === "cancelled") return { status: "cancelled" };
          if (work.snapshot.state === "failed")
            return { status: "failed", failure: work.snapshot.failure! };
          await delay(this.hooks.pollMs ?? 100, undefined, { signal: options?.signal });
        }
      },
      cancel: (options) => this.changeTransfer(id, "cancelled", options),
      resume: (options) => this.changeTransfer(id, "queued", options),
      listen: (listener) => {
        const set = this.listeners.get(id) ?? new Set();
        this.listeners.set(id, set);
        set.add(listener);
        void status()
          .then((work) => {
            if (set.has(listener))
              this.notify(listener, { type: "state", snapshot: work.snapshot });
          })
          .catch(() => {});
        return () => {
          set.delete(listener);
          if (!set.size) this.listeners.delete(id);
        };
      },
    };
  }
  private async changeTransfer(
    id: string,
    state: "queued" | "cancelled",
    options?: C.CallOptions,
  ): Promise<C.TransferSnapshot> {
    options?.signal?.throwIfAborted();
    for (let n = 0; n < 8; n++) {
      const stored = await this.state.get<Work>("outbox", id);
      if (!stored) fail("not-found", "Transfer not found");
      if (
        stored.value.snapshot.state === "completed" ||
        (state === "cancelled" && terminal(stored.value.snapshot.state))
      )
        return stored.value.snapshot;
      if (state === "queued" && !["failed", "paused"].includes(stored.value.snapshot.state))
        fail("conflict", "Only failed or paused transfers can resume");
      const next: Work = {
        ...stored.value,
        dueAt: Date.now(),
        snapshot: {
          ...stored.value.snapshot,
          state,
          nextAttemptAt: undefined,
          failure: undefined,
          attempt: state === "queued" ? 0 : stored.value.snapshot.attempt,
        },
      };
      if (
        await this.state.put(
          "outbox",
          id,
          stored.revision,
          next,
          state === "cancelled" ? Date.now() + this.limits.operationRetentionMs : Date.now(),
        )
      ) {
        this.attempts.get(id)?.abort();
        this.emit(next);
        if (state === "cancelled" && next.snapshot.kind === "archive-send") {
          // Cleanup is best effort; cancellation cannot undo an already accepted remote commit.
          try {
            await this.archives.cancel(
              id,
              json(Buffer.from(next.envelope, "base64url")) as ArchiveJob,
              AbortSignal.timeout(8000),
            );
          } catch {
            /* Session retention handles later cleanup. */
          }
        }
        if (state === "cancelled") this.archives.release(id);
        return next.snapshot;
      }
    }
    fail("conflict", "Transfer changed concurrently");
  }
  private notify(listener: C.TransferListener, event: C.TransferEvent) {
    try {
      listener.onEvent(structuredClone(event));
    } catch {
      /* User observers do not own transfer state. */
    }
  }
  private emit(work: Work) {
    const snapshot = work.snapshot;
    const event: C.TransferEvent =
      snapshot.state === "completed"
        ? { type: "completed", snapshot, result: work.result! }
        : snapshot.state === "cancelled"
          ? { type: "cancelled", snapshot }
          : snapshot.state === "failed"
            ? { type: "failed", snapshot, failure: snapshot.failure! }
            : snapshot.state === "retrying"
              ? { type: "retry", snapshot, failure: snapshot.failure! }
              : { type: "state", snapshot };
    for (const listener of this.listeners.get(snapshot.id) ?? []) this.notify(listener, event);
  }
  private async run(): Promise<void> {
    const signal = this.controller.signal;
    while (!signal.aborted) {
      try {
        // Inbound custody is processed independently of potentially slow outbound discovery.
        await Promise.all([
          this.maintain(signal),
          this.deliverDue(signal),
          this.receiveDue(signal),
        ]);
      } catch {
        if (!signal.aborted) this.setStatus({ state: "degraded", reason: "storage-unavailable" });
      }
      try {
        await delay(this.hooks.pollMs ?? 100, undefined, { signal });
      } catch {
        break;
      }
    }
  }
  private async renewLease() {
    const controller = this.controller;
    while (!controller.signal.aborted) {
      try {
        await delay(30_000, undefined, { signal: controller.signal });
        const revision = await this.state.put("runtime", "lease", this.lockRevision!, {
          owner: this.owner,
          expiresAt: Date.now() + 120_000,
        });
        if (!revision) fail("storage", "Runtime storage ownership changed");
        this.lockRevision = revision;
        try {
          await this.wire.connector.probe?.(controller.signal);
          if (!controller.signal.aborted) this.setStatus({ state: "ready" });
        } catch {
          if (!controller.signal.aborted)
            this.setStatus({ state: "degraded", reason: "tor-unavailable" });
        }
      } catch {
        if (!controller.signal.aborted) {
          controller.abort();
          this.setStatus({ state: "degraded", reason: "storage-unavailable" });
        }
        break;
      }
    }
  }
  private async maintain(signal: AbortSignal) {
    for (const endpoint of [...this.discovery.candidates].slice(0, 4)) {
      this.discovery.candidates.delete(endpoint);
      try {
        await this.discovery.probe(endpoint, AbortSignal.any([signal, AbortSignal.timeout(8000)]));
      } catch {
        if (signal.aborted) return;
      }
    }
    let count = 0;
    for await (const p of this.state.scan<Publication>("publication", Date.now())) {
      if (++count > 16 || signal.aborted) break;
      const address = await this.config.storage.addresses.get(p.key);
      if (!address?.value.enabled || (address.value.expiresAt ?? Infinity) <= Date.now()) {
        await this.state.put("publication", p.key, p.revision, { ...p.value, published: false });
        continue;
      }
      const published = await this.discovery.publish(p.key, p.value, signal);
      signal.throwIfAborted();
      await this.state.put(
        "publication",
        p.key,
        p.revision,
        { ...p.value, published, storedAt: Date.now() },
        Date.now() + (published ? 60 * 60_000 : (this.hooks.retryMs ?? 60_000)),
      );
    }
    await this.prune("replica", signal);
    await this.prune("outbox", signal);
    await this.prune("ingress", signal);
    await this.archives.maintain(signal);
  }
  private async prune(collection: "replica" | "outbox" | "ingress", signal: AbortSignal) {
    let processed = 0;
    for await (const stored of this.state.scan<any>(collection, Date.now())) {
      if (signal.aborted || ++processed > 32) return;
      if (collection === "outbox" && !terminal(stored.value.snapshot.state)) continue;
      if (collection === "ingress" && !stored.value.done) continue;
      const key = collection === "replica" ? "replicas" : collection;
      const count = await this.state.get<number>("capacity", key);
      const changes = [
        this.state.mutation(collection, stored.key, stored.revision, null),
        this.state.mutation(
          "capacity",
          key,
          count?.revision ?? null,
          Math.max(0, (count?.value ?? 0) - 1),
        ),
      ];
      if (collection === "outbox")
        for (const related of ["archive-init", "archive-outgoing"]) {
          const record = await this.state.get(related, stored.key);
          if (record) changes.push(this.state.mutation(related, stored.key, record.revision, null));
        }
      const result = await this.config.storage.commit(randomUUID(), changes);
      if (result.outcome === "committed" && collection === "outbox") {
        this.archives.release(stored.key);
        this.listeners.delete(stored.key);
      }
    }
  }
  private async deliverDue(signal: AbortSignal) {
    const batch: Promise<void>[] = [];
    for await (const stored of this.state.scan<Work>("outbox", Date.now())) {
      if (signal.aborted) return;
      if (terminal(stored.value.snapshot.state) || stored.value.snapshot.state === "paused")
        continue;
      batch.push(this.deliver(stored, signal));
      if (batch.length >= this.limits.maxConcurrentTransfers) break;
    }
    await Promise.all(batch);
  }
  private async deliver(
    stored: { key: string; value: Work; revision: string },
    signal: AbortSignal,
  ) {
    const control = new AbortController();
    this.attempts.set(stored.key, control);
    const bounded = AbortSignal.any([
      signal,
      control.signal,
      ...(stored.value.snapshot.kind === "message" ? [AbortSignal.timeout(60_000)] : []),
    ]);
    const current: Work = {
      ...stored.value,
      snapshot: {
        ...stored.value.snapshot,
        state: "running",
        attempt: stored.value.snapshot.attempt + 1,
        failure: undefined,
        nextAttemptAt: undefined,
      },
    };
    const revision = await this.state.put(
      "outbox",
      stored.key,
      stored.revision,
      current,
      Date.now() + 120_000,
    );
    if (!revision) {
      this.attempts.delete(stored.key);
      return;
    }
    this.emit(current);
    try {
      if (current.snapshot.kind !== "message") {
        const result = await this.archives.execute(
          stored.key,
          current.snapshot.kind,
          current.destination,
          json(Buffer.from(current.envelope, "base64url")) as ArchiveJob,
          bounded,
          (bytesTransferred, totalBytes) => {
            current.snapshot = { ...current.snapshot, bytesTransferred, totalBytes };
            for (const listener of this.listeners.get(stored.key) ?? [])
              this.notify(listener, { type: "progress", snapshot: current.snapshot });
          },
        );
        bounded.throwIfAborted();
        const completed: Work = {
          ...current,
          result,
          snapshot: {
            ...current.snapshot,
            state: "completed",
            bytesTransferred: current.snapshot.totalBytes,
          },
        };
        if (
          await this.state.put(
            "outbox",
            stored.key,
            revision,
            completed,
            Date.now() + this.limits.operationRetentionMs,
          )
        ) {
          this.emit(completed);
          this.archives.release(stored.key);
        }
        return;
      }
      const destination = await this.discovery.lookup(current.destination, bounded);
      if (!destination) fail("unavailable", "Destination is not currently published", true);
      const route = destination.record.targets[0];
      const response = await this.wire.request(route.onionService, {
        path: route.deliveryPath,
        signal: bounded,
        body: Buffer.from(current.envelope, "base64url"),
        headers: {
          "content-type": "application/octet-stream",
          "X-Unolock-Address-Hash": current.destination.addressHash,
        },
      });
      const body = await collect(response.body, 8192, { signal: bounded });
      if (!isAcceptance(response.status, json(body)))
        fail("unavailable", "Peer did not acknowledge node custody", true);
      const completed: Work = {
        ...current,
        result: { kind: "message", outcome: "delivered" },
        snapshot: {
          ...current.snapshot,
          state: "completed",
          bytesTransferred: current.snapshot.totalBytes,
        },
      };
      bounded.throwIfAborted();
      if (
        await this.state.put(
          "outbox",
          stored.key,
          revision,
          completed,
          Date.now() + this.limits.operationRetentionMs,
        )
      )
        this.emit(completed);
    } catch (error) {
      const parsedFailure = failure(error);
      // Message inputs were validated before queuing. Malformed remote replies
      // are failed delivery attempts, not permanent errors in caller data.
      const reason =
        current.snapshot.kind === "message" ? { ...parsedFailure, retryable: true } : parsedFailure;
      const state = signal.aborted
        ? "queued"
        : ["receiver-unavailable", "source-unavailable"].includes(reason.code)
          ? "paused"
          : current.snapshot.attempt >= this.limits.maxAttempts || !reason.retryable
            ? "failed"
            : "retrying";
      const nextAttemptAt =
        Date.now() +
        Math.min(
          15 * 60_000,
          (this.hooks.retryMs ?? 1000) * 2 ** Math.min(16, current.snapshot.attempt - 1),
        );
      const next: Work = {
        ...current,
        dueAt: nextAttemptAt,
        snapshot: {
          ...current.snapshot,
          state,
          failure: reason,
          nextAttemptAt: state === "retrying" ? nextAttemptAt : undefined,
        },
      };
      if (
        await this.state.put(
          "outbox",
          stored.key,
          revision,
          next,
          state === "failed"
            ? Date.now() + this.limits.operationRetentionMs
            : signal.aborted
              ? Date.now()
              : nextAttemptAt,
        )
      )
        this.emit(next);
    } finally {
      this.attempts.delete(stored.key);
    }
  }
  private async receiveDue(signal: AbortSignal) {
    let count = 0;
    for await (const stored of this.state.scan<Ingress>("ingress", Date.now())) {
      if (signal.aborted || ++count > 16) return;
      if (stored.value.done) continue;
      const input = stored.value;
      const encoded = Buffer.from(input.envelope, "base64url");
      const message = decodeMessage(encoded);
      let done = false;
      try {
        const local = await this.config.storage.addresses.get(input.addressHash);
        if (
          !local?.value.enabled ||
          (local.value.expiresAt ?? Infinity) <= Date.now() ||
          !this.config.messages ||
          !this.config.authorization
        ) {
          done = true;
          continue;
        }
        if (message.encryptedAttachmentDescriptors.length && !local.value.policy.allowAttachments) {
          done = true;
          continue;
        }
        const canonicalRequest = bytes({
          addressHash: input.addressHash,
          envelope: input.envelope,
        });
        const request: C.AuthorizationRequest = {
          operation: "message-receive",
          target: { addressHash: input.addressHash },
          canonicalRequest,
          requestHash: createHash("sha256").update(canonicalRequest).digest("hex"),
          submitted: [],
          signal,
        };
        const authority = await this.config.authorization.resolveAuthority(request);
        if (
          !authority ||
          (await this.config.authorization.authorize(request, authority)) !== "allow"
        ) {
          done = true;
          continue;
        }
        // Sender authenticity is inside the sealed application envelope, not this transport wrapper.
        const source = tracked(
          await byteSource(encoded).open({ signal }),
          { byteLength: encoded.length },
          signal,
          () => {},
        );
        try {
          await this.config.messages.receiver.receive(source.stream, {
            ...message,
            deliveryId: stored.key,
            destinationAddressHash: input.addressHash,
            byteLength: encoded.length,
            signal,
          });
          source.assertComplete();
          done = true;
        } finally {
          if (!source.stream.locked) await source.stream.cancel().catch(() => {});
        }
      } catch (error) {
        done =
          !signal.aborted &&
          ((error as C.ReceiveError)?.retryable === false ||
            input.attempt + 1 >= this.limits.maxAttempts);
      } finally {
        if (!signal.aborted)
          await this.state.put(
            "ingress",
            stored.key,
            stored.revision,
            { ...input, attempt: input.attempt + 1, done },
            Date.now() + (done ? this.limits.operationRetentionMs : (this.hooks.retryMs ?? 1000)),
          );
      }
    }
  }
  private async handle(request: Parameters<WireHandler>[0]): ReturnType<WireHandler> {
    if (Date.now() - this.windowAt >= 60_000) {
      this.windowAt = Date.now();
      this.requestCount = 0;
    }
    if (++this.requestCount > 600 || this.activeRequests >= 16)
      return { status: 429, body: bytes({ type: "THROTTLED" }) };
    this.activeRequests++;
    try {
      if (request.path.startsWith(archivePath)) return await this.archives.handle(request);
      if (request.method !== "POST") return { status: 405 };
      if ([messagePath, legacyMessagePath].includes(request.path)) {
        const addressHash = hashAddress(request.headers["x-unolock-address-hash"]);
        const encoded = await collect(request.body, this.limits.maxMessageBytes, {
          signal: request.signal,
        });
        decodeMessage(encoded);
        const id = createHash("sha256")
          .update("federation-message-custody-v1\0")
          .update(addressHash)
          .update("\0")
          .update(encoded)
          .digest("hex");
        // Durable generic staging precedes recipient-specific admission, matching both reference hosts.
        if (!this.config.messages) return { status: 503, body: bytes({ type: "SERVER" }) };
        await this.enqueue(
          "ingress",
          id,
          {
            addressHash,
            envelope: Buffer.from(encoded).toString("base64url"),
            attempt: 0,
            done: false,
            createdAt: Date.now(),
          },
          Date.now(),
        );
        return { status: 202, body: bytes(acceptance) };
      }
      const raw = json(await collect(request.body, 8192, { signal: request.signal }));
      if (request.path === gridPath + "ping") {
        const r = object(raw, ["type", "onionService"]);
        if (r.type !== "unolock.grid.ping.v1") fail("invalid-data", "Invalid ping request");
        this.discovery.offer(r.onionService);
        return {
          status: 200,
          body: bytes({ type: "unolock.grid.ping.response.v1", ok: true, checkedAt: Date.now() }),
        };
      }
      if (request.path === gridPath + "find-node") {
        const r = object(raw, ["type", "routingKey"]);
        if (r.type !== "unolock.grid.findNode.v1") fail("invalid-data", "Invalid lookup request");
        const target = base64(r.routingKey, 32);
        if (target.length !== 32) fail("invalid-data", "Invalid routing key");
        return {
          status: 200,
          body: bytes({
            type: "unolock.grid.findNode.response.v1",
            peers: this.discovery.table
              .closest(Buffer.from(target).toString("hex"), 20)
              .map((c) => ({ onionService: c.endpoint })),
          }),
        };
      }
      if (request.path === gridPath + "find-value") {
        const r = object(raw, ["type", "addressHash"]);
        if (r.type !== "unolock.grid.findValue.v1") fail("invalid-data", "Invalid lookup request");
        const addressHash = hashAddress(r.addressHash);
        const found = await this.discovery.findLocal(addressHash);
        return {
          status: 200,
          body: bytes({
            type: "unolock.grid.findValue.response.v1",
            found: !!found,
            addressHash,
            ...(found ? { lookupValue: found.encoded, storedAt: found.storedAt } : {}),
          }),
        };
      }
      if (request.path === gridPath + "put-value") {
        const r = object(raw, ["type", "addressHash", "lookupValue"]);
        if (r.type !== "unolock.grid.putValue.v1") fail("invalid-data", "Invalid lookup request");
        const addressHash = hashAddress(r.addressHash);
        const storedAt = await this.discovery.putReplica(addressHash, r.lookupValue);
        return {
          status: 200,
          body: bytes({
            type: "unolock.grid.putValue.response.v1",
            stored: true,
            addressHash,
            storedAt,
          }),
        };
      }
      if (request.path === keyPath) {
        const r = object(raw, ["type", "addressHash"]);
        if (r.type !== "unolock.receiveAddress.publicKey.v1")
          fail("invalid-data", "Invalid key request");
        const addressHash = hashAddress(r.addressHash);
        const local = await this.config.storage.addresses.get(addressHash);
        const found = local?.value.enabled && (local.value.expiresAt ?? Infinity) > Date.now();
        return {
          status: 200,
          body: bytes({
            type: "unolock.receiveAddress.publicKey.response.v1",
            found: !!found,
            addressHash,
            ...(found ? { ...local.value.keys, ...local.value.policy } : {}),
          }),
        };
      }
      return { status: 404 };
    } finally {
      this.activeRequests--;
    }
  }
}
