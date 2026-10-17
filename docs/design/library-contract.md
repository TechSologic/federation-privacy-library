# Library Contract Baseline

Status: design baseline for proposed interfaces. This is not a stable API,
wire specification, or implemented feature list.

The [first interface proposal](proposed-api.md) includes declarations, examples,
and a [comparison with the existing implementations](implementation-map.md).
Its unresolved items remain proposals; the baseline below records the scope.

The library is intended for standalone nodes, managed services, and third-party
applications. The existing UnoLock node and managed federation implementations
are references for protocol behavior. Application concepts such as Safes and
Protected Spaces must not become prerequisites for using the core library.

## Three Public Capability Areas

| Area | Intended operations |
| --- | --- |
| Addresses | Generate, validate, hash, register, enumerate, update, disable, remove, publish, refresh, and resolve |
| Messages | Send encrypted content and receive it through a registered application implementation |
| Archives | Create, list, delete, stream uploads and downloads, read ranges, inspect transfers, cancel, resume, retrieve versions, and commit signed successors |

Exact names, signatures, value encodings, and supported protocol versions remain
to be specified. The library implements common protocol behavior; it is not a
proxy that requires a proprietary central service.

## Application-Supplied Objects

Use TypeScript interfaces where replacing behavior is useful. Do not require
inheritance or wrap ordinary addresses, identifiers, and keys in classes without
a concrete benefit.

- An address-store implementation supplies persistent local address records.
  Generation of an address is separate from registration and network publication.
- Federation storage supplies operational state for publication work, queues,
  replay protection, routing, and resumable transfers.
- Outgoing source objects supply metadata and readable streams of already
  encrypted data. The library obtains data when needed; the application decides
  whether it comes from a file, memory, object store, or another source.
- Separately registered message and archive receivers expose asynchronous
  `receive(stream, metadata)` methods. The library passes a readable stream;
  the application's method consumes it and controls storage.
- Archive data access also supplies readable access to previously stored bytes
  when a peer requests a download.
- Authorization objects supply application policy and operation-specific
  client-authorized proofs. They do not replace mandatory protocol validation.
- Each outgoing transfer accepts its destination, source object, and listener in
  one call. The listener observes progress, retries, completion, cancellation,
  and failure.

Filesystem and memory adapters may be optional conveniences later. Their
availability must not be claimed before they exist.

## Responsibility Boundary

The core owns address rules and key commitments, distributed publication and
lookup, routing, wire framing, mandatory verification, replay protection,
transfer integrity, and protocol transfer lifecycle.

Supplied adapters own the implementation of their storage, streams, infrastructure,
and application policy. Define the guarantees the core needs. Database topology,
replication lag, regional coordination, and provider-specific SDK behavior belong
inside the managed adapter, not in the library's public feature set.

Applications own content encryption and decryption, content keys, approvals,
key reconstruction, sharing workflows, and interpretation of encrypted messages
and archives.

Tor runs as a separate process. The current reference implementations accept
incoming connections through a local listener and make outgoing connections
through a local Tor SOCKS proxy. The library must define its connection and
listener integration without importing the node's administrative startup flow
or a managed deployment controller.

## Completion And Failure Semantics To Specify

### Addresses

A durable local registration and successful publication are distinct outcomes.
Removal or disabling stops local use and publication; it does not promise instant
erasure from peer caches. Address-bound keys and route changes must follow the
protocol's identity rules.

Lookup must distinguish no result from temporary inability to complete the lookup.
Routing hints alone cannot replace verification of the key commitments supplied
by the address.

### Messages

The transport acceptance response describes custody at the selected endpoint.
It does not establish recipient authorization, decryption, user acceptance,
or future retention, and must not install keys or grant routing authority.

Current node processing durably stages incoming envelopes before final inbox
admission. The storage contract must define how replay state, policy accounting,
and final acceptance are coordinated. A custom receiver's resolved promise must
have an explicit meaning. Cross-store exactly-once delivery is not assumed.

Preserve exact encrypted envelope bytes and logical identity on retries.
Define duplicate delivery, permanent rejection, transient handler failure,
and receiver idempotency.

### Archives

Receiving bytes, verifying integrity, committing an archive, publishing a signed
version, and cleaning temporary storage are separate stages. Partial or unverified
data must not appear as committed content.

Define staging, finalization, discard, and restart recovery responsibilities.
Signed version updates must preserve client authority and conditional predecessor
checks; the library must not invent replacement client signatures.

Specify length and digest encodings, range semantics, stream ownership,
backpressure, memory limits, cancellation, and cleanup. Progress and limits must
make clear whether they count encrypted bytes.

### Durable Operations And Notifications

The managed implementation persists outbound intent before sending a queue
notification. Notification failure does not erase that intent. Other workers
recover persisted work and use conditional state transitions to prevent late
completion from updating a replaced or cancelled operation.

The public contract must support those guarantees without exposing queue vendor
APIs or requiring every operation to complete in its initiating process.
Transient listener and source objects alone are insufficient for restart recovery.

### Authorization

Incoming decisions describe application access policy and trusted authority.
The library retains required signature, operation, object, scope, expiry,
integrity, and replay checks.

Outgoing multipart and version operations can require distinct proofs.
A proof provider may obtain already client-signed material; it must not require a
server to possess a client's private signing key.

## Questions For The First Interface Proposal

- What is the smallest atomic storage boundary, including coordination with
  address records and application admission?
- How does a receiver indicate staging and durable completion?
- How are outgoing sources recovered and listeners reattached after restart?
- Which metadata fields are required for messages, archive references, authority,
  versions, and attachment routing?
- Which stream type and runtime are supported initially?
- How do operation status, cancellation races, errors, retries, and cleanup surface?
- What is required of an adapter, and what may be an optional capability?

Resolve these through concrete interfaces and usage examples before expanding the
implementation. Keep the sender and receiver experience simple while making the
required guarantees explicit.
