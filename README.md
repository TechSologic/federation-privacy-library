# Federation Privacy Library

**Private communication. Independent nodes. A shared federation.**

Give your apps private, federated communication. Federation Privacy Library is
a TypeScript library project for decentralized address discovery, messaging,
and resumable encrypted archive transfers over Tor, with pluggable storage and
authorization.

The goal is to let independently operated applications communicate through the
same federation without depending on one company to run a central directory or
carry every transfer. Applications keep control of their data, infrastructure,
and access rules. UnoLock is one intended consumer; the library is designed for
other applications and services as well.

## Project Status

An experimental implementation and runnable two-instance tests are available.
Node.js 22 or later is required. The package has no runtime dependencies; its
development dependencies are locked. It is not published to npm, and its public
API is not stable. Publication is disabled in the package manifest.

The normal tests run independently of the UnoLock checkouts, Tor, AWS, and
private credentials. A separate opt-in test runs two production instances over
real Tor onion services. Selected codecs have also been checked against the
existing node and managed implementations. Full application migration and
production readiness remain separate work; see [runtime status and limits](docs/runtime.md).

## Library Surface

- **Addresses and discovery.** Generate and validate protocol addresses, manage
  local registrations, publish and refresh records, and resolve destinations
  through the distributed hash table.
- **Encrypted messaging.** Send application-encrypted messages and deliver
  incoming content to a registered asynchronous receiver.
- **Streaming archives.** Transfer large encrypted archives with backpressure,
  integrity verification, retries, cancellation, and recovery. Support archive
  access and signed version commits where the protocol requires them.
- **One protocol across different hosts.** Use the same federation behavior in
  a standalone node, managed service, or third-party application, with
  application-supplied storage, data-access, and authorization implementations.

The experimental public surface has three areas: addresses, messages, and archives.
See the [design baseline](docs/design/library-contract.md) for the decisions and
questions behind the [proposed interfaces](docs/design/proposed-api.md).
The [TypeScript declarations](docs/design/proposed-api.d.ts),
[usage sketches](docs/design/api-examples.ts), and
[source comparison](docs/design/implementation-map.md) are available for review.
The design sketches preserve the earlier proposal. The current executable
contracts are in [src/contracts.ts](src/contracts.ts); the
[two-node example](examples/two-nodes.mjs) uses the implementation.

```bash
npm ci
npm test
npm run example
```

## A Clear Responsibility Boundary

| The library owns | The application and its adapters own |
| --- | --- |
| Address format, key commitments, DHT publication and lookup | Address persistence through the supplied store |
| Federation wire formats, routing, and Tor transport integration | Tor process provisioning and the host's local connection configuration |
| Required protocol validation, replay handling, and transfer integrity | Content encryption, decryption, and application-held private keys |
| Transfer scheduling, progress, retries, cancellation, and recovery | Durable storage guarantees and access to encrypted data streams |
| Protocol authorization checks | Application access policy and client-authorized proofs |

Storage adapters encapsulate their backend behavior, including database
transactions, replication, and infrastructure. The library relies on explicit
storage guarantees without incorporating a cloud provider's deployment model.
Application workflows such as sharing approvals and Protected Spaces stay in
the application; the federation transports their encrypted data.

## Privacy And Independent Operation

Federation traffic uses Tor onion services. Tor provides network-layer privacy;
it does not replace content encryption, recipient-key verification, or access
control. Applications supply already-encrypted content, and peers remain
untrusted. Traffic timing, sizes, and application behavior still matter to
privacy. See the [security boundaries](docs/security/invariants.md).

The federation is intended to keep operating without a central operator.
Joining still requires a reachable peer, and continued communication requires
participating operators and connectivity. Decentralized discovery does not
automatically replicate or recover an application's data.

## Development And Contributions

Start with [DEVELOPING.md](DEVELOPING.md) and
[CONTRIBUTING.md](CONTRIBUTING.md). Build with `npm run build`, check types with
`npm run typecheck`, and run focused suites with `npm run test:unit` or
`npm run test:e2e`.

Contributors retain copyright and grant TechSologic Inc. a permanent,
irrevocable, worldwide, royalty-free, non-exclusive license to use, modify,
distribute, and sublicense their original contributions under the
[Contributor License Agreement](CONTRIBUTOR_LICENSE_AGREEMENT.md). The draft
terms require review before first use; opening a pull request is not acceptance.

## License And Stewardship

This project is licensed under [GNU AGPL version 3](LICENSE)
(`AGPL-3.0-only`). See the [licensing notes](docs/legal/README.md) for the
distinction between the software license, contributor terms, and branding.

TechSologic Inc. stewards the project and controls official releases.
[Governance](GOVERNANCE.md), [maintainer responsibilities](MAINTAINERS.md), and
[official-release policy](TRADEMARKS.md) describe that role. Project stewardship
does not confer control over independently operated federation participants.

## Project Resources

- [Documentation index](docs/README.md)
- [Security reporting](SECURITY.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Self-service support and project contact](SUPPORT.md)
- [Changelog](CHANGELOG.md)
- [Maintainer repository setup](docs/maintainers/repository-setup.md)

Copyright (c) 2026 TechSologic Inc. and contributors. See individual notices for
the ownership and terms of any third-party material.
