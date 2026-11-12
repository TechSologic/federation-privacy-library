import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { Agent, request } from "node:http";
import { BlockList, isIP, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { FederationError, fail } from "./errors.js";
import { validateFederationOnionService } from "./protocol/lookupRecords.js";
import {
  federationDirectPathPrefix,
  federationNetworkingChallenge,
  federationNetworkingLeaseMs,
  federationNetworkingMaxBytes,
  federationNetworkingPath,
  normalizeFederationDirectOrigin,
  validateFederationNetworkingDescriptor,
  type FederationNetworkingDescriptor,
} from "./protocol/networking.js";

/** Operator policy. Tor and its stable identity remain mandatory in both modes. */
export interface FederationNetworkingConfiguration {
  readonly enabled: boolean;
  readonly directOrigin?: string;
  /** HTTPS introductions, resolved into the same onion discovery graph. Maximum 16. */
  readonly bootstrapOrigins?: readonly string[];
}

/** Encrypted durable introductions, separate from permanent Receive Address pins.
 * Retain configured origins across restarts and policy changes; prune removed
 * configuration entries. set resolves only after durable storage. */
export interface FederationBootstrapStorage {
  get(origin: string): Promise<string | undefined>;
  set(origin: string, onionService: string, options: { signal: AbortSignal }): Promise<void>;
}

/** Host provider must connect only through Tor; the facade owns transport selection.
 * Detach the connection signal before handing off the socket. The HTTP owner
 * controls cancellation/deadlines after handoff, including streaming transfers. */
export interface FederationOnionConnector {
  connect(onionService: string, signal: AbortSignal): Promise<Socket>;
}

export interface FederationNetworkConnection {
  readonly socket: Socket;
  readonly transport: "tor" | "direct";
  readonly origin: string;
  /** Prepend to the unchanged protocol path. Public ingress must gate this namespace. */
  readonly pathPrefix: string;
}

export interface FederationNetworking {
  readonly enabled: boolean;
  connect(
    onionService: string,
    options?: { signal?: AbortSignal },
  ): Promise<FederationNetworkConnection>;
  /** HTTPS bootstrap is only an introduction until its onion binding is checked over Tor. */
  bootstrap(origin: string, options?: { signal?: AbortSignal }): Promise<{ onionService: string }>;
  /** Configured domain seeds, with retained onion fallback and bounded refresh.
   * Tor-only mode reads storage without DNS or HTTPS. */
  bootstrapPeers(options?: { signal?: AbortSignal }): Promise<{ onionService: string }[]>;
  /** Serve only over the onion listener or explicitly enabled direct ingress. */
  describe(request: unknown): FederationNetworkingDescriptor;
  /** Withdraw direct policy immediately, including pending attempts and open direct sockets. */
  configure(policy: FederationNetworkingConfiguration): void;
  /** An uncertain application attempt is retried by its durable owner, never by this selector. */
  reportFailure(onionService: string): void;
}

const blockedV4 = new BlockList();
for (const [host, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blockedV4.addSubnet(host, bits, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new BlockList();
for (const [host, bits] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  blockedV6.addSubnet(host, bits, "ipv6");

function publicAddress(address: string): boolean {
  if (address.includes("%")) return false;
  const family = isIP(address);
  return family === 4
    ? !blockedV4.check(address, "ipv4")
    : family === 6 && globalV6.check(address, "ipv6") && !blockedV6.check(address, "ipv6");
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

/** Internal implementation; applications obtain this through createFederation().network. */
export class FederationNetwork implements FederationNetworking {
  private policy: FederationNetworkingConfiguration;
  private generation = new AbortController();
  private readonly sockets = new Set<Socket>();
  private readonly active = new Set<AbortController>();
  private readonly cache = new Map<
    string,
    { descriptor?: FederationNetworkingDescriptor; until: number }
  >();
  private readonly pending = new Map<string, Promise<FederationNetworkingDescriptor | undefined>>();
  private closed = false;
  private dnsInFlight = 0;
  private readonly bootstrapRefresh = new Map<string, number>();
  private readonly bootstrapPending = new Map<string, Promise<{ onionService: string }>>();

  get enabled(): boolean {
    return !this.closed && this.policy.enabled;
  }

  constructor(
    private readonly onionService: string | undefined,
    private readonly tor: FederationOnionConnector | undefined,
    policy: FederationNetworkingConfiguration = { enabled: false },
    private readonly bootstrapStorage?: FederationBootstrapStorage,
  ) {
    this.policy = this.validatePolicy(policy);
  }

  private validatePolicy(
    policy: FederationNetworkingConfiguration,
  ): FederationNetworkingConfiguration {
    if (typeof policy.enabled !== "boolean")
      fail("invalid-data", "Direct networking requires a boolean policy");
    if (policy.enabled && (!this.onionService || !this.tor))
      fail("invalid-data", "Direct networking requires a Tor connector and onion identity");
    if (this.onionService) validateFederationOnionService(this.onionService);
    if (policy.enabled && !policy.directOrigin)
      fail("invalid-data", "Direct networking requires a public HTTPS origin");
    if (
      policy.bootstrapOrigins &&
      (!Array.isArray(policy.bootstrapOrigins) || policy.bootstrapOrigins.length > 16)
    )
      fail("invalid-data", "Configure at most 16 HTTPS bootstrap origins");
    if (policy.bootstrapOrigins?.length && !this.bootstrapStorage)
      fail("invalid-data", "HTTPS bootstrap configuration requires durable bootstrap storage");
    return {
      enabled: policy.enabled,
      bootstrapOrigins: [
        ...new Set((policy.bootstrapOrigins ?? []).map(normalizeFederationDirectOrigin)),
      ],
      ...(policy.directOrigin
        ? { directOrigin: normalizeFederationDirectOrigin(policy.directOrigin) }
        : {}),
    };
  }

  configure(policy: FederationNetworkingConfiguration): void {
    if (this.closed) fail("unavailable", "Federation networking is stopped");
    const next = this.validatePolicy(policy);
    this.policy = next;
    this.generation.abort(
      new FederationError("unavailable", "Direct networking policy changed", true),
    );
    this.generation = new AbortController();
    this.cache.clear();
    this.pending.clear();
    this.bootstrapRefresh.clear();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  describe(request: unknown): FederationNetworkingDescriptor {
    const challenge = federationNetworkingChallenge(request);
    if (this.closed || !this.onionService)
      fail("unavailable", "Federation onion identity is unavailable");
    return {
      type: "unolock.federation.networking.v1",
      onionService: this.onionService,
      enabled: this.policy.enabled,
      challenge,
      expiresAt: Date.now() + federationNetworkingLeaseMs,
      ...(this.policy.enabled ? { directOrigin: this.policy.directOrigin! } : {}),
    };
  }

  private operation(signal?: AbortSignal) {
    if (this.closed || !this.tor) fail("unavailable", "Federation Tor connector is unavailable");
    signal?.throwIfAborted();
    if (this.active.size >= 32)
      fail("limit-exceeded", "Federation network connection capacity reached", true);
    const controller = new AbortController();
    this.active.add(controller);
    return {
      signal: AbortSignal.any([
        controller.signal,
        ...(signal ? [signal] : []),
        AbortSignal.timeout(60_000),
      ]),
      done: () => this.active.delete(controller),
    };
  }

  async connect(
    onionService: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<FederationNetworkConnection> {
    validateFederationOnionService(onionService);
    const op = this.operation(options.signal);
    try {
      if (this.policy.enabled) {
        const generation = this.generation.signal;
        try {
          const directSignal = AbortSignal.any([op.signal, generation]);
          const descriptor = await this.discover(onionService, directSignal);
          if (descriptor?.enabled && this.policy.enabled) {
            const socket = await this.openDirect(descriptor.directOrigin!, directSignal);
            if (directSignal.aborted) {
              socket.destroy();
              directSignal.throwIfAborted();
            }
            return {
              socket,
              transport: "direct",
              origin: descriptor.directOrigin!,
              pathPrefix: federationDirectPathPrefix,
            };
          }
        } catch {
          op.signal.throwIfAborted();
          if (!generation.aborted) this.reportFailure(onionService);
        }
      }
      op.signal.throwIfAborted();
      const socket = await this.tor!.connect(onionService, op.signal);
      if (op.signal.aborted) {
        socket.destroy();
        op.signal.throwIfAborted();
      }
      return { socket, transport: "tor", origin: onionService, pathPrefix: "" };
    } finally {
      op.done();
    }
  }

  async bootstrap(
    origin: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ onionService: string }> {
    origin = normalizeFederationDirectOrigin(origin);
    const op = this.operation(options.signal);
    const signal = AbortSignal.any([op.signal, this.generation.signal]);
    try {
      if (!this.policy.enabled) {
        const retained = await abortable(
          this.bootstrapStorage?.get(origin) ?? Promise.resolve(undefined),
          signal,
        );
        signal.throwIfAborted();
        if (retained) return { onionService: validateFederationOnionService(retained) };
        fail("unauthorized", "Unknown HTTPS bootstrap requires direct networking to be enabled");
      }
      const challenge = randomBytes(32).toString("base64url");
      const socket = await this.openDirect(origin, signal);
      const introduction = validateFederationNetworkingDescriptor(
        await this.readDescriptor(socket, origin, federationDirectPathPrefix, challenge, signal),
        { challenge },
      );
      if (!introduction.enabled || introduction.directOrigin !== origin)
        fail("unauthorized", "HTTPS bootstrap does not advertise this origin");
      const verified = await this.discover(introduction.onionService, signal, true);
      signal.throwIfAborted();
      if (!verified?.enabled || verified.directOrigin !== origin)
        fail("unauthorized", "HTTPS bootstrap does not match its onion identity");
      await this.bootstrapStorage?.set(origin, verified.onionService, { signal });
      signal.throwIfAborted();
      return { onionService: verified.onionService };
    } finally {
      op.done();
    }
  }

  async bootstrapPeers(
    options: { signal?: AbortSignal } = {},
  ): Promise<{ onionService: string }[]> {
    if (!this.policy.bootstrapOrigins?.length) return [];
    const op = this.operation(options.signal);
    try {
      const peers = await Promise.all(
        (this.policy.bootstrapOrigins ?? []).map(async (origin) => {
          const retained = await abortable(this.bootstrapStorage!.get(origin), op.signal);
          op.signal.throwIfAborted();
          const fallback = retained
            ? { onionService: validateFederationOnionService(retained) }
            : undefined;
          let pending = this.bootstrapPending.get(origin);
          if (!this.enabled || (!pending && (this.bootstrapRefresh.get(origin) ?? 0) > Date.now()))
            return fallback;
          if (!pending) {
            this.bootstrapRefresh.set(origin, Date.now() + 30_000);
            pending = this.bootstrap(origin)
              .then((peer) => {
                this.bootstrapRefresh.set(origin, Date.now() + federationNetworkingLeaseMs);
                return peer;
              })
              .finally(() => this.bootstrapPending.delete(origin));
            this.bootstrapPending.set(origin, pending);
          }
          return abortable(pending, op.signal).catch(() => fallback);
        }),
      );
      op.signal.throwIfAborted();
      return [
        ...new Map(
          peers.filter((peer) => peer !== undefined).map((peer) => [peer.onionService, peer]),
        ).values(),
      ];
    } finally {
      op.done();
    }
  }

  private remember(onion: string, descriptor?: FederationNetworkingDescriptor): void {
    if (!this.cache.has(onion) && this.cache.size >= 512)
      this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(onion, { descriptor, until: descriptor?.expiresAt ?? Date.now() + 30_000 });
  }

  reportFailure(onionService: string): void {
    validateFederationOnionService(onionService);
    this.remember(onionService);
  }

  private async discover(
    onion: string,
    signal: AbortSignal,
    fresh = false,
  ): Promise<FederationNetworkingDescriptor | undefined> {
    const cached = this.cache.get(onion);
    if (!fresh && cached && cached.until > Date.now()) return cached.descriptor;
    // A shared probe has its own lifetime; one caller's cancellation must not poison other callers.
    const existing = this.pending.get(onion);
    if (existing) return abortable(existing, signal);
    if (this.pending.size >= 32) return undefined;
    const generation = this.generation.signal;
    const probeSignal = AbortSignal.any([generation, AbortSignal.timeout(15_000)]);
    const probe = (async () => {
      const challenge = randomBytes(32).toString("base64url");
      try {
        const socket = await this.tor!.connect(onion, probeSignal);
        if (probeSignal.aborted) {
          socket.destroy();
          probeSignal.throwIfAborted();
        }
        const descriptor = validateFederationNetworkingDescriptor(
          await this.readDescriptor(socket, onion, "", challenge, probeSignal),
          { onionService: onion, challenge },
        );
        probeSignal.throwIfAborted();
        this.remember(onion, descriptor);
        return descriptor;
      } catch {
        if (!probeSignal.aborted) this.remember(onion);
        return undefined;
      }
    })();
    this.pending.set(onion, probe);
    void probe.finally(() => {
      if (this.pending.get(onion) === probe) this.pending.delete(onion);
    });
    return abortable(probe, signal);
  }

  private async openDirect(origin: string, signal: AbortSignal): Promise<Socket> {
    if (this.sockets.size >= 64)
      fail("limit-exceeded", "Direct federation socket capacity reached", true);
    const url = new URL(normalizeFederationDirectOrigin(origin));
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
    deadline.throwIfAborted();
    if (this.dnsInFlight >= 32)
      fail("limit-exceeded", "Direct federation DNS capacity reached", true);
    this.dnsInFlight++;
    // System DNS cannot always be cancelled: retain its slot until it actually settles.
    const query = Promise.resolve()
      .then(() => {
        deadline.throwIfAborted();
        return lookup(url.hostname, { all: true, verbatim: true });
      })
      .finally(() => {
        this.dnsInFlight--;
      });
    const addresses = await abortable(query, deadline);
    deadline.throwIfAborted();
    if (
      !addresses.length ||
      addresses.length > 32 ||
      addresses.some((entry) => !publicAddress(entry.address))
    )
      fail("unauthorized", "Direct federation DNS contains a non-public destination");
    if (this.sockets.size >= 64)
      fail("limit-exceeded", "Direct federation socket capacity reached", true);
    // Connect to the checked literal. Never give the hostname to a second DNS resolver.
    const socket = tlsConnect({
      host: addresses[0]!.address,
      port: Number(url.port || 443),
      servername: url.hostname,
      rejectUnauthorized: true,
      ALPNProtocols: ["http/1.1"],
    });
    // Preserve the hand-off gap before the caller attaches its HTTP error handler.
    socket.on("error", () => {});
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    try {
      await new Promise<void>((resolve, reject) => {
        const done = (error?: Error) => {
          deadline.removeEventListener("abort", abort);
          socket.off("error", errorHandler);
          socket.off("secureConnect", secure);
          socket.off("close", closed);
          if (error) reject(error);
          else resolve();
        };
        const abort = () =>
          done(new FederationError("unavailable", "Direct federation connection cancelled", true));
        const errorHandler = (error: Error) => done(error);
        const closed = () =>
          done(new FederationError("unavailable", "Direct federation connection closed", true));
        const secure = () =>
          done(
            socket.authorized
              ? undefined
              : new FederationError("unauthorized", "Invalid federation TLS certificate"),
          );
        deadline.addEventListener("abort", abort, { once: true });
        socket.once("error", errorHandler);
        socket.once("close", closed);
        socket.once("secureConnect", secure);
        if (deadline.aborted) abort();
      });
      deadline.throwIfAborted();
      return socket;
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }

  private readDescriptor(
    socket: Socket,
    origin: string,
    prefix: string,
    challenge: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    const body = Buffer.from(
      JSON.stringify({ type: "unolock.federation.networking.request.v1", challenge }),
    );
    const agent = new Agent({ keepAlive: false });
    agent.createConnection = (() => socket) as typeof agent.createConnection;
    const url = new URL(origin);
    return new Promise<unknown>((resolve, reject) => {
      const req = request(
        {
          hostname: url.hostname,
          port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
          path: prefix + federationNetworkingPath,
          method: "POST",
          agent,
          signal,
          maxHeaderSize: 8192,
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "content-length": body.byteLength,
            connection: "close",
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > federationNetworkingMaxBytes)
              res.destroy(
                new FederationError("limit-exceeded", "Networking descriptor is too large"),
              );
            else chunks.push(chunk);
          });
          res.once("error", reject);
          res.once("end", () => {
            try {
              if (res.statusCode !== 200 || !res.complete)
                fail("unavailable", "Networking descriptor is unavailable");
              resolve(
                JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))),
              );
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.once("error", reject);
      req.once("socket", (connected) => connected.resume());
      req.end(body);
    }).finally(() => {
      socket.destroy();
      agent.destroy();
    });
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.generation.abort();
    for (const operation of this.active) operation.abort();
    for (const socket of this.sockets) socket.destroy();
    await Promise.allSettled([...this.pending.values()]);
    this.pending.clear();
    this.cache.clear();
  }

  resume(): void {
    if (!this.closed) return;
    this.closed = false;
    this.generation = new AbortController();
  }
}
