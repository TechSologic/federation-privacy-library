import { lookup } from "node:dns/promises";
import { BlockList, isIP, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { FederationError, fail } from "./errors.js";
import { validateFederationOnionService } from "./protocol/lookupRecords.js";
import {
  federationDirectPathPrefix,
  normalizeFederationDirectOrigin,
} from "./protocol/networking.js";

/** Operator policy. Tor and its stable identity remain mandatory in both modes. */
export interface FederationNetworkingConfiguration {
  readonly enabled: boolean;
  readonly directOrigin?: string;
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
  readonly archiveDirectOrigin: string | undefined;
  /** Always Tor: discovery, public keys, messaging and archive controls. */
  connect(
    onionService: string,
    options?: { signal?: AbortSignal },
  ): Promise<FederationNetworkConnection>;
  /** Archive bytes only; cold or expired endpoints use Tor without a discovery probe. */
  connectArchive(
    onionService: string,
    options?: { signal?: AbortSignal },
  ): Promise<FederationNetworkConnection>;
  /** Host adapters call this only for successful responses received through the
   * authenticated Tor connection to this exact onion service, never from clients,
   * DHT record contents, direct responses, or another peer's assertions. */
  acceptTorArchiveEndpoint(onionService: string, value: unknown): void;
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
  private readonly failures = new Map<string, number>();
  private readonly archiveEndpoints = new Map<string, { origin: string; until: number }>();
  private closed = false;
  private dnsInFlight = 0;

  get archiveDirectOrigin(): string | undefined {
    return this.enabled ? this.policy.directOrigin : undefined;
  }

  get enabled(): boolean {
    return !this.closed && this.policy.enabled;
  }

  constructor(
    private readonly onionService: string | undefined,
    private readonly tor: FederationOnionConnector | undefined,
    policy: FederationNetworkingConfiguration = { enabled: false },
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
    return {
      enabled: policy.enabled,
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
    this.failures.clear();
    this.archiveEndpoints.clear();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
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

  acceptTorArchiveEndpoint(onionService: string, value: unknown): void {
    if (this.closed) return;
    validateFederationOnionService(onionService);
    this.archiveEndpoints.delete(onionService);
    if (value === undefined || value === onionService) return;
    let origin: string;
    try {
      origin = normalizeFederationDirectOrigin(value);
    } catch {
      return;
    }
    if (this.archiveEndpoints.size >= 512)
      this.archiveEndpoints.delete(this.archiveEndpoints.keys().next().value!);
    this.archiveEndpoints.set(onionService, { origin, until: Date.now() + 5 * 60_000 });
  }

  async connectArchive(
    onionService: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<FederationNetworkConnection> {
    validateFederationOnionService(onionService);
    const endpoint = this.archiveEndpoints.get(onionService);
    if (
      !this.enabled ||
      !endpoint ||
      endpoint.until <= Date.now() ||
      (this.failures.get(onionService) ?? 0) > Date.now()
    )
      return this.connect(onionService, options);
    const op = this.operation(options.signal);
    try {
      const generation = this.generation.signal;
      const signal = AbortSignal.any([op.signal, generation]);
      try {
        const socket = await this.openDirect(endpoint.origin, signal);
        if (signal.aborted) {
          socket.destroy();
          signal.throwIfAborted();
        }
        return {
          socket,
          transport: "direct",
          origin: endpoint.origin,
          pathPrefix: federationDirectPathPrefix,
        };
      } catch {
        op.signal.throwIfAborted();
        if (!generation.aborted) this.reportFailure(onionService);
      }
    } finally {
      op.done();
    }
    // No application bytes were sent. Later retries belong to the operation owner.
    return this.connect(onionService, options);
  }

  reportFailure(onionService: string): void {
    validateFederationOnionService(onionService);
    if (!this.failures.has(onionService) && this.failures.size >= 512)
      this.failures.delete(this.failures.keys().next().value!);
    this.failures.set(onionService, Date.now() + 30_000);
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

  async stop(): Promise<void> {
    this.closed = true;
    this.generation.abort();
    for (const operation of this.active) operation.abort();
    for (const socket of this.sockets) socket.destroy();
    this.failures.clear();
    this.archiveEndpoints.clear();
  }

  resume(): void {
    if (!this.closed) return;
    this.closed = false;
    this.generation = new AbortController();
  }
}
