# Changelog

## 0.1.0-beta.4

- Keep DHT discovery, address/key lookup, messages and archive controls on Tor;
  remove capability probes and HTTPS bootstrap introductions.
- Learn archive HTTPS endpoints from existing successful Tor responses; keep
  clients, signed addresses and saved archive metadata unchanged.
- Restrict HTTPS to archive bytes, with guarded DNS/TLS, Tor fallback before
  writes, cancellation and existing proof checks. Cold peers use Tor without probes.

## 0.1.0-beta.3

- Add opt-in Direct Networking through the public factory: onion-authenticated
  HTTPS capabilities, domain bootstrap verification, bounded public-DNS/TLS
  connection selection, Tor fallback before application writes, and immediate
  policy withdrawal. Tor identity, address pins and shared discovery remain
  mandatory and unchanged. Host integrations must connect their I/O and ingress
  to the public networking service.
- Reserve Tor capacity inside the existing inbound concurrency and rate limits
  so unauthenticated Direct ingress cannot consume the whole shared budget.
- Authenticate unpinned local and remote DHT route candidates before accepting
  them as lookup results, allowing discovery to continue past invalid replicas.
- Pin CI third-party actions to the reviewed commits already used by release
  validation.
- Align archives with their S3-style storage contract: complete objects are
  atomically created or replaced under an exact revision condition, while signed
  heads are separate metadata. Remove temporary content-marker authorization and
  atomically bind head commits to the exact current object snapshot.
- Remove the unused `mutable`, `STAGED`, and caller-supplied `newEtag` archive
  branches. Upload results now return the store's committed revision.
- Support multipart whole-object replacement under the same exact revision
  condition as single-request replacement; parts remain invisible until completion.

### 0.1.0-beta.2

- Allow slow onion connection establishment to use the existing request deadline
  instead of an internal 15-second cutoff; public interfaces and configured
  request deadlines are unchanged.
- Retry temporary SOCKS connection failures at most three times before sending
  application data. Invalid targets, descriptors, client authorization failures
  and malformed replies stop immediately; HTTP requests are not replayed.
- Cancel connection preparation and retry delays during transport shutdown or
  caller cancellation.

## 0.1.0-beta.1

### Initial Snapshot

Package version: `0.1.0-beta.1`.

- Federation discovery, address registration and public-key commitment checks.
- One `createFederation` API with application-supplied storage, handlers and
  Tor configuration or host transport providers.
- Encrypted message transport with custody acknowledgements, exact retries,
  receiver callbacks and transfer status. Applications sign messages before
  encryption and validate them after decryption; the library treats them as opaque.
- Client-authorized ML-DSA-65 address routes, sealed before DHT replication and
  reopened and verified against the destination address commitment before use.
- Standing host bindings for offline clients and mandatory persistent pinning
  of verified lookup routes; the built-in runtime also pins verified address keys.
- Streaming encrypted archives, multipart transfers, integrity verification,
  client-authorized operations and conditional signed version commits.
- Storage contracts covering encryption at rest, atomicity, idempotency, leases,
  fenced distributed publication claims, asynchronous peer persistence and recovery.
- Public TypeScript interfaces, reference memory storage, application examples,
  architecture and integration guides, tests and package validation tooling.

The API is experimental. See the [runtime contracts](docs/using-library/runtime.md)
for supported behavior and limits. Package publication does not establish
production qualification, application integration or deployment.
