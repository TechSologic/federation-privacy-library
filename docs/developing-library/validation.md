# Validation Guide

Run checks against the source and package artifact being reviewed. Passing source
tests does not establish consumer installation, live Tor interoperability or deployment.
Run commands from the repository root.

## Library Checks

```bash
npm run typecheck
npm run format:check
npm test
npm run example
npm run release:pack
```

`npm test` runs release guard checks, unit tests and two-instance tests over local
HTTP sockets. The suites cover protocol bytes, addressing, lookup, custody,
submission idempotency, retries, shutdown, fenced storage, archive integrity,
proofs and signed versions. Synthetic routing does not establish Tor behavior.

`release:pack` builds and installs the packed artifact into a clean offline consumer,
checks its file allowlist and documentation links, verifies public export
boundaries, compiles an isolated TypeScript consumer and the shipped examples,
and runs the installed offline example. It does not publish.

Check documentation links, current behavior claims and the usage example:

```bash
npm run build
npm run example:check
```

## Transport And Host Validation

`npm run example` executes the consumer example through the public factory and
normal SOCKS connector with a separate loopback-only proxy. It checks exact
received bytes, stable transfer identity on retry, and actual SOCKS routing.
This offline check does not establish real Tor connectivity.

Use `npm run test:tor` for the opt-in live Tor suite. Reference codec checks and
consumer integration require separately configured environments; see the
[development guide](development.md#optional-reference-checks).

For a consumer, verify the packed file's integrity and installed contents, then
run that application's relevant tests and builds. Preserve exact wire bytes,
queue identity, persistence guarantees and shutdown ordering across the boundary.
Production storage validation must cover interrupted writes, duplicate callbacks,
uncertain commits, stale fences, cancellation and restart recovery.

Record commands, results, artifact identity and unresolved limits in the change
or release under review. Do not infer deployment from a passing local build.
