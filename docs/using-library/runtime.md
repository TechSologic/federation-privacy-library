# Runtime And Provider Contracts

The library implements the UnoLock federation wire protocol. Applications supply encrypted bytes,
storage implementations, public authority, client-authorized proofs, and event
handlers. The library owns protocol validation and federation orchestration.

## One Facade, Explicit Capabilities

Read the [architecture overview](architecture.md) for component relationships,
public interfaces, the capability matrix and end-to-end flows.

All application orchestration uses `createFederation({ storage, handlers, tor,
transport?, limits?, scheduling? })`. The returned object exposes `addresses`,
`messages`, `archives`, `transfers`, `peers`, and one `start`/`stop` lifecycle.
The factory validates provider dependencies before any I/O. No public coordinator,
resolver, RPC-client or worker construction is required.

The composition root creates focused internal services. Providers contain effects;
services own protocol rules and scheduling. There is no plugin registration order,
service locator, inheritance requirement, or application database in the core.

Supply the storage capabilities the host needs. Atomic address/state/lease/commit
capabilities enable registrations, transfer handles, the built-in listener and
archives. Host lookup/publication/delivery stores enable the host queue integration. Both are configured through one public
contract; they must never operate on the same durable jobs. An operation requiring
an absent capability fails explicitly with `FederationError`; there is no hidden
memory fallback. Archive operations require atomic runtime storage, an
archive store/receiver for inbound service, and client-authorized proofs.
Built-in receivers, source resolution, runtime limits and listener configuration
are rejected without atomic storage rather than being silently ignored.

All production storage is application-owned and **must be encrypted at rest**.
This requirement covers records, message and archive ciphertext, routing values,
secondary indexes, commit journals, temporary files, replicas and backups. Keep
storage-encryption keys outside the data store, separate keys by purpose, support
rotation, and ensure retired copies become unreadable. Database, disk or volume
encryption alone is sufficient only when it also covers every listed copy and its
keys are not stored beside the protected data.

`messages.send` accepts a data source and returns a transfer handle after durable
queuing. `messages.submit` accepts an existing encoded delivery request and returns
an explicit custody/queued outcome with its stable delivery ID. The latter serves
host-managed delivery queues. Custody never means inbox
acceptance or recipient authorization. The reference host delivery queue allows 96 counted attempts; the built-in runtime
defaults to eight attempts. Their persistence and retry semantics are distinct.

`peers` provides bounded wire requests for host request handlers and key resolution.
Returned key metadata remains untrusted. Pure encodings and validators are grouped
under the root `protocol` namespace. `/adapters` contains storage implementation
tools; `/testing` includes internal fixtures solely for compatibility tests.

### Event And Failure Contracts

`handlers.onEvent` receives only typed runtime status or aggregate diagnostics.
It may be synchronous or asynchronous. Exceptions and rejected promises are
contained. At most one notification is executing and one latest notification is
pending per observer; slow observers coalesce intermediate notifications. Events
are best effort, are not durable, and never delay shutdown. Transfer listeners
have the same bounded dispatch behavior; query the transfer for authoritative state.

Durable message/archive receivers and `handlers.deliveryStatus` are different:
they are awaited and must fulfill their persistence contracts. Status callbacks
are not atomic with queue mutation. `FederationSubmissionError` carries
`operationId`, `outcome`, and a sanitized `failure`. For encoded submissions,
`accepted` means the endpoint accepted custody even though a subsequent status
handler failed; retrying as a new delivery would be incorrect. `unknown` means the
library cannot establish the final local submission state. Keep a stable caller
ID across uncertain submissions. Generated IDs are returned on immediate success
and included in submission failures. No raw provider exception is exposed by that
error. Queue consumers remain responsible for bounded idempotency guarantees.

### Lifecycle

`start` owns worker scheduling and can be called again after a completed `stop`.
Concurrent lifecycle calls are serialized. Hosts close incoming admission first,
then await `stop`, then close providers. The facade drains submissions that were
still entering persistence when shutdown began. It rejects new work while stopped.
Host transports must enforce finite I/O budgets; host delivery work drains
without claiming that remote custody was cancelled. The runtime's fenced storage
and deadline behavior below continue to apply to its atomic-state capabilities.
Manual host operations can be used before starting background scheduling.

## Construction And Storage

The built-in runtime uses a separately operated Tor process. Configure its
onion service, local listener, SOCKS endpoint, and bootstrap peers. Both local
sockets must be loopback addresses. Startup checks the SOCKS service and reports
degraded readiness if it is unavailable; this check does not prove an onion
descriptor is already reachable everywhere. No redirects or clearnet fallback
are followed.

Supply one `storage` provider object. For the built-in runtime, implement its
address/state/lease/commit capabilities. Conditional batches must be atomic
and durable; retrying the same commit identifier and exact mutation batch under
the same valid fence must return the original outcome. Stored byte arrays must
be copied or immutable.
The storage adapter issues a monotonically increasing fence with its renewable
lease and atomically rejects every mutation made with an expired or superseded
fence. Archive receivers and stores receive the same fence and must enforce it
against the same lease authority. Renewal loss closes listener admission,
cancels active work, and rejects public mutations. After an unclean process exit
another instance waits for the lease to expire. Changing the configured onion
identity while reusing its store is rejected.
The runtime tracks the last confirmed expiry independently of the renewal call;
if a backend leaves renewal unresolved through that expiry, the runtime still
clears its fence, aborts work, and closes listener admission.

Every archive-store call also receives the request cancellation signal. A store
must stop cancellable work and must not make a later durable mutation after that
signal aborts. If a custom adapter does not settle after cancellation, its work
remains counted against the fixed inbound admission limit until it does settle;
timed-out work cannot create an unbounded orphan queue inside the library.

`MemoryFederationStorage` is a reference/test adapter. Reusing it supports
instance replacement in a process, but it does not survive a process exit. Its
commit history is retained in memory. The library ships no production database
or filesystem adapter. The test archive adapter is
also intentionally memory-based and is not shipped as a production adapter.

## Address And Message Behavior

Address registration atomically stores the address and publication intent.
Publication is asynchronous and refreshed. Disabling/removing a local address
stops local serving; replicas may remain until their leases expire. Lookup
verifies public encryption and validation key commitments. Route hints and
custody acknowledgements do not install new identity authority.

The built-in runtime requires `handlers.routes` when it publishes addresses.
The library gives that provider the exact canonical route bytes. The provider
must have the address-owning client verify the onion target, delivery path,
address hash and validity window, then return an ML-DSA-65 signature made with
the private validation key committed by the address. The library verifies the
signature, seals the authorized route to the address commitment, and publishes
only that opaque value. It opens and verifies the route again during destination
resolution. Default authorizations use `expiresAt: 0`, binding the address to its
original node's onion service indefinitely; the client need not stay online.
This fixed binding prevents DHT redirection. A different onion service requires a
new address, not a replacement publication. Finite authorizations remain
supported but cannot provide indefinite offline discovery; their expiry does
not permit changing a pinned node binding. A peer response, delivery acknowledgement or routing cache entry
cannot grant or replace route authority. Route authorization does not validate
the separate signature inside an encrypted application message.

`messages.source` encodes the five-element encrypted envelope. `send`
preserves its exact bytes before returning a transfer handle. A completed
message transfer means **the remote node accepted custody**. It does not promise
application processing, user delivery, or a read receipt.

Incoming messages receive a generic acknowledgement after persistent ingress
staging. The asynchronous receiver runs after address and application policy
checks. It must consume the entire stream and durably store or queue the data
before resolving. Messages rejected before the receiver runs release capacity
and leave no attacker-controlled receipt. Receipts for invoked receivers remain
for replay deduplication but no longer consume active ingress capacity. A
repeated callback has the same `deliveryId`; adapters must deduplicate effects.
A crash between an adapter's durable write and the library's completion record
can repeat that callback. Every application message must be signed before it is
encrypted and passed to `messages.source`. After decryption, the receiving
application must validate that signature before acting on the message. The
library transports the sealed header unchanged and deliberately cannot validate
this application signature.

Provide a stable `operationId` when retrying a submission whose local commit
result was uncertain. Reusing it with different content is rejected. A cancelled
operation cannot undo custody or a commit already accepted by a peer.

## Archive Streams And Authorization

Sources must reopen the same encrypted bytes and support requested ranges.
Supply a `SourceResolver` to reopen archive sources after restart. A missing
source or read receiver pauses the transfer. Reattach a read receiver by calling
`read` with its original operation identifier. Instance recovery uses persisted
transfer/source state; durability across process crashes depends on the adapters.

Immutable first uploads larger than 8 MiB use multipart endpoints.
Acknowledged parts and the upload identity are persisted. Mutable writes use the
staged-object path followed by a separate signed version commit.
Uploads stream with backpressure. Computing the protocol-required MD5 and SHA-256
values can reopen and scan the source; the library does not retain the whole
archive in memory. MD5 is used only for wire-protocol compatibility; SHA-256
checks encrypted object integrity.

An incoming multipart stream may have no whole-object digest until completion.
The receiver stages bytes; the library then rereads staging and verifies length
and digests before asking the store to commit. An unknown commit is preserved
and inspected on retry. For mutable archives, committing bytes must not publish
the head: the adapter publishes only through its atomic `commitVersion` method,
checking both the predecessor and the referenced content's continued existence.

`handlers.authorization` resolves trusted public keys and bindings from the host's
records. The library verifies Ed25519 request signatures, exact request hashes,
operation/target bindings, expiry, and signed version context before invoking
policy or storage. Peer-supplied keys cannot replace this authority.

`handlers.proofs` receives the canonical request bytes and hash and returns the
client-signed proof in a `ProtocolDocument`. The library never needs
the client's private signing key. Encoding helpers are available through the root `protocol` namespace. Documents use `format: "unolock-json-v1"`.

Trusted bindings contain `spaceAccessRef` (or `spaceAuthorityId`) and
`signingKeyId`; version commits also require `writerAccessId`,
`spaceKeyEpochHash`, and `canWrite`. These names belong to the wire protocol,
not application Space workflows. A trusted `mutable: true` binding selects the
staged receipt for a mutable write.

Operation context may supply wire values: `previousPointerHash` and
`newEtag` for mutable writes, `createIntent` for creation, and `archiveListID` /
`authorityArchiveID` for deletion. The v1 control proof does not
cover its outer collection selector, so the authorization resolver must return
the trusted `archiveCollection`; the library compares it before calling storage.
Stores must authenticate and scope cursors they issue; cursor strings are bounded
to 4096 characters in requests and responses. Reads require trusted
whole-object `expectedInfo`; a range also requires a digest for exactly that
interval. Returned mutable heads are verified against an explicitly supplied
trusted authority or one resolved by the local authorization handler before the
library exposes them. Each `head` call also requires an application-held
freshness checkpoint. Use `minimumSequence: 0` only for explicit first use. After
observing a head, persist its sequence and hash and supply both on later reads;
the library rejects a lower sequence, a changed hash at the checkpoint sequence,
or a missing head after an observed sequence.

## Limits

- Message envelopes are bounded at 256 KiB. Managed outbound admission may impose
  a smaller limit. Archive ciphertext follows the node limit: 5 GiB plus the
  per-chunk authentication-tag overhead. Tests exercise streaming and
  multipart behavior with smaller synthetic data, not a full 5 GiB transfer.
- Defaults allow four outbound transfers, eight attempts, and seven days of
  retained receipts. Terminal ingress receipts do not consume active queue
  capacity. Replica capacity and incoming request concurrency/rate are bounded.
- Inbound and outbound requests have a finite wall-clock lifetime in addition
  to socket inactivity limits. Control requests default to 60 seconds. Routes
  that stream archive bytes default to 24 hours so a progressing 5 GiB Tor
  transfer is not forced into the control deadline; both limits may be lowered
  in `FederationConfiguration.limits`. Maintenance, ingress, and outbound
  delivery run in independent workers so a progressing archive attempt cannot
  suspend the other queues. A peer receives a timeout response at the deadline;
  a non-cooperative handler continues to occupy one of the 16 admission slots
  until its adapter work actually settles.
- The built-in connector bounds local proxy connection and method negotiation
  separately at five seconds each. Onion descriptor lookup and rendezvous may
  use the remaining request deadline, capped at 60 seconds for connection
  establishment across at most three attempts. Only temporary SOCKS connection
  failures are retried, with a bounded delay and no application bytes sent until
  a connection succeeds. Invalid descriptors or addresses, missing or incorrect
  client authorization, and malformed replies are terminal. Caller cancellation,
  a lower request deadline, or transport shutdown interrupts preparation and
  retries. This does not replay HTTP requests or change host transport providers.
- Archive listing uses a fixed wire page size, so `limit` must be 64. Receiving multipart uploads accepts sequential parts, including
  exact retries. Arbitrarily reordered parts are not supported.
- Cancellation attempts remote multipart cleanup, but cleanup after an offline
  peer is best effort. Incoming sessions expire; a pending commit must
  be resolved by the storage adapter before its staging can be discarded.
- An unacknowledged multipart initialization retains its exact signed request.
  Recovery beyond that proof's validity window requires a relay/status flow.
  Relay endpoints are not implemented.
- Creation requires the submitted descriptor to match the signed intent exactly.
  Provider-specific descriptor or locator transformations require an application
  adapter and interoperability validation.
- Application workflow admission, storage quotas, provider routing, and replica
  consistency remain host responsibilities.

## Host Queue Integration

Use this path when your application supplies lookup/publication/delivery stores
and a Tor transport. The library constructs lookup, destination resolution,
publication and retry services. The application owns its inbound listener,
ingress processing and archive workflows unless it separately configures the
built-in runtime for those responsibilities.

Configure one facade with `storage.lookup`, optional `storage.publications`,
`storage.delivery`, optional `storage.routing`, and `transport.lookup` /
`transport.delivery` as required by the
[capability matrix](architecture.md#capability-matrix). `tor.onionService` and
`tor.bootstrap` supply local identity and introductions. These transports do not
override the built-in runtime's SOCKS connector.

- `storage.lookup` supplies authoritative/replica records, bounded peer
  persistence, and mandatory `findPinnedValue`/`pinValue` operations. Pins are
  stored separately from replicas. `pinValue` atomically inserts only when absent
  and returns the winning value if concurrent requests race. Encrypt these
  records and indexes at rest. Do not expire, evict, or overwrite verified pins;
  reject new pins when capacity is exhausted. Incoming announcements are
  candidates, not verified routes. Peer maintenance reads may be asynchronous;
  optional `findBootstrapPeers` supplies bounded, dynamically refreshed
  introductions. Verified-peer writes receive the probe's cancellation signal.
- `storage.publications` supplies durable publication intent and repair scheduling.
  It accepts `PublicationStorage` for an exclusively owned queue, or
  `ClaimedPublicationStorage` for distributed workers. The latter nominates due
  hashes, atomically claims each job, and returns its immutable value plus a
  `complete` callback fenced to that exact claim. Claiming checks application
  eligibility and retention. An inactive, missing or already claimed job returns
  `undefined`; index reads alone never grant ownership. Expired or superseded
  claims must reject completion. Cancellation leaves durable intent recoverable.
  The library owns bounded DHT walks, placement and scheduling in both cases.
- `storage.delivery` supplies durable ciphertext queue operations. One facade
  owns each adapter instance. A simple queue requires exclusive ownership of its
  backing queue; a distributed adapter must claim nominated work and keep its
  receipt/lease state isolated per facade. Exact snapshot checks and conditional
  completion must protect cancelled or replaced work. Processing remains
  at-least-once after uncertain outcomes. Enqueue is atomic, capacity-bounded and
  idempotent for the exact ID/hash/envelope/fingerprint tuple. Mutations commit
  before resolving. Providers may retain their documented retry/dead-letter
  policy; `markRetry` includes a bounded reason as well as retry timing hints.
  An application-owned enqueue or operator-only dead-letter inspection must fail
  explicitly if invoked through an unsupported facade operation.
- `storage.routing` is an optional synchronous, bounded cache of isolated routing
  snapshots. It never provides recipient authority.
- `transport.lookup` and `transport.delivery` provide finite Tor I/O, reject
  redirects, and enforce response/custody bounds. They do not implement scheduling.
- `handlers.isAddressActive` supplies application address policy;
  `preparePublications` performs an eligibility sweep before publication.
- `handlers.deliveryStatus` updates application state. It is not a transactional
  event outbox, and shutdown must not be awaited reentrantly inside this handler.

`messages.submit(request, { deliveryId })` persists the exact encoded request
before sending. Its immediate attempt and later retries both resolve the recipient
through verified, durable pins. The request's `onionService` and `deliveryPath`
remain syntax-checked compatibility fields; they do not select or authorize the
destination. Missing authorization or unresolved targets leave the message queued;
pin storage failures reject the submission while retaining its durable intent.
Keep a stable caller delivery ID across uncertain submissions.
Automatic retry scheduling starts with `start`; manual controls include
`messages.processDue`, `wakePending`, and `listUndeliverable`. Host publication
controls include `addresses.publishRecord`, `processPublications` and
`refreshPeers`; `addresses.discoveryStatus()` reports whether discovery has
joined. `resolveTargets(hash, commitment, { signal })` accepts caller cancellation.
These operations require host capabilities, while
`messages.send` and transfer handles require the built-in runtime.

Resolution checks durable verified pins before querying the DHT. The library
verifies the route signature and address commitment before inserting a pin, and
uses only the winner of that insert. An invalid unpinned local record or peer
reply does not stop the bounded walk from considering other peers. Unverified
routes are never pinned or contacted. Pin read/write failures propagate and
prevent sending. A missing value produces
no targets; an incomplete lookup yields an unavailable result. The built-in
runtime stores route and key pins in `lookup-pin` and `key-pin` state collections,
with a capacity of 4,096 each and no automatic eviction. Clearing trust state or
restoring an older backup loses bindings learned since that snapshot. A pin does
not override the receiving host's address expiry, deletion or admission policy.

Delivery uses durable-before-send ordering and best-priority CSPRNG selection.
The reference queue uses 96 counted attempts, bounded 15/30/60-second retry
delays, 1,000 pending entries and 1,256 retained entries. Production queue
providers must document their own bounded retention and retry policy. Lookup-unavailable/no-target rescheduling does not
call the application status handler. Diagnostics contain aggregate results,
not identifying delivery payloads.
