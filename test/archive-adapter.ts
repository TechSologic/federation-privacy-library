import { createHash, createHmac, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type * as C from "../src/index.js";
import { memorySource } from "../src/testing/index.js";
import { collect } from "../src/streams.js";
import { canonical, document } from "../src/protocol/archives.js";

export function archivePolicy(mutable = false): {
  authorization: C.AuthorizationHandler;
  proofs: C.ProofProvider;
  pointer: (
    archiveId: string,
    info: C.ArchiveInfo,
    predecessor?: Record<string, any>,
  ) => C.ProtocolDocument;
  proofRequests: { operation: C.AuthorizedOperation; request: Record<string, any> }[];
  authorizationRequests: C.AuthorizationRequest[];
} {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const bindings = {
    spaceAccessRef: "synthetic-authority",
    spaceAuthorityId: "synthetic-authority",
    signingKeyId: "synthetic-key",
    writerAccessId: "synthetic-writer",
    spaceKeyEpochHash: "synthetic-epoch",
    canWrite: true,
    mutable,
  };
  const proofRequests: { operation: C.AuthorizedOperation; request: Record<string, any> }[] = [];
  const authorizationRequests: C.AuthorizationRequest[] = [];
  return {
    proofRequests,
    authorizationRequests,
    authorization: {
      async resolveAuthority() {
        return {
          keys: [{ keyId: "synthetic-key", publicKey }],
          bindings: document(bindings),
          archiveCollection: {
            id: "synthetic-collection",
            authorityArchiveId: "synthetic-authority-archive",
          },
        };
      },
      async authorize(request) {
        authorizationRequests.push(request);
        return "allow";
      },
    },
    proofs: {
      async provide(request) {
        proofRequests.push({
          operation: request.operation,
          request: JSON.parse(Buffer.from(request.canonicalRequest).toString()),
        });
        const wireOperation =
          request.operation === "archive-head"
            ? "read"
            : request.operation.startsWith("archive-")
              ? request.operation.slice(8)
              : request.operation;
        const unsigned = {
          type: "unolock.federation.archive-request.v1",
          spaceAccessRef: bindings.spaceAccessRef,
          operation: wireOperation,
          archiveID: request.target.archive!.id,
          requestHash: request.requestHash,
          issuedAt: Date.now(),
          expiresAt: Date.now() + 120_000,
          nonce: randomBytes(16).toString("base64url"),
          signatureAlgorithm: "Ed25519",
        };
        return [
          document({
            ...unsigned,
            signature: sign(null, canonical(unsigned), pair.privateKey).toString("base64url"),
          }),
        ];
      },
    },
    pointer(archiveId, info, previous) {
      const hashBody = {
        version: 1,
        archiveId,
        contentCid: `uobj:v1:sha256:${info.sha256}`,
        contentHash: `sha256:${Buffer.from(info.sha256, "base64url").toString("hex")}`,
        previousPointerHash: previous?.pointerHash ?? "",
        previousContentHash: previous?.contentHash ?? "",
        sequence: (previous?.sequence ?? 0) + 1,
        writerAccessId: bindings.writerAccessId,
        signingKeyId: bindings.signingKeyId,
        spaceAuthorityId: bindings.spaceAuthorityId,
        spaceKeyEpochHash: bindings.spaceKeyEpochHash,
        issuedAt: Date.now(),
        signatureAlgorithm: "Ed25519",
      };
      const unsigned = {
        ...hashBody,
        pointerHash: createHash("sha256").update(canonical(hashBody)).digest("base64url"),
      };
      return document({
        ...unsigned,
        signature: sign(null, canonical(unsigned), pair.privateKey).toString("base64url"),
      });
    },
  };
}
/** Deliberately in-memory test fixture; not a production storage adapter. */
export class TestArchives implements C.ArchiveStore, C.ArchiveReceiver {
  readonly data = new Map<
    string,
    { archive: C.ArchiveReference; data: Uint8Array; info: C.ArchiveInfo; revision: string }
  >();
  readonly stages = new Map<
    string,
    { metadata: C.ArchiveReceiveMetadata; parts: Map<number, Uint8Array>; committed?: string }
  >();
  readonly versions = new Map<string, C.ArchiveVersion>();
  readonly descriptions = new Map<string, C.ArchiveDescription>();
  afterReceive?: (metadata: C.ArchiveReceiveMetadata) => Promise<void>;
  private latestFenceEpoch = 0;
  private readonly cursorKey = randomBytes(32);
  maxChunk = 0;
  commits = 0;
  private active(options: C.ArchiveStoreCall) {
    options.signal.throwIfAborted();
  }
  private mutation(fence: C.StorageFence, options: C.ArchiveStoreCall) {
    this.active(options);
    if (fence.epoch < this.latestFenceEpoch) throw new Error("Archive mutation was fenced");
    this.latestFenceEpoch = fence.epoch;
  }
  cursorFor(collection: C.ArchiveCollection): string {
    const scope = canonical({
      id: collection.id,
      authorityArchiveId: collection.authorityArchiveId,
    });
    return createHmac("sha256", this.cursorKey).update(scope).digest("base64url");
  }
  async receive(stream: C.ByteStream, metadata: C.ArchiveReceiveMetadata) {
    this.mutation(metadata.fence, { signal: metadata.signal });
    const measured = stream.pipeThrough(
      new TransformStream({
        transform: (chunk: Uint8Array, controller) => {
          this.maxChunk = Math.max(this.maxChunk, chunk.length);
          controller.enqueue(chunk);
        },
      }),
    );
    const value = await collect(
      measured,
      metadata.range.length,
      { signal: metadata.signal },
      metadata.range.length,
    );
    this.mutation(metadata.fence, { signal: metadata.signal });
    const stage = this.stages.get(metadata.stageId) ?? { metadata, parts: new Map() };
    stage.parts.set(metadata.range.offset, value);
    this.stages.set(metadata.stageId, stage);
    await this.afterReceive?.(metadata);
  }
  async create(
    _id: string,
    _collection: C.ArchiveCollection,
    metadata: C.ProtocolDocument,
    fence: C.StorageFence,
    options: C.ArchiveStoreCall,
  ): Promise<C.ArchiveDescription> {
    this.mutation(fence, options);
    const wire = JSON.parse(Buffer.from(metadata.bytes).toString());
    const result = {
      archive: { id: wire.id, locator: wire.locator ?? "synthetic-locator" },
      revision: null,
      metadata,
    };
    this.descriptions.set(wire.id, result);
    return result;
  }
  async list(
    _collection: C.ArchiveCollection,
    _query: C.PageRequest,
    options: C.ArchiveStoreCall,
  ): Promise<C.ArchiveList> {
    this.active(options);
    if (_query.cursor !== undefined && _query.cursor !== this.cursorFor(_collection))
      throw new Error("Archive cursor scope mismatch");
    return { outcome: "listed", page: { items: [...this.descriptions.values()] } };
  }
  async stat(
    archive: C.ArchiveReference,
    options: C.ArchiveStoreCall,
  ): Promise<C.ArchiveDescription | null> {
    this.active(options);
    const stored = this.data.get(archive.id);
    return stored
      ? {
          archive,
          info: stored.info,
          revision: stored.revision,
          metadata: document({ id: archive.id }),
        }
      : (this.descriptions.get(archive.id) ?? null);
  }
  async open(archive: C.ArchiveReference, options: C.ArchiveStoreCall & { range?: C.ByteRange }) {
    options.signal.throwIfAborted();
    const data = this.data.get(archive.id);
    if (!data) throw new Error("Missing archive");
    return memorySource(data.data).open(options);
  }
  async remove(
    _id: string,
    archive: C.ArchiveReference,
    fence: C.StorageFence,
    options: C.ArchiveStoreCall,
  ) {
    this.mutation(fence, options);
    this.data.delete(archive.id);
    this.descriptions.delete(archive.id);
  }
  async inspectStage(
    id: string,
    options: C.ArchiveStoreCall,
  ): Promise<Awaited<ReturnType<C.ArchiveStore["inspectStage"]>>> {
    this.active(options);
    const stage = this.stages.get(id);
    if (!stage) return { state: "absent" };
    if (stage.committed) {
      const stored = this.data.get(stage.metadata.archive.id)!;
      return {
        state: "committed",
        archive: stored.archive,
        info: stored.info,
        revision: stage.committed,
      };
    }
    return {
      state: "staged",
      metadata: stage.metadata,
      ranges: [...stage.parts].map(([offset, data]) => ({ offset, length: data.length })),
    };
  }
  async openStage(id: string, options: C.ArchiveStoreCall & { range?: C.ByteRange }) {
    options.signal.throwIfAborted();
    const stage = this.stages.get(id);
    if (!stage) throw new Error("Missing stage");
    const parts = [...stage.parts].sort(([a], [b]) => a - b);
    let end = 0;
    for (const [offset, data] of parts) {
      if (offset !== end) throw new Error("Stage has a gap");
      end += data.length;
    }
    return memorySource(Buffer.concat(parts.map(([, data]) => data))).open(options);
  }
  async commitStage(
    id: string,
    archive: C.ArchiveReference,
    info: C.ArchiveInfo,
    expected: string | null,
    fence: C.StorageFence,
    options: C.ArchiveStoreCall,
  ): Promise<Awaited<ReturnType<C.ArchiveStore["commitStage"]>>> {
    this.mutation(fence, options);
    const stage = this.stages.get(id)!;
    if (stage.committed) return { outcome: "committed", revision: stage.committed };
    if ((this.data.get(archive.id)?.revision ?? null) !== expected) return { outcome: "conflict" };
    const data = await collect(
      await this.openStage(id, options),
      info.byteLength,
      options,
      info.byteLength,
    );
    this.mutation(fence, options);
    const revision = `"${createHash("md5").update(data).digest("hex")}"`;
    this.data.set(archive.id, { archive, info, data, revision });
    stage.committed = revision;
    this.commits++;
    return { outcome: "committed", revision };
  }
  async discardStage(
    id: string,
    fence: C.StorageFence,
    options: C.ArchiveStoreCall,
  ): Promise<"discarded" | "already-committed"> {
    this.mutation(fence, options);
    if (this.stages.get(id)?.committed) return "already-committed";
    this.stages.delete(id);
    return "discarded";
  }
  async head(archive: C.ArchiveReference, options: C.ArchiveStoreCall) {
    this.active(options);
    return this.versions.get(archive.id) ?? null;
  }
  async commitVersion(
    _id: string,
    archive: C.ArchiveReference,
    predecessor: string | null,
    version: C.ArchiveVersion,
    fence: C.StorageFence,
    options: C.ArchiveStoreCall,
  ): Promise<C.VersionCommit> {
    this.mutation(fence, options);
    const current = this.versions.get(archive.id) ?? null;
    if ((current?.hash ?? null) !== predecessor) return { outcome: "conflict", current };
    this.versions.set(archive.id, version);
    return { outcome: "committed", version };
  }
}
