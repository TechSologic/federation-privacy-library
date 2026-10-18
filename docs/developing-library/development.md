# Library Development Guide

This repository contains the experimental Federation Privacy Library, public
TypeScript interfaces, a reference memory adapter, and independent tests.
Use Node.js 22 or later and npm. The runtime uses `@noble/post-quantum` for
ML-DSA-65 route authorization; install the pinned dependency tree with `npm ci`.

## Start Here

Run the commands in this guide from the repository root.

1. Read [CONTRIBUTING.md](../../CONTRIBUTING.md) and the
   [security invariants](security/invariants.md).
2. Review the [library contract](design/library-contract.md).
3. Inspect current files and working-tree changes before editing.
4. Keep implementation and documentation self-contained in this repository.

The library builds and runs its default tests independently. No sibling
repository, private service or production credential is required.

## Checks

Use Git to inspect changes:

```bash
git diff --check
git status --short
```

Before submission, verify local Markdown links and anchors, relative paths,
GitHub issue and PR templates, and factual claims about project status. Check
new untracked files as well as the tracked diff. Preserve
`LICENSE` and required source notices.

```bash
npm ci
npm run typecheck
npm run format:check
npm test
npm run build
npm run example
npm pack --dry-run
```

`npm test` runs unit tests and two-instance end-to-end tests through real local
HTTP sockets. Test routing supplies synthetic onion-to-loopback mappings; it
does not supply a shared DHT or message store. Production construction always
uses Tor's SOCKS proxy and never falls back to direct networking.

For the separate live-network suite, install Tor or supply an executable:

```bash
TOR_BINARY=/path/to/tor npm run test:tor
```

This opt-in test contacts the public Tor network, creates disposable onion
identities, runs two production instances, and removes its temporary state.
It fails clearly if Tor is unavailable; it is not silently skipped. Network
bootstrap can take several minutes. Default CI does not run it.

`npm pack --dry-run` checks the planned package contents without publishing.
`npm run release:pack` also installs the actual tarball into a temporary consumer
and checks all package imports. Packing is separate from publication. Automated publishing requires the
explicit repository publishing switch and the configured release conditions.
See [npm releases](maintainers/releases.md) for tag validation, distribution
channels and publishing configuration.

## Checking The Public API Example

Build the package, then check the application example against its public
declarations without emitting JavaScript:

```bash
npm run build
npm run example:check
```

TypeScript 5.9.3 is pinned in this repository. This checks the runnable JavaScript
example and its handlers as well as the TypeScript integration example against
the built package entry point. Configuration is defined in `src/api.ts`; stateful
engines remain internal. The [application walkthrough](../../examples/README.md)
explains the runnable example and production provider boundary. The two-node
application uses `createFederation` and the normal SOCKS connector. The separate
offline driver supplies a bounded loopback-only proxy; it does not substitute
construction or runtime behavior. The same application accepts real Tor
configuration. `TestNetwork` remains confined to internal test/reference fixtures.

`test/unit/facade.test.ts` checks provider composition, explicit submission
outcomes, shutdown ordering and bounded observers. Protocol, storage, delivery
and archive suites exercise their own boundaries. Consumer integration tests
remain the application's responsibility.

## Implementation And Validation

The [implementation map](design/implementation-map.md) identifies the source
modules and integration boundary. The [validation guide](validation.md) explains
which checks to run and what they establish. Supported behavior and
limits are documented in the
[application runtime guide](../using-library/runtime.md).

## Optional Reference Checks

`scripts/check-reference.mjs` compares selected encodings and signatures with
the node and managed protocol reference sources. It needs a local reference checkout
and a TypeScript loader; it is deliberately outside normal tests. After building:

```bash
UNOLOCK_NODE_SOURCE=/path/to/unolock-node \
UNOLOCK_MANAGED_SOURCE=/path/to/server \
node --import /path/to/unolock-node/node_modules/tsx/dist/loader.mjs scripts/check-reference.mjs
```

The reference sources are read, not edited. Codec/signature comparison is
narrower than end-to-end interoperability with a running application.

## Engineering Expectations

Use interfaces where applications need interchangeable behavior. Keep ordinary
values simple. Keep content encryption and application workflows outside the
library, and keep provider and replication behavior behind supplied objects.

Treat peers, routing hints, and incoming data as untrusted. Bound memory,
concurrency, stored state, retries, and retained metadata. Test interrupted
operations and exact retries when adding persistence or transfers.

Do not copy a node's entire application database model or cloud service API into
the public contract. Identify the smallest observable guarantee the library
needs, and define how an adapter reports success, conflict, absence, or failure.

When behavior changes, update the supported runtimes, provider contracts and
test commands together.
Use deterministic fixtures and disposable local state; do not require private
keys or cloud credentials in public CI.

## Dependencies And Releases

Explain each dependency, preserve attribution, and commit manifest and lockfile
changes together. Review license compatibility before importing third-party
code or extracting components with their own notices.

Keep user-visible changes under [Unreleased](../../CHANGELOG.md#unreleased) until a
release exists. Before publication, complete the
[maintainer setup checklist](maintainers/repository-setup.md). Written
instructions do not configure GitHub settings or publish a package.

Local review consumers can pin a packed artifact by integrity. Refreshing this
checkout, or rebuilding its `dist/`, does not change an already installed
consumer. Repacking produces a new artifact; a consuming repository must
explicitly replace its vendored file, reinstall it and update lock integrity.
Documentation-only edits do not require repacking a previously tested artifact.
See [package artifacts](maintainers/releases.md#package-artifacts).
