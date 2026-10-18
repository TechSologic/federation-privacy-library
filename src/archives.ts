import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type * as C from "./contracts.js";
import { fail, integer } from "./errors.js";
import { State } from "./state.js";
import { HttpWire, type WireHandler } from "./transport.js";
import { collect, rangeWithin, tracked } from "./streams.js";
import { base64, json, object } from "./protocol/lookup.js";
import {
  archivePath,
  archiveReference,
  boundedText,
  canonical,
  document,
  gatewayLocator,
  parsePointer,
  partBytes,
  readDocument,
  shaHex,
  verifyPointer,
  verifyRequestProof,
} from "./protocol/archives.js";

export interface ArchiveJob {
  archive: C.ArchiveReference;
  sourceId?: string;
  info?: C.ArchiveInfo;
  expectedRevision?: string | null;
  range?: C.ByteRange;
  expectedInfo?: C.ArchiveInfo;
  expectedRangeSha256?: string;
  context: Record<string, any>;
}
interface MultipartSession {
  archive: C.ArchiveReference;
  info: C.CiphertextInfo;
  md5: string;
  parts: { PartNumber: number; ETag: string; size: number }[];
  state: "staging" | "committing" | "committed" | "aborted";
  createdAt: number;
  expectedRevision: string | null;
}
interface SendSession {
  uploadId: string;
  endpoint: string;
  md5: string;
  parts: { PartNumber: number; ETag: string; size: number }[];
}
interface Host {
  config: C.FederationConfiguration;
  state: State;
  wire: HttpWire;
  limits: C.FederationLimits;
  signal(options?: C.CallOptions): AbortSignal;
  fence(): C.StorageFence;
  resolve(destination: C.Destination, signal: AbortSignal): Promise<string>;
  enqueue(
    kind: "archive-send" | "archive-read",
    destination: C.Destination,
    job: ArchiveJob,
    listener: C.TransferListener | undefined,
    options: C.SendOptions,
    total: number,
  ): Promise<C.Transfer>;
}
const payload = (value: unknown) => Buffer.from(JSON.stringify(value));
const type = (name: string) => `unolock.federation.archive.${name}.request.v1`;
const maxCursorLength = 4096;
const archiveContentMarkerLifetimeMs = 5 * 60_000;

export class Archives implements C.ArchiveApi {
  private readonly sources = new Map<string, C.ArchiveSource>();
  private readonly receivers = new Map<string, C.ArchiveReadReceiver>();
  private readonly providers = new Map<string, C.ProofProvider>();
  private readonly locks = new Set<string>();
  constructor(private readonly host: Host) {}
  private async proof(
    operation: C.AuthorizedOperation,
    wireOperation: string,
    archive: C.ArchiveReference,
    request: unknown,
    options: C.ArchiveRequestOptions,
    signal: AbortSignal,
    collection?: C.ArchiveCollection,
  ): Promise<any> {
    const provider = options.proofs ?? this.host.config.proofs;
    if (!provider) fail("unauthorized", "An archive proof provider is required");
    const canonicalRequest = canonical(request);
    const result = await provider.provide({
      operation,
      target: { archive, ...(collection ? { collection } : {}) },
      canonicalRequest,
      requestHash: shaHex(canonicalRequest),
      signal,
    });
    if (result.length !== 1) fail("invalid-data", "One existing archive request proof is required");
    const proof = readDocument(result[0]);
    if (
      proof.type !== "unolock.federation.archive-request.v1" ||
      proof.archiveID !== archive.id ||
      proof.operation !== wireOperation ||
      proof.requestHash !== shaHex(canonicalRequest)
    )
      fail("invalid-data", "Proof provider returned a different request");
    return proof;
  }
  private async authorize(
    operation: C.AuthorizedOperation,
    wireOperation: string,
    archive: C.ArchiveReference,
    request: unknown,
    proof: unknown,
    signal: AbortSignal,
    collection?: C.ArchiveCollection,
  ): Promise<{ authority: C.TrustedAuthority; collection?: C.ArchiveCollection }> {
    const handler = this.host.config.authorization;
    if (!handler) fail("unauthorized", "Archive access denied");
    const canonicalRequest = canonical(request);
    const lookup: C.AuthorizationRequest = {
      operation,
      target: { archive },
      canonicalRequest,
      requestHash: shaHex(canonicalRequest),
      submitted: [document(proof)],
      signal,
    };
    const authority = await handler.resolveAuthority(lookup);
    if (!authority) fail("unauthorized", "Archive access denied");
    verifyRequestProof(proof, authority, wireOperation, archive.id, request);
    let trustedCollection: C.ArchiveCollection | undefined;
    if (collection) {
      const trusted = authority.archiveCollection;
      if (
        !trusted ||
        trusted.id !== collection.id ||
        trusted.authorityArchiveId !== collection.authorityArchiveId
      )
        fail("unauthorized", "Archive collection scope mismatch");
      trustedCollection = { ...trusted, locator: collection.locator };
    }
    const input: C.AuthorizationRequest = {
      ...lookup,
      target: { archive, ...(trustedCollection ? { collection: trustedCollection } : {}) },
    };
    if ((await handler.authorize(input, authority)) !== "allow")
      fail("unauthorized", "Archive access denied");
    signal.throwIfAborted();
    return { authority, collection: trustedCollection };
  }
  private async rpc(
    endpoint: string,
    path: string,
    body: unknown,
    signal: AbortSignal,
    method: "POST" | "PUT" = "POST",
  ): Promise<any> {
    const encoded = payload(body);
    if (encoded.length > 1024 * 1024) fail("limit-exceeded", "Archive request is too large");
    const response = await this.host.wire.request(endpoint, {
      path: archivePath + path,
      method,
      body: encoded,
      signal,
      headers: { "content-type": "application/json" },
    });
    const result = json(await collect(response.body, 4 * 1024 * 1024, { signal })) as any;
    if (response.status === 403 || result?.result === "INVALID")
      fail("unauthorized", "Archive request was denied");
    if (response.status >= 500 || response.status === 429)
      fail("unavailable", "Archive peer is unavailable", true);
    if (response.status < 200 || response.status >= 300)
      fail("invalid-data", "Archive request failed");
    return result;
  }
  async create(
    destination: C.Destination,
    input: { collection: C.ArchiveCollection; description: C.ProtocolDocument },
    options: C.ArchiveRequestOptions = {},
  ): Promise<C.ArchiveDescription> {
    const signal = this.host.signal(options);
    const endpoint = await this.host.resolve(destination, signal);
    const archive = readDocument(input.description);
    boundedText(archive.id, 256);
    const context = readDocument(options.context);
    if (!context.createIntent)
      fail("invalid-data", "Existing protocol createIntent is required in context");
    const ref = { id: archive.id, locator: gatewayLocator(archive.id, endpoint) };
    const createRequest = context.createIntent;
    const createGrant = await this.proof(
      "archive-create",
      "create",
      ref,
      createRequest,
      options,
      signal,
      input.collection,
    );
    const result = await this.rpc(
      endpoint,
      "create",
      {
        type: type("create"),
        archiveListID: input.collection.id,
        authorityArchiveID: input.collection.authorityArchiveId,
        archive,
        createIntent: context.createIntent,
        createGrant,
      },
      signal,
    );
    if (
      result.type !== "unolock.federation.archive.create.response.v1" ||
      result.result !== "SUCCESS"
    )
      fail("invalid-data", "Invalid archive create response");
    return {
      archive: ref,
      revision: null,
      metadata: document({ ...archive, ps: result.providerState ?? archive.ps }),
    };
  }
  async list(
    destination: C.Destination,
    collection: C.ArchiveCollection,
    query: C.PageRequest,
    options: C.ArchiveRequestOptions = {},
  ): Promise<C.ArchiveList> {
    if (query.limit !== 64)
      fail("invalid-data", "The current archive wire protocol requires a page limit of 64");
    const signal = this.host.signal(options);
    const endpoint = await this.host.resolve(destination, signal);
    const ref = { id: collection.authorityArchiveId, locator: collection.locator };
    archiveReference(ref);
    const cursor =
      query.cursor === undefined ? undefined : boundedText(query.cursor, maxCursorLength);
    const listRequest = { authorityArchiveID: ref.id };
    const listGrant = await this.proof(
      "archive-list",
      "list",
      ref,
      listRequest,
      options,
      signal,
      collection,
    );
    const result = await this.rpc(
      endpoint,
      "list",
      {
        type: "unolock.federation.archive.list.request.v2",
        archiveListID: collection.id,
        authorityArchiveID: ref.id,
        listGrant,
        ...(cursor ? { cursor } : {}),
      },
      signal,
    );
    if (result.type !== "unolock.federation.archive.list.response.v2")
      fail("invalid-data", "Invalid archive listing response");
    if (result.result === "DELETED") {
      integer(result.deletedAt, 1);
      integer(result.expiresAt, result.deletedAt);
      return { outcome: "deleted", deletedAt: result.deletedAt, expiresAt: result.expiresAt };
    }
    if (
      result.result !== "SUCCESS" ||
      !Array.isArray(result.archives) ||
      result.archives.length > 64
    )
      fail("invalid-data", "Invalid archive listing");
    if (result.nextCursor !== undefined) boundedText(result.nextCursor, maxCursorLength);
    // The current wire fixes page size at up to 64; truncating it would lose records.
    return {
      outcome: "listed",
      page: {
        items: result.archives.map((a: any) => ({
          archive: {
            id: boundedText(a.id, 256),
            locator: a.ps?.nodeBlob?.gatewayLocator ?? gatewayLocator(a.id, endpoint),
          },
          revision: a.ps?.nodeBlob?.etag ?? null,
          metadata: document(a),
        })),
        cursor: result.nextCursor,
      },
    };
  }
  async remove(
    destination: C.Destination,
    archive: C.ArchiveReference,
    options: C.ArchiveRequestOptions = {},
  ): Promise<void> {
    archiveReference(archive);
    const signal = this.host.signal(options);
    const endpoint = await this.host.resolve(destination, signal);
    const context = readDocument(options.context);
    boundedText(context.authorityArchiveID, 256);
    boundedText(context.archiveListID, 256);
    const collection: C.ArchiveCollection = {
      id: context.archiveListID,
      authorityArchiveId: context.authorityArchiveID,
      locator: archive.locator,
    };
    const request = { authorityArchiveID: collection.authorityArchiveId, archiveID: archive.id };
    const deleteGrant = await this.proof(
      "archive-delete",
      "delete",
      archive,
      request,
      options,
      signal,
      collection,
    );
    const result = await this.rpc(
      endpoint,
      "delete",
      { type: type("delete"), ...request, archiveListID: collection.id, deleteGrant },
      signal,
    );
    if (
      result.type !== "unolock.federation.archive.delete.response.v1" ||
      result.result !== "SUCCESS"
    )
      fail("invalid-data", "Invalid archive delete response");
  }
  async head(
    destination: C.Destination,
    archive: C.ArchiveReference,
    options: C.ArchiveHeadOptions,
  ): Promise<C.ArchiveVersion | null> {
    if (!options?.freshness) fail("invalid-data", "Archive head freshness is required");
    if (options.freshness.minimumSequence > 0 && !options.freshness.hashAtMinimum)
      fail("invalid-data", "A trusted head hash is required for an observed sequence");
    return this.fetchHead(destination, archive, options, options.freshness);
  }
  private async fetchHead(
    destination: C.Destination,
    archive: C.ArchiveReference,
    options: C.ArchiveRequestOptions,
    freshness: { minimumSequence: number; hashAtMinimum?: string },
  ): Promise<C.ArchiveVersion | null> {
    archiveReference(archive);
    integer(freshness.minimumSequence, 0);
    if (freshness.hashAtMinimum && base64(freshness.hashAtMinimum, 32).length !== 32)
      fail("invalid-data", "Invalid trusted archive head hash");
    const signal = this.host.signal(options);
    const endpoint = await this.host.resolve(destination, signal);
    const access = await this.proof(
      "archive-head",
      "read",
      archive,
      { archiveID: archive.id },
      options,
      signal,
    );
    const result = await this.rpc(
      endpoint,
      "mutable/head",
      { type: type("mutable.head"), locator: archive.locator, archiveID: archive.id, access },
      signal,
    );
    if (result.result === "NOT_FOUND") {
      if (freshness.minimumSequence > 0)
        fail("invalid-data", "Archive head is older than trusted local state");
      return null;
    }
    if (result.result === "ARCHIVE_NOT_FOUND") fail("not-found", "Archive was not found");
    if (result.result !== "SUCCESS") fail("invalid-data", "Invalid version response");
    const p = parsePointer(result.pointer, archive.id);
    if (result.pointerHash !== p.pointerHash)
      fail("invalid-data", "Version response hash mismatch");
    const canonicalRequest = canonical({ archiveID: archive.id });
    const verificationRequest: C.AuthorizationRequest = {
      operation: "archive-head",
      target: { archive },
      canonicalRequest,
      requestHash: shaHex(canonicalRequest),
      submitted: [document(p)],
      signal,
    };
    const handler = this.host.config.authorization;
    const authority = options.authority ?? (await handler?.resolveAuthority(verificationRequest));
    if (!authority) fail("unauthorized", "Trusted archive head authority is required");
    const verified = verifyPointer(p, archive.id, undefined, authority);
    if (
      verified.sequence < freshness.minimumSequence ||
      (verified.sequence === freshness.minimumSequence &&
        freshness.hashAtMinimum !== undefined &&
        verified.hash !== freshness.hashAtMinimum)
    )
      fail("unauthorized", "Archive head is older than trusted local state");
    if (
      !options.authority &&
      (await handler!.authorize(verificationRequest, authority)) !== "allow"
    )
      fail("unauthorized", "Archive head was denied");
    return verified;
  }
  async commitVersion(
    destination: C.Destination,
    archive: C.ArchiveReference,
    input: { expectedPredecessor: string | null; signedSuccessor: C.ProtocolDocument },
    options: C.ArchiveRequestOptions = {},
  ): Promise<C.VersionCommit> {
    archiveReference(archive);
    const signal = this.host.signal(options);
    const endpoint = await this.host.resolve(destination, signal);
    const pointer = parsePointer(readDocument(input.signedSuccessor), archive.id);
    if (pointer.previousPointerHash !== (input.expectedPredecessor ?? ""))
      fail("invalid-data", "Version predecessor mismatch");
    const result = await this.rpc(
      endpoint,
      "mutable/commit",
      {
        type: type("mutable.commit"),
        locator: archive.locator,
        archiveID: archive.id,
        expectedPreviousPointerHash: input.expectedPredecessor ?? "",
        pointer,
      },
      signal,
      "PUT",
    );
    if (result.result === "CONFLICT")
      return {
        outcome: "conflict",
        current: await this.fetchHead(destination, archive, options, {
          minimumSequence: pointer.sequence,
        }),
      };
    if (result.result !== "SUCCESS" || result.pointerHash !== pointer.pointerHash)
      fail("invalid-data", "Invalid version commit response");
    return {
      outcome: "committed",
      version: {
        hash: pointer.pointerHash,
        predecessor: input.expectedPredecessor,
        sequence: pointer.sequence,
        issuedAt: pointer.issuedAt,
        signed: input.signedSuccessor,
      },
    };
  }
  async send(
    destination: C.Destination,
    source: C.ArchiveSource,
    listener?: C.TransferListener,
    options: C.SendOptions & C.ArchiveRequestOptions = {},
  ): Promise<C.Transfer> {
    this.host.signal(options);
    archiveReference(source.archive);
    boundedText(source.sourceId);
    const info = await source.describe();
    integer(info.byteLength, 1, this.host.limits.maxArchiveBytes);
    if (base64(info.sha256, 32).length !== 32) fail("invalid-data", "Invalid archive digest");
    const id = options.operationId ?? randomUUID();
    this.sources.set(id, source);
    if (options.proofs) this.providers.set(id, options.proofs);
    try {
      const transfer = await this.host.enqueue(
        "archive-send",
        destination,
        {
          sourceId: source.sourceId,
          info,
          archive: source.archive,
          expectedRevision: source.expectedRevision,
          context: readDocument(options.context),
        },
        listener,
        { ...options, operationId: id },
        info.byteLength,
      );
      if ((await transfer.status()).state === "paused") await transfer.resume();
      return transfer;
    } catch (error) {
      this.release(id);
      throw error;
    }
  }
  async read(
    destination: C.Destination,
    archive: C.ArchiveReference,
    receiver: C.ArchiveReadReceiver,
    listener: C.TransferListener | undefined,
    options: C.SendOptions & C.ArchiveRequestOptions & C.ArchiveReadOptions,
  ): Promise<C.Transfer> {
    this.host.signal(options);
    archiveReference(archive);
    integer(options.expectedInfo.byteLength, 1, this.host.limits.maxArchiveBytes);
    if (base64(options.expectedInfo.sha256, 32).length !== 32)
      fail("invalid-data", "Invalid expected archive digest");
    if (options.range) rangeWithin(options.range, options.expectedInfo.byteLength);
    if (options.range && base64(options.expectedRangeSha256, 32).length !== 32)
      fail("invalid-data", "Invalid expected archive range digest");
    const id = options.operationId ?? randomUUID();
    this.receivers.set(id, receiver);
    if (options.proofs) this.providers.set(id, options.proofs);
    try {
      const transfer = await this.host.enqueue(
        "archive-read",
        destination,
        {
          archive,
          range: options.range,
          expectedInfo: options.expectedInfo,
          expectedRangeSha256: options.range ? options.expectedRangeSha256 : undefined,
          context: readDocument(options.context),
        },
        listener,
        { ...options, operationId: id },
        options.range?.length ?? options.expectedInfo.byteLength,
      );
      if ((await transfer.status()).state === "paused") await transfer.resume();
      return transfer;
    } catch (error) {
      this.release(id);
      throw error;
    }
  }
  release(id: string) {
    this.sources.delete(id);
    this.receivers.delete(id);
    this.providers.delete(id);
  }
  async execute(
    id: string,
    kind: "archive-send" | "archive-read",
    destination: C.AddressIdentity,
    job: ArchiveJob,
    signal: AbortSignal,
    progress: (bytes: number, total: number) => void,
  ): Promise<C.TransferResult> {
    const endpoint = await this.host.resolve(destination, signal);
    const options: C.ArchiveRequestOptions = {
      proofs: this.providers.get(id),
      context: document(job.context),
    };
    if (kind === "archive-read") {
      const receiver = this.receivers.get(id);
      if (!receiver)
        fail(
          "receiver-unavailable",
          "Reattach the read receiver using the same operation identifier",
          true,
        );
      const access = await this.proof(
        "archive-read",
        "read",
        job.archive,
        { archiveID: job.archive.id },
        options,
        signal,
      );
      const response = await this.host.wire.request(endpoint, {
        path: archivePath + "object/read",
        deadlineClass: "archive",
        body: payload({
          type: type("read"),
          locator: job.archive.locator,
          archiveID: job.archive.id,
          access,
        }),
        signal,
        headers: {
          "content-type": "application/json",
          ...(job.range
            ? { range: `bytes=${job.range.offset}-${job.range.offset + job.range.length - 1}` }
            : {}),
        },
      });
      if (response.status !== (job.range ? 206 : 200)) {
        await response.body.cancel();
        fail("unavailable", "Archive read did not return the requested range", true);
      }
      const length = Number(response.headers["content-length"]);
      integer(length, 1, this.host.limits.maxArchiveBytes);
      let size = length;
      if (job.range) {
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers["content-range"] ?? "");
        if (
          !match ||
          Number(match[1]) !== job.range.offset ||
          Number(match[2]) + 1 !== job.range.offset + job.range.length ||
          length !== job.range.length
        ) {
          await response.body.cancel();
          fail("invalid-data", "Archive range response mismatch");
        }
        size = Number(match[3]);
        integer(size, length, this.host.limits.maxArchiveBytes);
        rangeWithin(job.range, size);
      }
      const expected = job.expectedInfo;
      if (!expected) fail("invalid-data", "Trusted archive metadata is required");
      if (expected.byteLength !== size) {
        await response.body.cancel();
        fail("invalid-data", "Archive size differs from expected metadata");
      }
      const streamSha256 = job.range ? job.expectedRangeSha256 : expected.sha256;
      if (!streamSha256) {
        await response.body.cancel();
        fail("invalid-data", "Trusted archive range digest is required");
      }
      const monitored = tracked(
        response.body,
        { byteLength: length, sha256: streamSha256 },
        signal,
        (n) => progress(n, length),
      );
      try {
        await receiver.receive(monitored.stream, {
          operationId: id,
          archive: job.archive,
          info: expected,
          range: job.range ?? { offset: 0, length },
          streamSha256,
          signal,
        });
        monitored.assertComplete();
      } finally {
        if (!monitored.stream.locked) await monitored.stream.cancel().catch(() => {});
      }
      return { kind, outcome: "received", archive: job.archive, range: job.range };
    }
    const source =
      this.sources.get(id) ?? (await this.host.config.sources?.resolve(job.sourceId!, { signal }));
    if (!source)
      fail(
        "source-unavailable",
        "The archive source must be reopened before this transfer can resume",
        true,
      );
    const info = await source.describe();
    if (info.byteLength !== job.info!.byteLength || info.sha256 !== job.info!.sha256)
      fail("invalid-data", "Reopened archive source changed");
    const sums = await digest(await source.open({ signal }), info.byteLength, signal);
    if (sums.sha256 !== info.sha256) fail("invalid-data", "Archive source digest mismatch");
    // Multipart is for immutable first writes. Mutable successors use staged object writes.
    if (
      info.byteLength > partBytes &&
      job.expectedRevision === null &&
      job.context.previousPointerHash === undefined
    )
      return this.sendMultipart(id, endpoint, source, job, sums.md5, options, signal, progress);
    const contentSha256 = Buffer.from(info.sha256, "base64url").toString("hex");
    const currentEtag = job.expectedRevision ?? "";
    const request = {
      archiveID: job.archive.id,
      contentSha256,
      contentLength: info.byteLength,
      currentEtag,
      ...(job.context.previousPointerHash !== undefined
        ? { previousPointerHash: job.context.previousPointerHash }
        : {}),
    };
    const writeGrant = await this.proof(
      "archive-write",
      "write",
      job.archive,
      request,
      options,
      signal,
    );
    const header = {
      type: type("put"),
      locator: job.archive.locator,
      ...request,
      md5: sums.md5,
      writeGrant,
      ...(job.context.newEtag !== undefined ? { newEtag: job.context.newEtag } : {}),
    };
    const monitored = tracked(await source.open({ signal }), info, signal, (n) =>
      progress(n, info.byteLength),
    );
    const response = await this.host.wire.request(endpoint, {
      path: archivePath + "object",
      deadlineClass: "archive",
      method: "PUT",
      body: monitored.stream,
      signal,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(info.byteLength),
        "content-md5": sums.md5,
        "if-match": currentEtag,
        "x-unolock-archive-request": encodeHeader(header),
      },
    });
    const receipt = json(await collect(response.body, 64 * 1024, { signal })) as any;
    if (response.status === 409 || response.status === 412)
      fail("conflict", "Archive revision changed");
    if (response.status === 403 || response.status === 404)
      fail("unauthorized", "Archive write was denied");
    if (response.status < 200 || response.status >= 300)
      fail("unavailable", "Archive write failed", true);
    monitored.assertComplete();
    if (
      receipt?.type !== "unolock.federation.archive.put.response.v1" ||
      receipt.result !== "SUCCESS" ||
      receipt.etag !== response.headers.etag ||
      !["STAGED", "COMMITTED"].includes(receipt.state)
    )
      fail("invalid-data", "Invalid archive receipt");
    if (
      receipt.state === "STAGED" &&
      (receipt.provider !== "node-blob" ||
        receipt.size !== info.byteLength ||
        receipt.contentId !== `uobj:v1:sha256:${info.sha256}` ||
        receipt.locator !== `nodeblob:sha256:${info.sha256}` ||
        receipt.etag !== job.context.newEtag)
    )
      fail("invalid-data", "Invalid staged archive receipt");
    return {
      kind,
      outcome: receipt.state === "STAGED" ? "staged" : "committed",
      archive: job.archive,
      info,
      receipt: document(receipt),
    };
  }
  private async sendMultipart(
    id: string,
    endpoint: string,
    source: C.DataSource<C.ArchiveInfo>,
    job: ArchiveJob,
    md5: string,
    options: C.ArchiveRequestOptions,
    signal: AbortSignal,
    progress: (bytes: number, total: number) => void,
  ): Promise<C.TransferResult> {
    const state = this.host.state;
    const info = job.info!;
    let saved = await state.get<SendSession>("archive-outgoing", id);
    if (!saved) {
      const request = { archiveID: job.archive.id, md5, contentLength: info.byteLength };
      const writeGrant = await this.proof(
        "multipart-init",
        "multipart-init",
        job.archive,
        request,
        options,
        signal,
      );
      // Save the exact init proof before networking: the reference peer derives its id from it.
      let init = await state.get<any>("archive-init", id);
      if (!init) {
        await state.put("archive-init", id, null, {
          type: type("multipart.init"),
          locator: job.archive.locator,
          ...request,
          writeGrant,
        });
        init = await state.get("archive-init", id);
      }
      const result = await this.rpc(endpoint, "multipart/init", init!.value, signal);
      if (result.result !== "SUCCESS") fail("invalid-data", "Invalid upload initiation response");
      boundedText(result.uploadId);
      const value: SendSession = { uploadId: result.uploadId, endpoint, md5, parts: [] };
      const revision = await state.put("archive-outgoing", id, null, value);
      if (!revision) fail("conflict", "Upload session changed");
      saved = { revision, value };
    }
    if (saved.value.endpoint !== endpoint)
      fail("unavailable", "The active upload belongs to a different endpoint", true);
    let offset = saved.value.parts.reduce((n, p) => n + p.size, 0);
    progress(offset, info.byteLength);
    for (let number = saved.value.parts.length + 1; offset < info.byteLength; number++) {
      signal.throwIfAborted();
      const length = Math.min(partBytes, info.byteLength - offset);
      const range = { offset, length };
      const sums = await digest(await source.open({ signal, range }), length, signal);
      const request = {
        archiveID: job.archive.id,
        uploadId: saved.value.uploadId,
        partNumber: number,
        md5: sums.md5,
        contentLength: length,
      };
      const writeGrant = await this.proof(
        "multipart-part",
        "multipart-part",
        job.archive,
        request,
        options,
        signal,
      );
      const monitored = tracked(
        await source.open({ signal, range }),
        { byteLength: length, sha256: sums.sha256 },
        signal,
        (n) => progress(offset + n, info.byteLength),
      );
      const response = await this.host.wire.request(endpoint, {
        path: archivePath + "multipart/part",
        deadlineClass: "archive",
        method: "PUT",
        body: monitored.stream,
        signal,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(length),
          "content-md5": sums.md5,
          "x-unolock-archive-request": encodeHeader({
            type: type("multipart.part"),
            locator: job.archive.locator,
            ...request,
            writeGrant,
          }),
        },
      });
      await collect(response.body, 8192, { signal });
      if (response.status < 200 || response.status >= 300 || !response.headers.etag)
        fail("unavailable", "Archive part was not acknowledged", true);
      monitored.assertComplete();
      boundedText(response.headers.etag);
      const value: SendSession = {
        ...saved.value,
        parts: [
          ...saved.value.parts,
          { PartNumber: number, ETag: response.headers.etag, size: length },
        ],
      };
      const revision = await state.put("archive-outgoing", id, saved.revision, value);
      if (!revision) fail("conflict", "Upload progress changed");
      saved = { revision, value };
      offset += length;
    }
    const request = {
      archiveID: job.archive.id,
      uploadId: saved.value.uploadId,
      parts: saved.value.parts,
      relayManifest: {
        contentSha256: Buffer.from(info.sha256, "base64url").toString("hex"),
        contentLength: info.byteLength,
      },
    };
    const writeGrant = await this.proof(
      "multipart-complete",
      "multipart-complete",
      job.archive,
      request,
      options,
      signal,
    );
    const receipt = await this.rpc(
      endpoint,
      "multipart/complete",
      { type: type("multipart.complete"), locator: job.archive.locator, ...request, writeGrant },
      signal,
    );
    if (receipt.result === "ETAG_MISMATCH")
      fail("conflict", "Archive changed before upload completion");
    if (receipt.result !== "SUCCESS") fail("invalid-data", "Invalid multipart completion response");
    return {
      kind: "archive-send",
      outcome: "committed",
      archive: job.archive,
      info,
      receipt: document(receipt),
    };
  }
  async cancel(id: string, job: ArchiveJob, signal: AbortSignal): Promise<void> {
    const session = await this.host.state.get<SendSession>("archive-outgoing", id);
    if (!session) return;
    const request = { archiveID: job.archive.id, uploadId: session.value.uploadId };
    const writeGrant = await this.proof(
      "multipart-abort",
      "multipart-abort",
      job.archive,
      request,
      { proofs: this.providers.get(id) },
      signal,
    );
    const result = await this.rpc(
      session.value.endpoint,
      "multipart/abort",
      { type: type("multipart.abort"), locator: job.archive.locator, ...request, writeGrant },
      signal,
    );
    if (result.result !== "SUCCESS") fail("unavailable", "Remote upload cleanup is pending", true);
  }
  async handle(request: Parameters<WireHandler>[0]): ReturnType<WireHandler> {
    const adapters = this.host.config.archives;
    if (!adapters) return { status: 404 };
    const path = request.path.slice(archivePath.length);
    const binary = path === "object" || path === "multipart/part";
    if (request.method !== (binary || path === "mutable/commit" ? "PUT" : "POST"))
      return { status: 405 };
    const raw = binary
      ? json(base64(request.headers["x-unolock-archive-request"], 12 * 1024))
      : json(await collect(request.body, 1024 * 1024, { signal: request.signal }));
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      fail("invalid-data", "Invalid archive request");
    const r = raw as Record<string, any>;
    const signal = request.signal;
    const expectedType =
      path === "object"
        ? type("put")
        : path === "object/read"
          ? type("read")
          : path === "list"
            ? "unolock.federation.archive.list.request.v2"
            : type(path.replaceAll("/", "."));
    if (r.type !== expectedType) fail("invalid-data", "Invalid archive request type");
    const archive = archiveReference({
      id: boundedText(
        path === "create" ? r.archive?.id : path === "list" ? r.authorityArchiveID : r.archiveID,
        256,
      ),
      // A peer locator is an unsigned routing hint. Incoming archive identity
      // always uses this host's deterministic local locator.
      locator: gatewayLocator(
        path === "create" ? r.archive.id : path === "list" ? r.authorityArchiveID : r.archiveID,
        this.host.config.tor.onionService,
      ),
    });
    const store = adapters.store;
    const ok = (result: unknown, headers?: Record<string, string>) => ({
      status: 200,
      body: payload(result),
      headers,
    });
    if (path === "object/read" || path === "mutable/head") {
      await this.authorize(
        path === "object/read" ? "archive-read" : "archive-head",
        "read",
        archive,
        { archiveID: archive.id },
        r.access,
        signal,
      );
      if (path === "mutable/head") {
        const head = await store.head(archive, { signal });
        if (!head) return ok({ result: "NOT_FOUND" });
        const stat = await store.stat(archive, { signal });
        return ok({
          result: "SUCCESS",
          provider: "node-blob",
          stableId: archive.id,
          pointerHash: head.hash,
          pointer: readDocument(head.signed),
          etag: stat?.revision,
          size: stat?.info?.byteLength,
        });
      }
      const stat = await store.stat(archive, { signal });
      if (!stat?.info) return { status: 404 };
      integer(stat.info.byteLength, 1, this.host.limits.maxArchiveBytes);
      let range: C.ByteRange | undefined;
      if (request.headers.range) {
        const m = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range);
        if (!m) fail("invalid-data", "Unsupported byte range");
        range = rangeWithin(
          { offset: Number(m[1]), length: Number(m[2]) - Number(m[1]) + 1 },
          stat.info.byteLength,
        );
      }
      const interval = range ?? { offset: 0, length: stat.info.byteLength };
      const monitored = tracked(
        await store.open(archive, { signal, range }),
        { byteLength: interval.length, sha256: range ? undefined : stat.info.sha256 },
        signal,
        () => {},
      );
      return {
        status: range ? 206 : 200,
        body: monitored.stream,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(interval.length),
          "accept-ranges": "bytes",
          ...(stat.revision ? { etag: stat.revision } : {}),
          ...(range
            ? {
                "content-range": `bytes ${range.offset}-${range.offset + range.length - 1}/${stat.info.byteLength}`,
              }
            : {}),
        },
      };
    }
    if (path === "create" || path === "list" || path === "delete") {
      const collection: C.ArchiveCollection = {
        id: boundedText(r.archiveListID, 256),
        authorityArchiveId: boundedText(r.authorityArchiveID, 256),
        locator: gatewayLocator(r.authorityArchiveID, this.host.config.tor.onionService),
      };
      const body =
        path === "create"
          ? r.createIntent
          : path === "list"
            ? { authorityArchiveID: r.authorityArchiveID }
            : { authorityArchiveID: r.authorityArchiveID, archiveID: archive.id };
      if (
        path === "create" &&
        (r.createIntent?.authorityArchiveID !== collection.authorityArchiveId ||
          !isDeepStrictEqual(r.createIntent?.archive, r.archive))
      )
        fail("unauthorized", "Archive descriptor differs from the signed create intent");
      const authorized = await this.authorize(
        `archive-${path}` as C.AuthorizedOperation,
        path,
        archive,
        body,
        r[`${path}Grant`],
        signal,
        collection,
      );
      const trustedCollection = authorized.collection!;
      if (path === "create") {
        const result = await store.create(
          shaHex(canonical(body)),
          trustedCollection,
          document(r.archive),
          this.host.fence(),
          { signal },
        );
        return ok({
          type: "unolock.federation.archive.create.response.v1",
          result: "SUCCESS",
          providerState: readDocument(result.metadata).ps,
        });
      }
      if (path === "delete") {
        await store.remove(shaHex(canonical(body)), archive, this.host.fence(), { signal });
        return ok({ type: "unolock.federation.archive.delete.response.v1", result: "SUCCESS" });
      }
      const cursor = r.cursor === undefined ? undefined : boundedText(r.cursor, maxCursorLength);
      const result = await store.list(trustedCollection, { limit: 64, cursor }, { signal });
      const nextCursor =
        result.outcome === "listed" && result.page.cursor !== undefined
          ? boundedText(result.page.cursor, maxCursorLength)
          : undefined;
      return ok({
        type: "unolock.federation.archive.list.response.v2",
        ...(result.outcome === "deleted"
          ? { result: "DELETED", deletedAt: result.deletedAt, expiresAt: result.expiresAt }
          : {
              result: "SUCCESS",
              archives: result.page.items.map((item) => readDocument(item.metadata)),
              nextCursor,
            }),
      });
    }
    if (path === "mutable/commit") {
      const handler = this.host.config.authorization;
      if (!handler) fail("unauthorized", "Archive access denied");
      const canonicalRequest = canonical({
        archiveID: archive.id,
        expectedPreviousPointerHash: r.expectedPreviousPointerHash,
        pointer: r.pointer,
      });
      const input: C.AuthorizationRequest = {
        operation: "archive-commit",
        target: { archive },
        canonicalRequest,
        requestHash: shaHex(canonicalRequest),
        submitted: [document(r.pointer)],
        signal,
      };
      const authority = await handler.resolveAuthority(input);
      if (!authority) fail("unauthorized", "Archive access denied");
      const version = verifyPointer(
        r.pointer,
        archive.id,
        r.expectedPreviousPointerHash || null,
        authority,
      );
      if ((await handler.authorize(input, authority)) !== "allow")
        fail("unauthorized", "Archive access denied");
      signal.throwIfAborted();
      const current = await store.head(archive, { signal });
      const pointer = parsePointer(r.pointer, archive.id);
      const contentKey = `${archive.id}:${pointer.contentHash}`;
      if (current?.hash === version.hash) {
        await this.deleteArchiveContentMarker(contentKey);
        return ok({ result: "SUCCESS", pointerHash: version.hash });
      }
      const content = await this.host.state.get<C.ArchiveInfo>("archive-content", contentKey);
      const previous = current ? parsePointer(readDocument(current.signed), archive.id) : null;
      const reusesCurrentContent =
        previous !== null &&
        previous.contentHash === pointer.contentHash &&
        previous.contentCid === pointer.contentCid;
      if (
        !reusesCurrentContent &&
        (!content || `uobj:v1:sha256:${content.value.sha256}` !== pointer.contentCid)
      )
        fail("conflict", "Version content has not been verified and stored");
      if (
        pointer.sequence !== (previous?.sequence ?? 0) + 1 ||
        pointer.previousContentHash !== (previous?.contentHash ?? "")
      )
        fail("conflict", "Version sequence or content predecessor mismatch");
      const result = await store.commitVersion(
        input.requestHash,
        archive,
        version.predecessor,
        version,
        this.host.fence(),
        { signal },
      );
      if (result.outcome === "committed") await this.deleteArchiveContentMarker(contentKey);
      return ok(
        result.outcome === "committed"
          ? { result: "SUCCESS", pointerHash: result.version.hash }
          : { result: "CONFLICT" },
      );
    }
    if (path === "object") return this.receiveObject(r, archive, request);
    if (path.startsWith("multipart/"))
      return this.receiveMultipart(path.slice(10), r, archive, request);
    return { status: 404 };
  }
  private async receiveObject(
    r: Record<string, any>,
    archive: C.ArchiveReference,
    request: Parameters<WireHandler>[0],
  ): ReturnType<WireHandler> {
    const signal = request.signal;
    integer(r.contentLength, 1, this.host.limits.maxArchiveBytes);
    md5Value(r.md5);
    if (
      !/^[a-f0-9]{64}$/.test(r.contentSha256) ||
      r.md5 !== request.headers["content-md5"] ||
      (r.currentEtag ?? "") !== (request.headers["if-match"] ?? "")
    )
      fail("invalid-data", "Archive headers do not match the request");
    const expected = {
      archiveID: archive.id,
      contentSha256: r.contentSha256,
      contentLength: r.contentLength,
      ...(r.currentEtag !== undefined ? { currentEtag: r.currentEtag } : {}),
      ...(r.previousPointerHash !== undefined
        ? { previousPointerHash: r.previousPointerHash }
        : {}),
    };
    const { authority } = await this.authorize(
      "archive-write",
      "write",
      archive,
      expected,
      r.writeGrant,
      signal,
    );
    const info = {
      byteLength: r.contentLength,
      sha256: Buffer.from(r.contentSha256, "hex").toString("base64url"),
    };
    const stageId = shaHex(canonical({ archive, expected }));
    const adapters = this.host.config.archives!;
    return this.lock(stageId, async () => {
      let stage = await adapters.store.inspectStage(stageId, { signal });
      if (stage.state === "committing")
        fail("unavailable", "Archive commit outcome is pending", true);
      if (stage.state !== "committed") {
        const metadata: C.ArchiveReceiveMetadata = {
          operationId: stageId,
          stageId,
          archive,
          info,
          expectedRevision: r.currentEtag || null,
          range: { offset: 0, length: info.byteLength },
          fence: this.host.fence(),
          signal,
        };
        const monitored = tracked(request.body, info, signal, () => {});
        try {
          await adapters.receiver.receive(monitored.stream, metadata);
          monitored.assertComplete();
        } finally {
          if (!monitored.stream.locked) await monitored.stream.cancel().catch(() => {});
        }
        const sums = await digest(
          await adapters.store.openStage(stageId, { signal }),
          info.byteLength,
          signal,
        );
        if (sums.sha256 !== info.sha256 || sums.md5 !== r.md5) {
          await adapters.store.discardStage(stageId, this.host.fence(), { signal });
          fail("invalid-data", "Staged archive integrity mismatch");
        }
        signal.throwIfAborted();
        const result = await adapters.store.commitStage(
          stageId,
          archive,
          info,
          r.currentEtag || null,
          this.host.fence(),
          { signal },
        );
        if (result.outcome === "conflict")
          return { status: 409, body: payload({ result: "CONFLICT" }) };
        stage = await adapters.store.inspectStage(stageId, { signal });
        if (stage.state !== "committed")
          fail("storage", "Archive store did not confirm commit", true);
      } else {
        const sums = await digest(request.body, info.byteLength, signal);
        if (sums.sha256 !== info.sha256 || sums.md5 !== r.md5)
          fail("invalid-data", "Repeated archive write changed");
      }
      const mutable = readDocument(authority.bindings).mutable === true;
      if (mutable) {
        const contentKey = `${archive.id}:sha256:${r.contentSha256}`;
        const content = await this.host.state.get("archive-content", contentKey);
        if (
          !content &&
          !(await this.host.state.put(
            "archive-content",
            contentKey,
            null,
            info,
            Date.now() + archiveContentMarkerLifetimeMs,
          ))
        )
          fail("storage", "Verified archive content could not be recorded", true);
      }
      const etag = mutable ? boundedText(r.newEtag) : stage.revision;
      return {
        status: 200,
        headers: { etag },
        body: payload({
          type: "unolock.federation.archive.put.response.v1",
          result: "SUCCESS",
          state: mutable ? "STAGED" : "COMMITTED",
          etag,
          ...(mutable
            ? {
                provider: "node-blob",
                contentId: `uobj:v1:sha256:${info.sha256}`,
                locator: `nodeblob:sha256:${info.sha256}`,
                size: info.byteLength,
              }
            : {}),
        }),
      };
    });
  }
  private async receiveMultipart(
    operation: string,
    r: Record<string, any>,
    archive: C.ArchiveReference,
    request: Parameters<WireHandler>[0],
  ): ReturnType<WireHandler> {
    const state = this.host.state;
    const adapters = this.host.config.archives!;
    const signal = request.signal;
    const proofRequest =
      operation === "init"
        ? { archiveID: archive.id, md5: r.md5, contentLength: r.contentLength }
        : operation === "part"
          ? {
              archiveID: archive.id,
              uploadId: r.uploadId,
              partNumber: r.partNumber,
              md5: request.headers["content-md5"],
              contentLength: r.contentLength,
            }
          : operation === "complete"
            ? {
                archiveID: archive.id,
                uploadId: r.uploadId,
                parts: r.parts,
                ...(r.metadata !== undefined ? { metadata: r.metadata } : {}),
                ...(r.relayManifest !== undefined ? { relayManifest: r.relayManifest } : {}),
              }
            : { archiveID: archive.id, uploadId: r.uploadId };
    if (!["init", "part", "complete", "abort"].includes(operation)) return { status: 404 };
    await this.authorize(
      `multipart-${operation}` as C.AuthorizedOperation,
      `multipart-${operation}`,
      archive,
      proofRequest,
      r.writeGrant,
      signal,
    );
    if (operation === "init") {
      integer(r.contentLength, 1, this.host.limits.maxArchiveBytes);
      md5Value(r.md5);
      const id = shaHex(canonical({ request: proofRequest, proof: r.writeGrant }));
      const current = await state.get<MultipartSession>("archive-incoming", id);
      if (!current) {
        const stat = await adapters.store.stat(archive, { signal });
        if (stat?.revision) fail("conflict", "Multipart uploads require an uncommitted archive");
        let count = 0;
        for await (const _ of state.scan("archive-incoming"))
          if (++count >= this.host.limits.maxPendingOperations)
            fail("limit-exceeded", "Upload session capacity reached", true);
        if (
          !(await state.put(
            "archive-incoming",
            id,
            null,
            {
              archive,
              info: { byteLength: r.contentLength },
              md5: r.md5,
              parts: [],
              state: "staging",
              createdAt: Date.now(),
              expectedRevision: null,
            } satisfies MultipartSession,
            Date.now() + 24 * 60 * 60_000,
          ))
        )
          fail("unavailable", "Upload initiation is busy", true);
      }
      return { status: 200, body: payload({ result: "SUCCESS", uploadId: id }) };
    }
    boundedText(r.uploadId);
    return this.lock(r.uploadId, async () => {
      const stored = await state.get<MultipartSession>("archive-incoming", r.uploadId);
      if (!stored || stored.value.archive.id !== archive.id)
        fail("unauthorized", "Upload session is unavailable");
      const session = stored.value;
      if (operation === "abort") {
        const result = await adapters.store.discardStage(r.uploadId, this.host.fence(), { signal });
        if (result === "pending") fail("unavailable", "Archive commit outcome is pending", true);
        if (result === "discarded")
          await state.put(
            "archive-incoming",
            r.uploadId,
            stored.revision,
            { ...session, state: "aborted" },
            Date.now() + this.host.limits.operationRetentionMs,
          );
        return { status: 200, body: payload({ result: "SUCCESS" }) };
      }
      if (session.state === "aborted") fail("conflict", "Upload session is aborted");
      if (operation === "part") {
        integer(r.partNumber, 1, 1024);
        integer(r.contentLength, 1, 64 * 1024 ** 2);
        const md5 = md5Value(request.headers["content-md5"]);
        const etag = `"${Buffer.from(md5, "base64").toString("hex")}"`;
        const existing = session.parts[r.partNumber - 1];
        if (existing && (existing.ETag !== etag || existing.size !== r.contentLength))
          fail("conflict", "Upload part changed on retry");
        const offset = session.parts.slice(0, r.partNumber - 1).reduce((n, p) => n + p.size, 0);
        if (
          session.state !== "staging" ||
          r.partNumber > session.parts.length + 1 ||
          offset + r.contentLength > session.info.byteLength
        )
          fail("conflict", "Upload part does not match session progress");
        const monitored = tracked(request.body, { byteLength: r.contentLength }, signal, () => {});
        const md5Stream = hashThrough(monitored.stream, "md5", signal);
        try {
          await adapters.receiver.receive(md5Stream.stream, {
            operationId: r.uploadId,
            stageId: r.uploadId,
            archive,
            info: session.info,
            expectedRevision: null,
            range: { offset, length: r.contentLength },
            fence: this.host.fence(),
            signal,
          });
          monitored.assertComplete();
        } finally {
          if (!md5Stream.stream.locked) await md5Stream.stream.cancel().catch(() => {});
        }
        if (md5Stream.result() !== md5) fail("invalid-data", "Archive part digest mismatch");
        if (!existing) {
          const parts = [
            ...session.parts,
            { PartNumber: r.partNumber, ETag: etag, size: r.contentLength },
          ];
          if (
            !(await state.put(
              "archive-incoming",
              r.uploadId,
              stored.revision,
              { ...session, parts },
              Date.now() + 24 * 60 * 60_000,
            ))
          )
            fail("conflict", "Upload progress changed");
        }
        return { status: 200, headers: { etag }, body: payload({ result: "SUCCESS" }) };
      }
      if (
        !Array.isArray(r.parts) ||
        r.parts.length > 1024 ||
        JSON.stringify(r.parts) !== JSON.stringify(session.parts)
      )
        fail("invalid-data", "Upload completion parts mismatch");
      if (
        !r.relayManifest ||
        r.relayManifest.contentLength !== session.info.byteLength ||
        !/^[a-f0-9]{64}$/.test(r.relayManifest.contentSha256)
      )
        fail("invalid-data", "Upload completion requires the encrypted manifest");
      const info: C.ArchiveInfo = {
        byteLength: session.info.byteLength,
        sha256: Buffer.from(r.relayManifest.contentSha256, "hex").toString("base64url"),
      };
      const stage = await adapters.store.inspectStage(r.uploadId, { signal });
      if (stage.state === "committing")
        fail("unavailable", "Archive commit outcome is pending", true);
      if (stage.state !== "committed") {
        const sums = await digest(
          await adapters.store.openStage(r.uploadId, { signal }),
          info.byteLength,
          signal,
        );
        if (sums.sha256 !== info.sha256 || sums.md5 !== session.md5)
          fail("invalid-data", "Upload completion integrity mismatch");
        signal.throwIfAborted();
        const result = await adapters.store.commitStage(
          r.uploadId,
          archive,
          info,
          null,
          this.host.fence(),
          { signal },
        );
        if (result.outcome === "conflict")
          return { status: 200, body: payload({ result: "ETAG_MISMATCH" }) };
      } else if (stage.info.sha256 !== info.sha256 || stage.info.byteLength !== info.byteLength)
        fail("conflict", "Upload completion manifest changed");
      await state.put(
        "archive-incoming",
        r.uploadId,
        stored.revision,
        { ...session, state: "committed" },
        Date.now() + this.host.limits.operationRetentionMs,
      );
      return { status: 200, body: payload({ result: "SUCCESS" }) };
    });
  }
  private async lock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (this.locks.has(key)) fail("unavailable", "Archive operation is busy", true);
    this.locks.add(key);
    try {
      return await operation();
    } finally {
      this.locks.delete(key);
    }
  }
  private async deleteArchiveContentMarker(key: string): Promise<void> {
    const marker = await this.host.state.get("archive-content", key);
    if (marker) await this.host.state.put("archive-content", key, marker.revision, null);
  }
  async maintain(signal: AbortSignal) {
    let count = 0;
    for await (const stored of this.host.state.scan<MultipartSession>(
      "archive-incoming",
      Date.now(),
    )) {
      if (++count > 16 || signal.aborted) return;
      if (this.locks.has(stored.key)) continue;
      await this.lock(stored.key, async () => {
        const discarded = await this.host.config.archives?.store.discardStage(
          stored.key,
          this.host.fence(),
          { signal },
        );
        if (discarded === "pending") return;
        await this.host.state.put("archive-incoming", stored.key, stored.revision, null);
      });
    }
    count = 0;
    for await (const stored of this.host.state.scan("archive-content", Date.now())) {
      if (++count > 16 || signal.aborted) return;
      await this.host.state.put("archive-content", stored.key, stored.revision, null);
    }
  }
}

function encodeHeader(value: unknown): string {
  const encoded = payload(value);
  if (encoded.length > 12 * 1024) fail("limit-exceeded", "Archive request header too large");
  return encoded.toString("base64url");
}
function md5Value(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9+/]{22}==$/.test(value) ||
    Buffer.from(value, "base64").length !== 16
  )
    fail("invalid-data", "Invalid legacy transport digest");
  return value;
}
function hashThrough(stream: C.ByteStream, algorithm: string, signal: AbortSignal) {
  const hash = createHash(algorithm);
  let result: string | undefined;
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      signal.throwIfAborted();
      hash.update(chunk);
      controller.enqueue(chunk);
    },
    flush() {
      result = hash.digest("base64");
    },
  });
  return {
    stream: stream.pipeThrough(transform, { signal }),
    result() {
      if (!result) fail("invalid-data", "Archive stream was not fully consumed");
      return result;
    },
  };
}
async function digest(
  stream: C.ByteStream,
  length: number,
  signal: AbortSignal,
): Promise<{ md5: string; sha256: string }> {
  const md5 = createHash("md5");
  const sha256 = createHash("sha256");
  const reader = stream.getReader();
  let received = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const item = await reader.read();
      signal.throwIfAborted();
      if (item.done) break;
      if (!(item.value instanceof Uint8Array) || (received += item.value.length) > length)
        fail("invalid-data", "Archive source length mismatch");
      md5.update(item.value);
      sha256.update(item.value);
    }
    if (received !== length) fail("invalid-data", "Archive source length mismatch");
    return { md5: md5.digest("base64"), sha256: sha256.digest("base64url") };
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
