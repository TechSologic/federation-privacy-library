# Developer Guide

This repository contains the experimental Federation Privacy Library, public
TypeScript interfaces, a reference memory adapter, and independent tests.
Use Node.js 22 or later and npm. There are no runtime package dependencies.

## Start Here

1. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the
   [security invariants](docs/security/invariants.md).
2. Review the [design baseline](docs/design/library-contract.md).
3. Inspect current files and working-tree changes before editing.
4. Keep implementation and documentation self-contained in this repository.

The existing node and managed service are references for extraction and
interoperability. A consumer must not need those sibling checkouts, private AWS
services, or production credentials to build this library or run its default
tests.

## Current Documentation Checks

Use Git to inspect changes:

```bash
git diff --check
git status --short
```

Before submission, verify local Markdown links and anchors, relative paths,
GitHub issue and PR templates, and factual claims about project status. Check
new untracked files as well as the tracked diff. Preserve the existing
`LICENSE` text.

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
and checks all package imports. The first alpha manifest is prepared for publication;
automated publishing still requires the explicit repository publishing switch.
See [npm releases](docs/maintainers/releases.md) for tag validation, distribution
channels, and the disabled-by-default publishing workflow. A remote CI or release
run has not been claimed.

## Checking The Design Declarations

With a separately available TypeScript compiler, check the declaration and
example files without emitting JavaScript:

```bash
tsc --strict --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --lib ES2022,DOM docs/design/proposed-api.d.ts docs/design/api-examples.ts
```

TypeScript 5.9.3 is now pinned in this repository. These historical design
examples are separate from the implemented contracts in `src/contracts.ts`.
The runnable example and tests use the actual implementation.

## First Implementation Milestones

1. Propose the public interfaces and supporting value types.
2. Define operation completion, failure, cancellation, and recovery semantics.
3. Establish the TypeScript package, supported runtime, locked dependencies,
   type checking, and isolated tests.
4. Add storage and transport contracts with focused verification of their
   required guarantees.
5. Extract protocol behavior incrementally and test interoperability against
   both existing federation implementations using synthetic data.

The package, first runtime, and isolated tests now exist. Migration, broader
compatibility, and production hardening remain open; [runtime status](docs/runtime.md)
records the current evidence and limitations.

## Optional Reference Checks

`scripts/check-reference.mjs` compares selected encodings and signatures with
the current node and managed source modules. It needs a local reference checkout
and a TypeScript loader; it is deliberately outside normal tests. After building:

```bash
UNOLOCK_NODE_SOURCE=/path/to/unolock-node \
UNOLOCK_MANAGED_SOURCE=/path/to/server \
node --import /path/to/unolock-node/node_modules/tsx/dist/loader.mjs scripts/check-reference.mjs
```

The reference sources are read, not edited. This check is narrower than running
the complete legacy servers against the new library.

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

When code is added, document supported runtimes and test commands together.
Use deterministic fixtures and disposable local state; do not require private
keys or cloud credentials in public CI.

## Dependencies And Releases

Explain each dependency, preserve attribution, and commit manifest and lockfile
changes together. Review license compatibility before importing third-party
code or extracting components with their own notices.

Keep user-visible changes under [Unreleased](CHANGELOG.md#unreleased) until a
release exists. Before publication, complete the
[maintainer setup checklist](docs/maintainers/repository-setup.md). Written
instructions do not configure GitHub settings or publish a package.
