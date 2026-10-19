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

## Status And Runtime

The library is experimental and its public API is not stable. It runs on
Node.js 22 or later as an ESM package and uses Web readable streams. Its pinned
runtime dependency supplies ML-DSA-65 route authorization. Applications supply
durable storage and encrypted content; the included memory adapter is for tests
and examples.

The library includes a Tor SOCKS connector and local HTTP listener. Operators
run Tor separately and provision its onion services. The default tests and
offline example need no Tor process, credentials or sibling repositories.
Real-network validation is available through a separate opt-in Tor suite.

Read the [architecture overview](docs/using-library/architecture.md) for component
boundaries and integration choices, and the [runtime contracts](docs/using-library/runtime.md#limits)
for supported limits. Local tests do not establish production readiness.

## Install The Beta

Use Node.js 22 or later and an ESM application. Pin the beta explicitly:

```bash
npm install --save-exact @techsologic/federation-privacy-library@0.1.0-beta.2
```

Prereleases are published under `next`; `latest` is a separate channel. Use the
explicit version above for reproducible application builds. The beta API may
change between releases. The package includes the Node.js type definitions its
public declarations require; TypeScript applications supply their own compiler.

The installed package includes its application guides and examples. Run the
offline walkthrough directly after installation:

```bash
node node_modules/@techsologic/federation-privacy-library/scripts/run-example.mjs
```

This uses a loopback SOCKS driver and memory storage with synthetic messages.
Follow the [application walkthrough](examples/README.md) to supply real Tor
configuration and your application's durable providers.

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

## Addresses Stay With Their Original Node

A Receive Address is fixed to its original node's onion service for security.
The address-owning client authorizes that binding once. The library verifies
and persists the first learned route before using it, and later DHT records
cannot redirect a known address to another node. An unavailable original node
causes delivery to wait or fail under the retry policy; it does not authorize a
replacement route. Moving to a different onion service requires a new address.

The recipient client can remain offline while its node and address remain active.
The node refreshes DHT replicas using the stored authorization. Preserve the onion
identity and encrypted trust state during backup, recovery and hardware changes.
See [fixed node bindings](docs/using-library/architecture.md#fixed-node-addresses).

## One Developer API

Construct one federation object. It owns resolution, protocol clients, discovery,
publication, delivery scheduling, and shutdown. Applications supply providers
and handlers; they do not construct library coordinators or workers.

```ts
import { createFederation } from "@techsologic/federation-privacy-library";

const federation = createFederation({ storage, handlers, tor });
await federation.start();

// encryptedMessage comes from your client's encryption/signing code. The
// receiving app validates that signature after decryption; the library does not.
const source = federation.messages.source(encryptedMessage);
const transfer = await federation.messages.send(destinationIdentity, source, undefined, {
  operationId, // Persist this ID and the exact envelope before submission.
});
const outcome = await transfer.wait({ signal: AbortSignal.timeout(60_000) });
// Handle completed / failed / cancelled. Completion means remote node custody.

// Keep the instance alive for application requests; stop during shutdown.
await federation.stop();
```

`storage`, `handlers`, and `tor` above are application configuration, not implicit
production defaults. `destinationIdentity`, `encryptedMessage`, and `operationId`
come from your application's address and outbox flow. A host queue integration
supplies bounded Tor `transport` providers. These serve host queues; they do not
replace the built-in runtime's SOCKS connector. See the
[capability matrix](docs/using-library/architecture.md#capability-matrix) and
[provider contracts](docs/using-library/runtime.md).

| Entry point  | Purpose                                                                                         |
| ------------ | ----------------------------------------------------------------------------------------------- |
| Package root | `createFederation`, public types, errors, address utilities, and the `protocol` codec namespace |
| `/adapters`  | Reference memory storage and tools for implementing storage providers                           |
| `/testing`   | Synthetic routing and internal compatibility fixtures; never production orchestration           |

Stateful engines are internal. There is one factory and lifecycle regardless of
which storage capabilities a host supplies. The
[public declarations](https://github.com/TechSologic/federation-privacy-library/blob/main/src/index.ts) are authoritative.

Start with the [application walkthrough](examples/README.md). The
[runnable two-node example](examples/two-nodes.mjs) shows registration, verified
recipient lookup, encrypted-envelope submission, receiver storage, and exact
retries using `createFederation` and the exported provider interfaces. Run it
offline with the separate loopback SOCKS driver or supply your real Tor
configuration. The [TypeScript integration example](docs/using-library/api-example.ts)
shows `createFederation` with application providers, transfer recovery, and
archive upload/download calls.

```bash
# From a repository checkout:
npm ci
npm test
npm run example
```

## A Clear Responsibility Boundary

| The library owns                                                                        | The application and its adapters own                                                    |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Address format, key commitments, DHT publication, lookup and delivery-target resolution | Address persistence, lookup/cache providers and their storage guarantees                |
| Federation wire formats, routing, and Tor transport integration                         | Tor process provisioning and the host's local connection configuration                  |
| Required protocol validation, replay handling, and transfer integrity                   | Content encryption, decryption, and application-held private keys                       |
| Transfer scheduling, progress, retries, cancellation, and recovery                      | Durable storage guarantees and access to encrypted data streams                         |
| Protocol authorization checks                                                           | Application access policy and client-authorized proofs                                  |
| Verification and opaque publication of client-authorized address routes                 | Client verification of the proposed node target and route signing with its private key   |
| Receiver/handler invocation and documented failure semantics                            | Receiver implementations, application status side effects and diagnostic/event handlers |

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
privacy. See the [application privacy guidance](docs/using-library/privacy.md).

The federation is intended to keep operating without a central operator.
Joining still requires a reachable peer, and continued communication requires
participating operators and connectivity. Decentralized discovery does not
automatically replicate or recover an application's data.

## Documentation

Application guides and example sources are included in the package. Implementation
and developer documentation links point to the source repository.

- [Architecture](docs/using-library/architecture.md): components, public provider
  interfaces, integration paths and operation flows.
- [Using the library](docs/using-library/README.md): build applications with the
  public API, storage and handler providers, Tor integration and privacy guidance.
- [Developing the library](https://github.com/TechSologic/federation-privacy-library/blob/main/docs/developing-library/README.md): change the
  implementation, understand its design, run checks, contribute and prepare releases.

## Development And Contributions

Start with [development guide](https://github.com/TechSologic/federation-privacy-library/blob/main/docs/developing-library/development.md) and
[CONTRIBUTING.md](https://github.com/TechSologic/federation-privacy-library/blob/main/CONTRIBUTING.md). Build with `npm run build`, check types with
`npm run typecheck`, and run focused suites with `npm run test:unit` or
`npm run test:e2e`.

Contributors retain copyright and grant TechSologic Inc. a permanent,
irrevocable, worldwide, royalty-free, non-exclusive license to use, modify,
distribute, and sublicense their original contributions under the
[Contributor License Agreement](https://github.com/TechSologic/federation-privacy-library/blob/main/CONTRIBUTOR_LICENSE_AGREEMENT.md). The draft
terms require review before first use; opening a pull request is not acceptance.

## License And Stewardship

This project is licensed under [GNU AGPL version 3](LICENSE)
(`AGPL-3.0-only`). See the [licensing notes](https://github.com/TechSologic/federation-privacy-library/blob/main/docs/developing-library/legal/README.md) for the
distinction between the software license, contributor terms, and branding.

TechSologic Inc. stewards the project and controls official releases.
[Governance](https://github.com/TechSologic/federation-privacy-library/blob/main/GOVERNANCE.md), [maintainer responsibilities](https://github.com/TechSologic/federation-privacy-library/blob/main/MAINTAINERS.md), and
[official-release policy](https://github.com/TechSologic/federation-privacy-library/blob/main/TRADEMARKS.md) describe that role. Project stewardship
does not confer control over independently operated federation participants.

## Project Resources

- [Documentation index](docs/README.md)
- [Security reporting](SECURITY.md)
- [Code of conduct](https://github.com/TechSologic/federation-privacy-library/blob/main/CODE_OF_CONDUCT.md)
- [Self-service support and project contact](SUPPORT.md)
- [Changelog](CHANGELOG.md)
- [Maintainer repository setup](https://github.com/TechSologic/federation-privacy-library/blob/main/docs/developing-library/maintainers/repository-setup.md)

Code authored by Michael Stapleton ([mike@techsologic.com](mailto:mike@techsologic.com))
for TechSologic Inc.

Copyright (c) 2026 TechSologic Inc. and contributors. See [source attribution](NOTICE.md)
for required notices and the ownership and terms of adapted material.
