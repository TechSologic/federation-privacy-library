# Experimental Runtime

The first implementation uses the existing UnoLock wire format. It does not
define a replacement federation protocol. Applications supply encrypted bytes,
storage implementations, public authority, and client-authorized proofs.

## Construction And Storage

`createFederation(config)` uses a separately operated Tor process. Configure its
onion service, local listener, SOCKS endpoint, and bootstrap peers. Both local
sockets must be loopback addresses. Startup checks the SOCKS service and reports
degraded readiness if it is unavailable; this check does not prove an onion
descriptor is already reachable everywhere. No redirects or clearnet fallback
are followed.

Supply one `FederationStorage` implementation. Conditional batches must be atomic
and durable; retrying the same commit identifier and exact mutation batch must
return the original outcome. Stored byte arrays must be copied or immutable.
One active runtime owns a store through a renewable lease. After an unclean
process exit another instance waits for that lease to expire. Changing the
configured onion identity while reusing its store is rejected.

`MemoryFederationStorage` is a reference/test adapter. Reusing it supports
instance replacement in a process, but it does not survive a process exit. Its
commit history is retained in memory. Production database and filesystem
adapters have not been provided or verified yet. The test archive adapter is
also intentionally memory-based and is not shipped as a production adapter.

## Address And Message Behavior

Address registration atomically stores the address and publication intent.
Publication is asynchronous and refreshed. Disabling/removing a local address
stops local serving; replicas may remain until their leases expire. Lookup
verifies public encryption and validation key commitments. Route hints and
custody acknowledgements do not install new identity authority.

`messages.source` encodes the existing five-element encrypted envelope. `send`
preserves its exact bytes before returning a transfer handle. A completed
message transfer means **the remote node accepted custody**. It does not promise
application processing, user delivery, or a read receipt.

Incoming messages receive a generic acknowledgement after persistent ingress
staging. The asynchronous receiver runs after address and application policy
checks. It must consume the entire stream and durably store or queue the data
before resolving. A repeated callback has the same `deliveryId`; adapters must
deduplicate effects. A crash between an adapter's durable write and the library's
completion record can repeat that callback. Sender authenticity inside the
sealed message remains an application check.

Provide a stable `operationId` when retrying a submission whose local commit
result was uncertain. Reusing it with different content is rejected. A cancelled
operation cannot undo custody or a commit already accepted by a peer.

## Archive Streams And Authorization

Sources must reopen the same encrypted bytes and support requested ranges.
Supply a `SourceResolver` to reopen archive sources after restart. A missing
source or read receiver pauses the transfer. Reattach a read receiver by calling
`read` with its original operation identifier. Instance recovery has been tested;
durability across process crashes depends on the supplied adapters.

Immutable first uploads larger than 8 MiB use the existing multipart endpoints.
Acknowledged parts and the upload identity are persisted. Mutable writes use the
existing staged-object path followed by a separate signed version commit.
Uploads stream with backpressure. Computing the required legacy MD5 and SHA-256
values can reopen and scan the source; the library does not retain the whole
archive in memory. MD5 is used only for existing transport compatibility; SHA-256
checks encrypted object integrity.

An incoming multipart stream may have no whole-object digest until completion.
The receiver stages bytes; the library then rereads staging and verifies length
and digests before asking the store to commit. An unknown commit is preserved
and inspected on retry. For mutable archives, committing bytes must not publish
the head: the adapter publishes only through its atomic `commitVersion` method,
checking both the predecessor and the referenced content's continued existence.

`AuthorizationHandler` resolves trusted public keys and bindings from the host's
records. The library verifies Ed25519 request signatures, exact request hashes,
operation/target bindings, expiry, and signed version context before invoking
policy or storage. Peer-supplied keys cannot replace this authority.

`ProofProvider` receives the canonical request bytes and hash and returns the
existing client-signed proof in a `ProtocolDocument`. The library never needs
the client's private signing key. Encoding helpers are available through the
`/protocol` export. Documents use `format: "unolock-json-v1"`.

Trusted bindings contain `spaceAccessRef` (or `spaceAuthorityId`) and
`signingKeyId`; version commits also require `writerAccessId`,
`spaceKeyEpochHash`, and `canWrite`. These names belong to the existing protocol,
not application Space workflows. A trusted `mutable: true` binding selects the
staged receipt for a mutable write.

Operation context may supply existing wire values: `previousPointerHash` and
`newEtag` for mutable writes, `createIntent` for creation, and `archiveListID` /
`authorityArchiveID` for deletion. An optional `expectedInfo` on reads pins the
expected encrypted length and digest. Full reads can check that digest; a range
checks its bounds and length and cannot prove a whole-object digest on its own.
Returned signed head documents are structurally/hash checked; the application
must verify them against its trusted signer before using their content authority.

## Current Limits And Remaining Compatibility Work

- Message envelopes are bounded at 256 KiB. Managed outbound admission may impose
  a smaller limit. Archive ciphertext follows the node limit: 5 GiB plus the
  existing per-chunk authentication-tag overhead. Tests exercise streaming and
  multipart behavior with smaller synthetic data, not a full 5 GiB transfer.
- Defaults allow four outbound transfers, eight attempts, and seven days of
  retained operations. The current queue capacity includes retained receipts;
  production admission/retention tuning remains open. Replica capacity and
  incoming request concurrency/rate are bounded.
- Archive listing uses the existing wire page size, so `limit` currently must be
  64. Receiving multipart uploads currently accepts sequential parts, including
  exact retries. Arbitrarily reordered parts are not supported.
- Cancellation attempts remote multipart cleanup, but cleanup after an offline
  peer is currently best effort. Incoming sessions expire; a pending commit must
  be resolved by the storage adapter before its staging can be discarded.
- An unacknowledged multipart initialization retains its exact signed request.
  Recovery beyond that proof's validity window still needs the reference
  relay/status flow. The relay endpoints are not implemented in this build.
- Creation requires the submitted descriptor to match the signed intent exactly.
  Managed provider-locator transformations and complete node/managed archive
  gateway parity still need adapters and interoperability tests.
- Application workflow admission, storage quotas, provider routing, and replica
  consistency remain host responsibilities. No AWS, database, or UI workflow has
  been pulled into the library.

## Verification Evidence

The independent suite covers address/key lookup, exact message bytes, node
custody, idempotent submission, lost acknowledgements, retry, cancellation,
instance replacement, storage conflicts, DHT lookup outcomes, stream integrity,
SOCKS framing, archive reads/writes, multipart recovery, signed proofs, signed
version commits, and control operations.

The separate real-Tor test has passed for address discovery and message custody
between two production instances. Selected library codecs have been accepted by
the node source modules; the managed source verifier accepts the same archive
request proof and custody response. A separate local compatibility check also exercises the
node's actual DHT HTTP server and exchanges its message format over a socket.
These checks do not establish complete legacy server interoperability,
independent security review, production scale, or npm
release readiness. Neither existing application has been migrated.
