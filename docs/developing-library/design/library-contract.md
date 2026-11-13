# Library Contract

This document defines the library's responsibility boundaries and engineering
requirements. Read the shared [architecture overview](../../using-library/architecture.md)
for components, capability selection, public provider interfaces and operation
flows. The [runtime contracts](../../using-library/runtime.md) define observable
behavior; [public exports](../../../src/index.ts) define the implemented API.

## Scope

The library provides federated addressing, discovery, encrypted messaging and
streaming encrypted archives. It supports independent applications and services
without requiring a proprietary central directory or application data model.

The core owns protocol rules, mandatory verification, address/key commitments,
routing, publication, replay handling, transfer integrity, retries and lifecycle.
Application workflows, content encryption/decryption, client private keys,
authorization policy, storage backends and infrastructure provisioning belong to
applications and their adapters.

## Composition

Applications construct one `Federation` through `createFederation`. Configuration
contains grouped `storage`, `handlers`, `tor`, `transport`, `limits` and
`scheduling` and optional `networking` providers/settings. Internal services are composed by the facade;
applications do not construct coordinators or workers.

Use TypeScript interfaces for replaceable behavior and ordinary values for
identities, keys, metadata and operation results. Keep provider effects behind
explicit contracts. Avoid service locators, plugin registration order and
application-specific database schemas in the core.

The built-in runtime uses atomic address/state/lease/commit storage and its own
Tor connector/listener. Host queue integration uses supplied lookup, publication,
delivery and transport capabilities. The facade validates capability dependencies
before I/O. An absent capability fails explicitly; there is no implicit memory
storage. Both paths may coexist without sharing ownership of durable jobs.

## Addressing And Discovery

Address generation, local registration and network publication are separate
operations. Registration atomically records public address data and publication
intent. Publication is asynchronous and refreshed. Disabling or removing a local
registration does not promise instant deletion from peer caches.

A Receive Address is fixed to its original node's onion service. Initial client
authorization establishes that binding; routine publication reuses it without
client participation. Persist the first verified route before contact and retain
it across restarts without expiry or eviction. A different onion service requires
a new address. DHT changes, delivery failure and expired replica leases never
authorize replacing a known binding.

A destination's public encryption and validation keys must match its address
commitments. Bootstrap peers and routing hints supply introductions, not identity
authority. Lookup distinguishes a completed absence from temporary unavailability.
Keep full private receive addresses outside server-side federation records.

## Messages

Applications supply complete encrypted envelopes through `DataSource` or
`messages.source`. The latter encodes fields and performs no content encryption.
Submission preserves exact encrypted bytes and logical identity for retries.

Transport acknowledgement means endpoint custody. It does not establish inbox
admission, sender authenticity, decryption, user acceptance or future retention.
Ingress persistence precedes acknowledgement. Receiver callbacks run after address
and policy checks; they consume the complete stream and durably store or queue
accepted content before resolving.

Callbacks may repeat with the same `deliveryId` after an uncertain application
write or process failure. Deduplicate application effects atomically with the
write. Independent stores do not create a cross-store transaction.

## Archives

Applications supply immutable encrypted sources that reopen exact bytes and
requested ranges. A source resolver supplies restart access by persisted source ID.
Receivers stage encrypted intervals with backpressure, cancellation and lease
fencing; partial or unverified content must remain invisible to readers.

Storage follows a whole-object model: null revision creates only when absent and
an exact current revision conditionally replaces the complete object. A successful
content commit immediately becomes the one current object; there are no random or
partially visible writes. Preserve recoverable staging when a commit outcome is
unknown, and bound or reclaim any provider-internal superseded versions.

Signed version publication is a separate metadata operation. It verifies the
client-signed successor, authority scope and expected predecessor, then atomically
binds publication to the exact current object snapshot. It does not publish bytes.
Providers return the stored head and current object snapshot in one atomic read;
the library never manufactures replacement client signatures.
Head reads require trusted authority and application-held freshness checkpoints;
downloads require trusted object metadata and verified lengths/digests.

## Authorization And Privacy

Resolve trusted public authority from application records before using submitted
proofs. Required signature, operation, scope, target, expiry, integrity and version
checks remain in the library. Application policy cannot replace mandatory protocol
verification; a valid signature cannot bypass policy or quotas.

Tor operates as a separate process. The library uses its SOCKS proxy and loopback
forwarding; operators provision and maintain Tor and its onion identities. Host
transport providers enforce bounded I/O. Direct Networking is an explicit opt-in
transport optimization for archive bytes within the same onion-identified
federation. The library learns a short-lived HTTPS origin from existing successful
Tor responses from that exact peer, validates HTTPS and public DNS destinations,
and otherwise uses Tor. Lookup, messages and archive controls always use Tor.
Tor-only policy never attempts direct DNS or sockets. Redirects are forbidden.
Client-signed address records and permanent onion bindings remain unchanged.
See [Direct Networking](../../using-library/direct-networking.md) for its public
contract, privacy tradeoff, ingress boundary and verification limits.

Use aggregate diagnostics. Do not add persistent relationship metadata for
observability or log content, private keys, raw addresses, proofs or identifying
traffic. See [security invariants](../security/invariants.md).

## Persistence And Completion

Persist intent before relying on transient scheduling or notifications. Use stable
operation identifiers, conditional state transitions and monotonically increasing
lease fences. Stale or expired ownership must reject mutations atomically.

Transfer listeners and events are best-effort observations. Durable receivers and
status effects are awaited and must document their persistence semantics.
Cancellation cannot undo remote custody or a completed commit. Shutdown stops
admission and scheduling, drains accepted work, then allows providers to close.

Validate adapters for interrupted writes, exact retries, uncertain outcomes, stale
fences, cancellation, retention and restart recovery. Define encrypted-byte length,
digest encoding, range and stream ownership requirements at each boundary. See the
[validation guide](../validation.md) for checks and evidence requirements.
