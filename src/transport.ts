import {
  Agent,
  request,
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { connect, type Socket } from "node:net";
import { Readable } from "node:stream";
import { once } from "node:events";
import type { ByteStream, TorConfiguration } from "./contracts.js";
import { onion } from "./address.js";
import { collect } from "./streams.js";
import { fail, FederationError, integer } from "./errors.js";
import { lookupRequestMaxBytes } from "./protocol/lookup.js";

export interface WireRequest {
  method?: "GET" | "POST" | "PUT";
  path: string;
  body?: Uint8Array | ByteStream;
  headers?: Record<string, string>;
  signal: AbortSignal;
  maxResponseBytes?: number;
  /** Archive is reserved for routes that stream archive object bytes. */
  deadlineClass?: "control" | "archive";
}
export interface WireResponse {
  status: number;
  headers: Record<string, string>;
  body: ByteStream;
}
export interface Connector {
  connect(endpoint: string, signal: AbortSignal): Promise<Socket>;
  probe?(signal: AbortSignal): Promise<void>;
}
export type WireHandler = (request: {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: ByteStream;
  signal: AbortSignal;
}) => Promise<{
  status: number;
  body?: Uint8Array | ByteStream;
  headers?: Record<string, string>;
}>;

export interface WireDeadlines {
  readonly controlMs: number;
  readonly archiveMs: number;
}

const defaultDeadlines: WireDeadlines = {
  controlMs: 60_000,
  archiveMs: 24 * 60 * 60_000,
};
const archiveStreamPaths = new Set([
  "/federation/v1/archive/object",
  "/federation/v1/archive/object/read",
  "/federation/v1/archive/multipart/part",
]);
const deadlineClass = (path: string): "control" | "archive" =>
  archiveStreamPaths.has(path) ? "archive" : "control";

export class HttpWire {
  private server?: Server;
  private readonly agents = new Set<Agent>();
  private readonly requests = new Set<AbortController>();
  constructor(
    readonly connector: Connector,
    private readonly config: TorConfiguration,
    deadlines: number | WireDeadlines = defaultDeadlines,
  ) {
    this.deadlines =
      typeof deadlines === "number" ? { controlMs: deadlines, archiveMs: deadlines } : deadlines;
    integer(this.deadlines.controlMs, 100, defaultDeadlines.controlMs);
    integer(this.deadlines.archiveMs, 100, defaultDeadlines.archiveMs);
  }
  private readonly deadlines: WireDeadlines;
  private deadline(path: string, requested?: "control" | "archive"): number {
    const kind = requested ?? deadlineClass(path);
    return kind === "archive" ? this.deadlines.archiveMs : this.deadlines.controlMs;
  }
  async start(handler: WireHandler): Promise<number> {
    if (this.server) fail("conflict", "Listener already started");
    this.server = createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
      // Hold admission for the entire response stream, including archive reads.
      if (this.requests.size >= 16) {
        res.writeHead(503, {
          "content-type": "application/json",
          connection: "close",
          "retry-after": "1",
        });
        res.end('{"type":"THROTTLED"}');
        return;
      }
      const control = new AbortController();
      const signal = AbortSignal.any([
        control.signal,
        AbortSignal.timeout(this.deadline(req.url ?? "")),
      ]);
      this.requests.add(control);
      req.once("aborted", () => control.abort());
      res.once("close", () => {
        if (!res.writableFinished) control.abort();
      });
      void this.respond(req, res, signal, handler).finally(() => this.requests.delete(control));
    });
    this.server.maxHeadersCount = 64;
    this.server.maxConnections = 64;
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 15_000;
    this.server.setTimeout(30_000, (socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.config.listen.port, this.config.listen.host, () => {
        this.server!.removeListener("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") fail("unavailable", "Listener did not bind");
    return address.port;
  }
  private async respond(
    req: IncomingMessage,
    res: ServerResponse,
    signal: AbortSignal,
    handler: WireHandler,
  ) {
    let operation: ReturnType<WireHandler> | undefined;
    try {
      const path = req.url ?? "";
      if (!path.startsWith("/") || path.includes("?") || path.includes("#"))
        fail("invalid-data", "Invalid protocol path");
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers))
        if (typeof value === "string") headers[name] = value;
      operation = handler({
        path,
        method: req.method ?? "",
        headers,
        signal,
        body: Readable.toWeb(req) as ByteStream,
      });
      const result = await this.untilAborted(operation, signal);
      res.writeHead(result.status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...result.headers,
      });
      if (!result.body || result.body instanceof Uint8Array) {
        res.end(result.body);
        return;
      }
      const reader = result.body.getReader();
      const abort = () => {
        void reader.cancel().catch(() => {});
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        while (true) {
          signal.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          if (!res.write(chunk.value)) await once(res, "drain", { signal });
        }
        res.end();
      } finally {
        signal.removeEventListener("abort", abort);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } catch (error) {
      const status =
        error instanceof FederationError
          ? error.retryable
            ? 503
            : error.code === "unauthorized"
              ? 403
              : error.code === "conflict"
                ? 409
                : error.code === "not-found"
                  ? 404
                  : error.code === "limit-exceeded"
                    ? 413
                    : 400
          : 503;
      if (!res.headersSent)
        res.writeHead(status, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ type: status === 503 ? "SERVER" : "VALIDATION" }));
    } finally {
      // A deadline closes the peer response, but an adapter may ignore cancellation.
      // Keep that work admission-counted until it really settles so timed-out calls
      // cannot accumulate without the fixed request cap.
      if (signal.aborted && operation) await operation.catch(() => {});
    }
  }
  private untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        callback();
      };
      const abort = () =>
        finish(() =>
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new FederationError("unavailable", "Request deadline expired", true),
          ),
        );
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void operation.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
    });
  }
  async request(endpoint: string, input: WireRequest): Promise<WireResponse> {
    onion(endpoint);
    input.signal.throwIfAborted();
    const signal = AbortSignal.any([
      input.signal,
      AbortSignal.timeout(this.deadline(input.path, input.deadlineClass)),
    ]);
    if (!input.path.startsWith("/") || input.path.includes("\r") || input.path.includes("\n"))
      fail("invalid-data", "Invalid protocol path");
    const url = new URL(endpoint);
    const socket = await this.connector.connect(endpoint, signal);
    const agent = new Agent({ keepAlive: false });
    this.agents.add(agent);
    agent.createConnection = (() => socket) as typeof agent.createConnection;
    return new Promise<WireResponse>((resolve, reject) => {
      const headers = { ...input.headers };
      if (input.body instanceof Uint8Array)
        headers["content-length"] = String(input.body.byteLength);
      const req = request(
        {
          hostname: url.hostname,
          port: Number(url.port || 80),
          method: input.method ?? "POST",
          path: input.path,
          headers,
          agent,
          signal,
        },
        (response) => {
          const returned: Record<string, string> = {};
          for (const [key, value] of Object.entries(response.headers))
            if (typeof value === "string") returned[key] = value;
          response.once("close", () => {
            agent.destroy();
            this.agents.delete(agent);
          });
          resolve({
            status: response.statusCode ?? 503,
            headers: returned,
            body: Readable.toWeb(response) as ByteStream,
          });
        },
      );
      // SOCKS framing pauses the socket between reads. HTTP now owns its reader.
      req.once("socket", (connected) => connected.resume());
      req.once("error", (error) => {
        agent.destroy();
        this.agents.delete(agent);
        reject(error);
      });
      req.setTimeout(30_000, () =>
        req.destroy(new FederationError("unavailable", "Peer request timed out", true)),
      );
      void (async () => {
        if (!input.body || input.body instanceof Uint8Array) {
          req.end(input.body);
          return;
        }
        const reader = input.body.getReader();
        const abort = () => {
          void reader.cancel().catch(() => {});
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
          while (true) {
            signal.throwIfAborted();
            const chunk = await reader.read();
            if (chunk.done) break;
            if (!req.write(chunk.value)) await once(req, "drain", { signal });
          }
          req.end();
        } finally {
          signal.removeEventListener("abort", abort);
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      })().catch((error) =>
        req.destroy(error instanceof Error ? error : new Error("Request failed")),
      );
    });
  }
  async json(
    endpoint: string,
    path: string,
    body: unknown,
    signal: AbortSignal,
    maxResponseBytes = 32 * 1024,
  ): Promise<unknown> {
    const payload = Buffer.from(JSON.stringify(body));
    if (payload.length > lookupRequestMaxBytes(path))
      fail("limit-exceeded", "Protocol request too large");
    const result = await this.request(endpoint, {
      path,
      body: payload,
      signal,
      headers: { "content-type": "application/json" },
    });
    const bytes = await collect(result.body, maxResponseBytes, { signal });
    if (result.status < 200 || result.status >= 300)
      fail("unavailable", "Peer request failed", true);
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      fail("invalid-data", "Invalid peer JSON");
    }
  }
  async stop(): Promise<void> {
    for (const control of this.requests) control.abort();
    for (const agent of this.agents) agent.destroy();
    this.agents.clear();
    const server = this.server;
    this.server = undefined;
    if (server)
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    this.requests.clear();
  }
}

export async function localConnect(
  host: string,
  port: number,
  signal: AbortSignal,
): Promise<Socket> {
  signal.throwIfAborted();
  const socket = connect({ host, port });
  // There is a hand-off gap between the connect promise and HTTP owning the socket.
  // An abort in that gap must not produce an unhandled socket error.
  socket.on("error", () => {});
  const abort = () => socket.destroy();
  signal.addEventListener("abort", abort, { once: true });
  socket.once("close", () => signal.removeEventListener("abort", abort));
  try {
    await once(socket, "connect", { signal });
    signal.removeEventListener("abort", abort);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}
function readExactly(socket: Socket, count: number, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const clean = () => {
      socket.pause();
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("end", onEnd);
      signal.removeEventListener("abort", onAbort);
    };
    const onError = (error: Error) => {
      clean();
      reject(error);
    };
    const onEnd = () => onError(new Error("Proxy closed during handshake"));
    const onAbort = () => onError(new Error("Proxy handshake aborted"));
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      chunks.push(chunk);
      if (size < count) return;
      clean();
      const result = Buffer.concat(chunks);
      if (result.length > count) socket.unshift(result.subarray(count));
      resolve(result.subarray(0, count));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    else socket.resume();
  });
}
export function torConnector(config: TorConfiguration): Connector {
  for (const host of [config.socksProxy.host, config.listen.host])
    if (!["127.0.0.1", "::1", "localhost"].includes(host))
      fail("invalid-data", "Tor sockets must bind to loopback");
  integer(config.socksProxy.port, 1, 65535);
  integer(config.listen.port, 0, 65535);
  onion(config.onionService);
  return {
    async probe(signal) {
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
      const socket = await localConnect(config.socksProxy.host, config.socksProxy.port, bounded);
      try {
        socket.write(Buffer.from([5, 1, 0]));
        const reply = await readExactly(socket, 2, bounded);
        if (reply[0] !== 5 || reply[1] !== 0) fail("unavailable", "Tor proxy is unavailable", true);
      } finally {
        socket.destroy();
      }
    },
    async connect(endpoint, signal) {
      const url = new URL(onion(endpoint));
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
      const socket = await localConnect(config.socksProxy.host, config.socksProxy.port, bounded);
      try {
        socket.write(Buffer.from([5, 1, 0]));
        const method = await readExactly(socket, 2, bounded);
        if (method[0] !== 5 || method[1] !== 0)
          fail("unavailable", "Tor proxy refused authentication method", true);
        const host = Buffer.from(url.hostname, "ascii");
        const port = Number(url.port || 80);
        socket.write(
          Buffer.concat([
            Buffer.from([5, 1, 0, 3, host.length]),
            host,
            Buffer.from([port >> 8, port & 255]),
          ]),
        );
        const reply = await readExactly(socket, 4, bounded);
        if (reply[0] !== 5 || reply[1] !== 0 || reply[2] !== 0)
          fail("unavailable", "Tor proxy could not connect", true);
        const length =
          reply[3] === 1
            ? 4
            : reply[3] === 4
              ? 16
              : reply[3] === 3
                ? (await readExactly(socket, 1, bounded))[0]
                : -1;
        if (length < 0) fail("invalid-data", "Invalid Tor proxy response");
        await readExactly(socket, length + 2, bounded);
        return socket;
      } catch (error) {
        socket.destroy();
        throw error;
      }
    },
  };
}
