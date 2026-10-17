import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
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
  return {
    authorization: {
      async resolveAuthority() {
        return { keys: [{ keyId: "synthetic-key", publicKey }], bindings: document(bindings) };
      },
      async authorize() {
        return "allow";
      },
    },
    proofs: {
      async provide(request) {
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
  maxChunk = 0;
  commits = 0;
  async receive(stream: C.ByteStream, metadata: C.ArchiveReceiveMetadata) {
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
    const stage = this.stages.get(metadata.stageId) ?? { metadata, parts: new Map() };
    stage.parts.set(metadata.range.offset, value);
    this.stages.set(metadata.stageId, stage);
    await this.afterReceive?.(metadata);
  }
  async create(
    _id: string,
    _collection: C.ArchiveCollection,
    metadata: C.ProtocolDocument,
  ): Promise<C.ArchiveDescription> {
    const wire = JSON.parse(Buffer.from(metadata.bytes).toString());
    const result = {
      archive: { id: wire.id, locator: wire.locator ?? "synthetic-locator" },
      revision: null,
      metadata,
    };
    this.descriptions.set(wire.id, result);
    return result;
  }
  async list(_collection: C.ArchiveCollection, _query: C.PageRequest): Promise<C.ArchiveList> {
    return { outcome: "listed", page: { items: [...this.descriptions.values()] } };
  }
  async stat(archive: C.ArchiveReference): Promise<C.ArchiveDescription | null> {
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
  async open(archive: C.ArchiveReference, options: C.CallOptions & { range?: C.ByteRange }) {
    const data = this.data.get(archive.id);
    if (!data) throw new Error("Missing archive");
    return memorySource(data.data).open(options);
  }
  async remove(_id: string, archive: C.ArchiveReference) {
    this.data.delete(archive.id);
    this.descriptions.delete(archive.id);
  }
  async inspectStage(id: string): Promise<Awaited<ReturnType<C.ArchiveStore["inspectStage"]>>> {
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
  async openStage(id: string, options: C.CallOptions & { range?: C.ByteRange }) {
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
  ): Promise<Awaited<ReturnType<C.ArchiveStore["commitStage"]>>> {
    const stage = this.stages.get(id)!;
    if (stage.committed) return { outcome: "committed", revision: stage.committed };
    if ((this.data.get(archive.id)?.revision ?? null) !== expected) return { outcome: "conflict" };
    const data = await collect(await this.openStage(id, {}), info.byteLength, {}, info.byteLength);
    const revision = `"${createHash("md5").update(data).digest("hex")}"`;
    this.data.set(archive.id, { archive, info, data, revision });
    stage.committed = revision;
    this.commits++;
    return { outcome: "committed", revision };
  }
  async discardStage(id: string): Promise<"discarded" | "already-committed"> {
    if (this.stages.get(id)?.committed) return "already-committed";
    this.stages.delete(id);
    return "discarded";
  }
  async head(archive: C.ArchiveReference) {
    return this.versions.get(archive.id) ?? null;
  }
  async commitVersion(
    _id: string,
    archive: C.ArchiveReference,
    predecessor: string | null,
    version: C.ArchiveVersion,
  ): Promise<C.VersionCommit> {
    const current = this.versions.get(archive.id) ?? null;
    if ((current?.hash ?? null) !== predecessor) return { outcome: "conflict", current };
    this.versions.set(archive.id, version);
    return { outcome: "committed", version };
  }
}
