# Proposed Public Interfaces

Status: review draft. The [TypeScript declarations](proposed-api.d.ts) and
[usage examples](api-examples.ts) are design artifacts, not an implemented or
published package. The [implementation comparison](implementation-map.md)
records the source evidence and remaining validation work.

An experimental runtime now exists. Its [current contracts](../../src/contracts.ts)
and [runtime status](../runtime.md) supersede these sketches where they differ.

## Small Consumer Surface

The purpose is to remove federation work from applications. An application
supplies encrypted bytes, storage access and authority. The library handles
discovery, connections, framing, verification, retries and transfer recovery.
An interface earns its place only when the host must provide a behavior or make
an application decision. The caller does not schedule parts, maintain a peer
table, retry transport requests, or implement client sharing workflows for the
library. Content encryption, decryption and private-key ownership stay outside.

A host supplies its storage and Tor connection configuration, then registers the
receivers and authorization objects for the capabilities it serves. Outbound
archive sources can be configured independently of archive receiving.

- `federation.addresses`: local management,
  publication, and lookup.
- Standalone address generation, derivation, and validation utilities.
- `federation.messages.send(destination, source, listener)`.
- `federation.archives.send(destination, source, listener)`, plus archive access
  and version operations.
- Each registered receiver implements asynchronous `receive(stream, metadata)`.
- The returned transfer provides status, waiting, cancellation, resumption, and
  listener attachment. Transfers can also be found by their durable identifier.

These names are proposals. Ordinary values remain plain values. Application
implementations satisfy structural interfaces without extending a base class.
Offline address utilities also work without constructing a federation instance.
Identity-bound keys cannot be replaced through an ordinary record update.
Expired or disabled records do not publish. Public timestamps use Unix epoch
milliseconds; codecs translate existing wire units without changing key ids.

## Runtime And Streams

The proposed stream is `ReadableStream<Uint8Array>`. This gives both directions a
real stream object, cancellation, and backpressure. This is a provisional
choice for the TypeScript contract; it is not a browser-support commitment.
The reference runtimes use Node streams and async iterables, so adapters will
need explicit conversions and tests for cancellation and backpressure.

The caller encrypts content before supplying it. The library owns protocol
framing, validation, integrity checks, and transfer scheduling. For messages,
the stream contains the existing complete encoded envelope. Its sealed header
and encrypted attachment descriptors are also presented as parsed metadata to
the receiver. There is no additional message-body wire field.

A source describes immutable encrypted bytes. Each open returns a new stream;
the requested range must yield exactly that interval of the same bytes. The
source adapter releases its resources when cancelled. The library closes or
cancels every stream it owns. A receiver consumes the stream before resolving;
early resolution is not successful completion.

All lengths and progress count encrypted bytes. Integers must be safe and
nonnegative, and supplied ranges must fit the full object. Empty objects follow
the selected wire protocol's rules; the declaration does not authorize them.
Full-object integrity and partial-range integrity are distinct: a range read
does not establish the full object's digest without additional proof.

## Durable Send And Transfer Results

A successful send submission means durable local intent is recorded. Message
envelopes are bounded and persisted exactly before submission succeeds.
Archives persist the source identifier, immutable descriptor, destination,
preconditions, and operation state; the application retains the actual bytes.
A configured source resolver must reopen them after process restart.
Missing sources pause work rather than silently losing or replacing it.

The listener is supplied in the same call before work can emit events.
Listener exceptions must not change durable transfer state. Notifications are
best effort, may coalesce progress, and are not a persistence mechanism.
A listener attached later gets the current snapshot and can query terminal
results. The transfer identity remains stable across process restarts.

An exact submission retry uses the same operation identifier and immutable
inputs. Reusing it for different bytes or destinations conflicts. A submission
error identifies whether nothing was queued or its outcome is unknown, and
includes the operation identifier for reconciliation. A failed notification
after durable queuing must not be reported as a lost submission.

The message result says **delivered**, meaning the receiving node accepted
custody. There is no
user-delivery, read-receipt, or content-decryption outcome in this API.
An archive upload can return a staged or committed receipt. Both must preserve
the validated receipt fields needed by subsequent operations. A staged mutable
object still needs a separately authorized signed version commit.

Progress reports logical bytes confirmed for the current attempt, not total
network traffic including retries. Counts can reset on a new attempt. The
library must document which partial ranges survive an interruption.
Cancellation is a durable request, not a promise to undo remote acceptance.
An in-flight commit is reconciled before reporting its terminal outcome.
Aborting a wait stops waiting only. Cancelling a transfer is explicit.

A process-local archive read receiver cannot be reconstructed automatically.
After restart, an interrupted read pauses until the caller repeats the read
with the same operation identifier, immutable request, and a receiver. A new
receiver must account for the documented restart range; append-only writes
without offset/identity checks are insufficient.

## Receiving At A Node

The library first obtains durable ingress custody and preserves the protocol's
indistinguishable response behavior. Final receiver processing must not become
a destination-existence oracle.

Both registered receivers expose `receive(stream, metadata): Promise<void>`.
The message handler resolves after its adapter durably stores the message or
hands it to a durable application queue. The archive handler resolves after
staging the supplied byte interval. Neither receiver exposes an inbox or user
delivery workflow. The library coordinates subsequent archive verification and
commit through the archive storage adapter.

Exact repeated delivery must succeed without duplicate effects, using the
stable delivery identity and exact payload. A crash after adapter persistence
but before the library records completion can repeat the call. A transient
exception retains work for a bounded retry; an explicit non-retryable
`ReceiveError` is terminal. A cross-store exactly-once transaction is not assumed.

The node adapter's atomic policy accounting, replay receipt and inbox write are
its implementation of durable custody. The managed adapter's durable queue is
another implementation. The library requires the guarantee; it does not import
either application's processing workflow. Consumable application permissions
are accounted for with that application's durable effects, never by read-only
authorization preflight. Protocol replay rules remain the library's responsibility.

## Storage Contract

The initial proposal groups `AddressStore` and `FederationStateStore` inside one
`FederationStorage` object with conditional atomic batch commits. This is a
proposed adapter requirement, not a capability proven for every backend.

A batch can update an address and its publication intent together. It also
supports conditional claims and completion of queue and transfer state.
Expected revisions prevent stale workers from overwriting newer work. Revisions
must not be reused after deletion and recreation. Duplicate keys in a batch
are invalid. The adapter returns one result for the whole batch.

A commit identifier is stable across retries of one exact batch. Reusing it
with different mutations conflicts. Lost replies are reconciled through exact
retry; success is returned only when the durability requirement is satisfied.
The retention of deduplication records must cover the supported retry window.

Point reads and conditional commits must support authoritative reconciliation.
Paged due-work indexes may nominate candidates; candidates are re-read and
conditionally claimed before work. Pagination is bounded and must advance.
Backend consistency, replication, transactions, and index repair are entirely
adapter responsibilities. There are no region or cloud queue options here.

Application inbox transactions and archive bytes are outside this generic state
batch. An adapter may coordinate co-located records internally; the library
cannot treat independent stores as a transaction. Opaque operational records
may include sensitive protocol material and require appropriate protection,
retention, and restricted diagnostics.

## Archives: Receive, Verify, Commit, Recover

The registered archive receiver writes an interval into staging under a stable
stage identifier. It must preserve metadata and record completed intervals
durably. Exact repeated intervals are idempotent; contradictory metadata or
bytes conflict. Partial writes do not become completed intervals.

The archive store exposes staged reads, inspection, commit, and discard.
The library verifies complete encrypted length and digest before requesting
commit. The store conditionally checks the expected object revision and makes
the object visible atomically. A signed mutable-head update is a separate
conditional operation against the expected predecessor.

Stage inspection distinguishes absent, staged, committing, and committed.
A timeout or unavailable backend is an error, not absence. Unknown completion
retains state and reservations. Cleanup cannot turn an uncertain commit into a
successful cancellation. Discard distinguishes completed cleanup, already
committed data, and pending reconciliation.

Committed archive reads, byte ranges, metadata, listing, and deletion use the
same application store. A collection deletion tombstone is distinct from an
empty list. Local provider locators and credentials stay inside the adapter;
public protocol locators are validated and are not themselves authorization.
An existing archive without a signed head returns null from head lookup; a
missing archive raises a not-found error. Neither is temporary unavailability.

## Authorization And Wire Compatibility

The application resolves trusted authority and applies access policy. The
library performs mandatory protocol verification against that authority,
including signatures, request hashes, target, scope, expiry, and replay.
Peer-submitted keys cannot establish their own authority.

The proof provider receives the exact operation, target, canonical unsigned
request, and request hash. It may fetch already client-signed material.
Multipart initialization, each part, completion, abort, and mutable commits
may need different proofs. The application need not disclose private signing
keys to a server.

The source comparison found fields that a generic boolean authorization hook
would lose: collection and authority references, create intent, grant type,
content hashes and lengths, previous versions, writer and signing-key identity,
and authority/epoch bindings. The draft carries versioned protocol documents
and operation context so those fields are retained.

`ProtocolDocument` is a temporary boundary for existing bounded encodings.
It is not permission to accept arbitrary schemas or rename signed fields.
Before API freeze, replace open format names with a supported, discriminated
codec/type set, including exact create/list/delete grants, multipart proofs,
mutable pointers, and scoped server authorization. Existing wire fields and
signature inputs remain unchanged, even where they retain legacy application
names. Those wire values do not make sharing workflows part of the core.

## Readiness And Remaining Decisions

Creating an instance does not start listeners or Tor. The host provisions Tor;
explicit startup checks storage and the configured identity, recovers durable
work, and reports readiness. Shutdown releases owned resources and leaves
unfinished durable work recoverable.

Effective limits are visible. Defaults, retry/retention budgets, ingress
capacity, and adapter batch sizes still need concrete supported values.
The reference node permits larger envelopes than the managed submission path;
one public limit must not hide that difference.

Before stabilizing the contract, validate two thin host adapters and the failure
scenarios in the implementation comparison. In particular, prove the conditional
storage batch on both backends, settle stream conversion and range recovery,
finish typed wire documents, and define how a host attaches an existing local
listener or uses separated processing workers. These are explicit review items,
not completed interoperability claims.
