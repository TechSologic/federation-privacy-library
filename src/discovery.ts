import type { AddressIdentity, ResolvedAddress } from "./contracts.js";
import { hashAddress, nodeId, onion, verifyAddressKeys } from "./address.js";
import { State } from "./state.js";
import { HttpWire } from "./transport.js";
import { DhtRoutingTable, type DhtContact } from "./dht/routingTable.js";
import { walkDht } from "./dht/iterativeLookup.js";
import { publishDhtValue } from "./dht/publication.js";
import { DhtAdmission } from "./dht/admission.js";
import { fail, integer } from "./errors.js";
import {
  base64,
  decodeLookup,
  gridPath,
  keyPath,
  object,
  replicaLeaseMs,
  type LookupRecord,
  validateLookupEnvelope,
} from "./protocol/lookup.js";

interface Replica {
  encoded: string;
  storedAt: number;
}
export interface Publication extends Replica {
  published: boolean;
}
interface PinnedKeys {
  keys: ResolvedAddress["keys"];
  policy: ResolvedAddress["policy"];
  archiveOnionService?: string;
}
const outbound = new DhtAdmission(32);
export class Discovery {
  readonly table: DhtRoutingTable;
  readonly candidates = new Set<string>();
  constructor(
    readonly endpoint: string,
    readonly bootstrap: readonly { onionService: string }[],
    readonly wire: HttpWire,
    readonly state: State,
  ) {
    this.table = new DhtRoutingTable(nodeId(endpoint));
    if (bootstrap.length > 64) fail("limit-exceeded", "Too many bootstrap peers");
    bootstrap.forEach((peer) => onion(peer.onionService));
  }
  offer(endpoint: string) {
    onion(endpoint);
    if (endpoint !== this.endpoint && this.candidates.size < 128) this.candidates.add(endpoint);
  }
  seeds(target: string): DhtContact[] {
    return [
      ...this.table.closest(target, 20),
      ...this.bootstrap.map((peer) => ({
        id: nodeId(peer.onionService),
        endpoint: peer.onionService,
      })),
    ].filter((c) => c.id !== this.table.localId);
  }
  private async rpc(
    endpoint: string,
    method: string,
    payload: unknown,
    signal: AbortSignal,
  ): Promise<any> {
    return outbound.run(() => this.wire.json(endpoint, gridPath + method, payload, signal), signal);
  }
  async probe(endpoint: string, signal: AbortSignal) {
    const r = object(
      await this.rpc(
        endpoint,
        "ping",
        { type: "unolock.grid.ping.v1", onionService: this.endpoint },
        signal,
      ),
      ["type", "ok", "checkedAt"],
    );
    if (r.type !== "unolock.grid.ping.response.v1" || r.ok !== true)
      fail("invalid-data", "Invalid peer response");
    integer(r.checkedAt, 1);
    this.table.verified({ id: nodeId(endpoint), endpoint });
  }
  async peers(contact: DhtContact, target: string, signal: AbortSignal): Promise<DhtContact[]> {
    const r = object(
      await this.rpc(
        contact.endpoint,
        "find-node",
        {
          type: "unolock.grid.findNode.v1",
          routingKey: Buffer.from(target, "hex").toString("base64url"),
        },
        signal,
      ),
      ["type", "peers"],
    );
    if (
      r.type !== "unolock.grid.findNode.response.v1" ||
      !Array.isArray(r.peers) ||
      r.peers.length > 64
    )
      fail("invalid-data", "Invalid peer response");
    const peers = r.peers.map((p: unknown) => {
      const v = object(p, ["onionService"]);
      const endpoint = onion(v.onionService);
      return { id: nodeId(endpoint), endpoint };
    });
    this.table.verified(contact);
    return peers;
  }
  async findLocal(addressHash: string): Promise<Replica | null> {
    const address = await this.state.storage.addresses.get(addressHash);
    if (address) {
      if (!address.value.enabled || (address.value.expiresAt ?? Infinity) <= Date.now())
        return null;
      return (await this.state.get<Publication>("publication", addressHash))?.value ?? null;
    }
    const replica = await this.state.get<Replica>("replica", addressHash);
    return replica && replica.value.storedAt + replicaLeaseMs > Date.now() ? replica.value : null;
  }
  async putReplica(addressHash: string, encoded: string): Promise<number> {
    hashAddress(addressHash);
    validateLookupEnvelope(encoded, addressHash);
    const local = await this.state.storage.addresses.get(addressHash);
    if (local) {
      const owned = await this.state.get<Publication>("publication", addressHash);
      if (owned?.value.encoded !== encoded)
        fail("conflict", "Owned lookup record cannot be replaced by a replica");
      return owned.value.storedAt;
    }
    const previous = await this.state.get<Replica>("replica", addressHash);
    if (
      previous &&
      previous.value.storedAt + replicaLeaseMs > Date.now() &&
      previous.value.encoded !== encoded
    )
      fail("conflict", "Lookup replica conflict");
    // Admission count is committed atomically with the new replica.
    const count = await this.state.get<number>("capacity", "replicas");
    if (!previous && (count?.value ?? 0) >= 4096)
      fail("limit-exceeded", "Lookup replica capacity reached");
    const now = Date.now();
    const mutations = [
      this.state.mutation(
        "replica",
        addressHash,
        previous?.revision ?? null,
        { encoded, storedAt: now },
        now + replicaLeaseMs,
      ),
    ];
    if (!previous)
      mutations.push(
        this.state.mutation(
          "capacity",
          "replicas",
          count?.revision ?? null,
          (count?.value ?? 0) + 1,
        ),
      );
    const result = await this.state.commit(mutations);
    if (result.outcome === "fenced") fail("storage", "Runtime storage ownership changed");
    if (result.outcome === "conflict") fail("unavailable", "Lookup replica busy", true);
    return now;
  }
  async publish(addressHash: string, value: Publication, signal: AbortSignal): Promise<boolean> {
    const result = await publishDhtValue({
      target: addressHash,
      localId: this.table.localId,
      seeds: this.seeds(addressHash),
      signal,
      value: value.encoded,
      query: async (contact, target, bounded) => ({
        contacts: await this.peers(contact, target, bounded),
      }),
      put: async (contact, encoded, bounded) => {
        const r = object(
          await this.rpc(
            contact.endpoint,
            "put-value",
            { type: "unolock.grid.putValue.v1", addressHash, lookupValue: encoded },
            bounded,
          ),
          ["type", "stored", "addressHash", "storedAt"],
        );
        if (
          r.type !== "unolock.grid.putValue.response.v1" ||
          r.stored !== true ||
          r.addressHash !== addressHash
        )
          fail("invalid-data", "Invalid publication response");
        integer(r.storedAt, 1);
      },
    });
    return result.complete;
  }
  async lookup(
    identity: AddressIdentity,
    signal: AbortSignal,
  ): Promise<{ resolved: ResolvedAddress; record: LookupRecord } | null> {
    const hash = identity.addressHash;
    const pin = await this.state.get<Replica>("lookup-pin", hash);
    let value = pin?.value ?? (await this.findLocal(hash));
    if (!value) {
      const result = await walkDht<Replica>({
        target: hash,
        localId: this.table.localId,
        seeds: this.seeds(hash),
        signal,
        query: async (contact, target, bounded) => {
          const r = object(
            await this.rpc(
              contact.endpoint,
              "find-value",
              { type: "unolock.grid.findValue.v1", addressHash: hash },
              bounded,
            ),
            ["type", "found", "addressHash"],
            ["lookupValue", "storedAt"],
          );
          if (
            r.type !== "unolock.grid.findValue.response.v1" ||
            r.addressHash !== hash ||
            typeof r.found !== "boolean"
          )
            fail("invalid-data", "Invalid lookup response");
          this.table.verified(contact);
          if (r.found) {
            integer(r.storedAt, 1);
            validateLookupEnvelope(r.lookupValue, hash);
            if (r.storedAt > Date.now() + 60_000 || r.storedAt + replicaLeaseMs <= Date.now())
              fail("invalid-data", "Expired lookup response");
            return { contacts: [], value: { encoded: r.lookupValue, storedAt: r.storedAt } };
          }
          return { contacts: await this.peers(contact, target, bounded) };
        },
      });
      signal.throwIfAborted();
      if (result.status === "converged") return null;
      if (result.status !== "found" || !result.value)
        fail("unavailable", "Federation lookup could not complete", true);
      value = result.value;
    }
    // Verify before committing. A replica alone is never a trusted pin.
    decodeLookup(value.encoded, hash, identity.validationFingerprint);
    if (!pin) {
      value = await this.pin("lookup-pin", hash, value);
    }
    const record = decodeLookup(value.encoded, hash, identity.validationFingerprint);
    const cached = await this.state.get<PinnedKeys>("key-pin", hash);
    const result = (pinned: PinnedKeys) => ({
      record,
      resolved: {
        identity,
        keys: verifyAddressKeys(identity, pinned.keys),
        policy: pinned.policy,
        expiresAt: record.expiresAt,
        routes: {
          messageOnionService: record.targets[0]!.onionService,
          archiveOnionService: pinned.archiveOnionService ?? record.targets[0]!.onionService,
        },
      },
    });
    if (cached) return result(cached.value);
    let missing = 0;
    for (const target of record.targets) {
      try {
        const r = object(
          await outbound.run(
            () =>
              this.wire.json(
                target.onionService,
                keyPath,
                { type: "unolock.receiveAddress.publicKey.v1", addressHash: hash },
                signal,
                300 * 1024,
              ),
            signal,
          ),
          ["type", "found", "addressHash"],
          [
            "publicKey",
            "validationKeys",
            "allowAttachments",
            "maxAttachmentBytes",
            "custodyDelegation",
            "ttl",
            "attachmentGatewayOnionService",
          ],
        );
        if (
          r.type !== "unolock.receiveAddress.publicKey.response.v1" ||
          r.addressHash !== hash ||
          typeof r.found !== "boolean"
        )
          fail("invalid-data", "Invalid address response");
        if (!r.found) {
          missing++;
          continue;
        }
        const keys = verifyAddressKeys(identity, {
          publicKey: r.publicKey,
          validationKeys: r.validationKeys,
        });
        if (typeof r.allowAttachments !== "boolean")
          fail("invalid-data", "Invalid attachment policy");
        integer(r.maxAttachmentBytes, 0, 5 * 1024 ** 3);
        if (r.attachmentGatewayOnionService !== undefined) onion(r.attachmentGatewayOnionService);
        const pinned = await this.pin<PinnedKeys>("key-pin", hash, {
          keys,
          policy: {
            allowAttachments: r.allowAttachments,
            maxAttachmentBytes: r.maxAttachmentBytes,
          },
          archiveOnionService: r.attachmentGatewayOnionService ?? target.onionService,
        });
        return result(pinned);
      } catch {
        signal.throwIfAborted();
      }
    }
    if (missing === record.targets.length) return null;
    fail("unavailable", "No verified destination is reachable", true);
  }

  private async pin<T>(collection: "lookup-pin" | "key-pin", hash: string, value: T): Promise<T> {
    // Pins are trust state, not disposable performance caches. At capacity,
    // reject new bindings instead of forgetting an existing one.
    for (let attempt = 0; attempt < 4; attempt++) {
      const existing = await this.state.get<T>(collection, hash);
      if (existing) return existing.value;
      const count = await this.state.get<number>("capacity", collection);
      if ((count?.value ?? 0) >= 4096)
        fail("limit-exceeded", "Verified lookup pin capacity reached");
      const committed = await this.state.commit([
        this.state.mutation(collection, hash, null, value),
        this.state.mutation(
          "capacity",
          collection,
          count?.revision ?? null,
          (count?.value ?? 0) + 1,
        ),
      ]);
      if (committed.outcome === "fenced") fail("storage", "Runtime storage ownership changed");
      if (committed.outcome === "committed") return value;
    }
    fail("unavailable", "Verified lookup pin storage busy", true);
  }
}
