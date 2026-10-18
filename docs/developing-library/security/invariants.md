# Security Invariants

These are implementation requirements and review boundaries for the library. Their presence in documentation is not evidence that code, tests, or
independent security review already establish them.

## Content And Application Authority

1. The library accepts already-encrypted application content. It does not require
   plaintext, content-encryption keys, or client private signing keys.
2. Application sharing workflows, approval thresholds, and key reconstruction
   remain outside the federation core.
3. Services and peers do not gain content authority merely by carrying bytes,
   owning an onion endpoint, or returning a transport acceptance response.
4. Cryptographic randomness uses a CSPRNG and fails closed when unavailable.

## Addressing And Transport

5. Address generation, parsing, hashing, and key-commitment verification follow
   the shared protocol. A lookup result is untrusted until applicable commitments
   and protocol checks pass.
6. DHT bootstrap peers are introductions, not identity authorities. An incomplete
   lookup is not evidence that an address does not exist.
7. Production federation traffic uses the required Tor transport and permitted
   protocol endpoints. Do not silently fall back to clearnet transport or follow
   arbitrary redirects.
8. Tor endpoint authentication does not replace content encryption, recipient
   verification, or authorization.
9. Keep raw receive addresses and client identity material outside server records
   where the protocol requires derived hashes or public commitments.

## Authorization

10. Validate signed requests against trusted authority and the exact operation,
    target, request contents, expiry, and version context required by the protocol.
11. A valid signature does not bypass scope, access policy, quotas, resource
    isolation, concurrency, or integrity checks.
12. Untrusted routing, provider locators, and peer-supplied keys cannot install
    new authority or override pinned expectations.
    Receive Addresses remain fixed to their original node's onion service for
    security. Moving to another service requires a new address; a DHT update,
    failed delivery or expired replica cannot authorize moving an existing one.
    Persist the first verified route before use and retain verified bindings
    across restarts without automatic expiry or eviction. Keep unverified
    replicas separate. At capacity or on storage failure, fail closed.
13. Preserve client-signed bytes and semantics. A library or server must not
    manufacture replacement client authority to make an operation succeed.

## Messaging And Persistence

14. Preserve exact logical delivery identity and encrypted envelope bytes across
    retries. Replay protection is scoped according to the protocol and survives
    the required retention and recovery period.
15. Do not confirm durable ingress before the configured persistence guarantee
    is satisfied. Transport custody and final application delivery are distinct.
16. Coordinate replay records, policy accounting, and admission according to an
    explicit atomic or recoverable contract; do not assume independent writes
    form a transaction.
17. Required indistinguishable ingress responses must not reveal destination
    ownership or liveness through recipient-specific rejection.
18. Persist durable intent before relying on transient queue notifications.
    Conditional completion must reject stale, replaced, or cancelled work.
19. Adapter guarantees must be explicit. Storage failures and conflicts must
    not be silently treated as successful writes or definitive absence. Every
    mutation must be rejected after its monotonically increasing runtime fence
    expires or is superseded.
20. Production adapters encrypt all federation records, blobs, identifying
    indexes, journals, temporary files, replicas and backups at rest. Storage
    keys remain separate from stored data, are separated by purpose and can be
    rotated. Content encryption does not satisfy metadata encryption.

## Archives And Streams

21. Keep memory, input sizes, concurrency, stored state, retries, and retention
    bounded. Backpressure must propagate across stream and transport boundaries.
    Timed-out adapter work remains admission-counted until it actually settles.
22. Verify encrypted length, digest, ranges, and applicable signed metadata.
    Do not expose partial or unverified data as a committed archive.
23. Mutable versions use verified client-signed state and conditional predecessor
    checks. Head reads reject state older than the caller's trusted sequence/hash
    checkpoint. Conflicts must not silently overwrite an accepted version.
24. Staging, commit, discard, cleanup, and recovery must be idempotent where
    retries are allowed. Preserve recoverable state when commit outcome is unknown.
25. Closing, cancellation, or source failure must release resources according
    to the documented lifecycle without corrupting accepted durable state.
    Adapters must not perform a late durable mutation after their signal aborts.

## Privacy And Evidence

26. Logs and public fixtures exclude plaintext, private keys, credentials, raw
    addresses, raw onion routes, access proofs, signed URLs, and identifying
    runtime captures. Prefer bounded aggregate diagnostics.
27. Provider and replication mechanics remain inside adapters. Do not add
    persistent relationship metadata to work around an unrelated infrastructure
    problem.
28. Default builds and tests must be independent of private services, production
    data, and private credentials.
29. Security and compatibility claims require appropriate source and execution
    evidence. Source review, unit tests, interoperability tests, published
    artifacts, and deployed behavior are distinct evidence.

A proposed change to these requirements needs an explicit design and security
review recorded with its compatibility and verification consequences.
Report suspected violations privately through [SECURITY.md](../../../SECURITY.md).
