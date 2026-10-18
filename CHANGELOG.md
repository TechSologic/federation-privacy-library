# Changelog

## Unreleased

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
for supported behavior and limits. This snapshot does not designate a published
release or production qualification.
