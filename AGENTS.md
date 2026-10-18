# Instructions For Coding Agents

## Scope And Ownership

This repository owns Federation Privacy Library, its adapters, examples and
documentation. Michael Stapleton <mike@techsologic.com> is the code author for
TechSologic Inc. Preserve the company copyright and all required license,
source-attribution and third-party notices. Attribution is not a maintainer
appointment or evidence of completed legal review.

Work independently of sibling repositories. Inspect reference implementations
when needed, but do not modify the node, managed service or other projects as a
side effect. Default builds, tests and examples must work without those checkouts,
private services or production credentials.

## Before Editing

Read [CONTRIBUTING.md](CONTRIBUTING.md), the
[architecture](docs/using-library/architecture.md),
[library contract](docs/developing-library/design/library-contract.md),
[development guide](docs/developing-library/development.md), and
[security invariants](docs/developing-library/security/invariants.md).
Inspect working-tree changes and preserve unrelated work.

## Public API And Examples

- Applications construct `createFederation` from the package root. The facade owns
  internal service construction, worker scheduling and lifecycle.
- Use the exported configuration, storage, source, receiver, authorization, proof
  and transport interfaces. Check signatures against `src/index.ts` and `src/api.ts`.
- Application examples must call the public factory. Do not substitute
  `TestNetwork.create`, import `/testing`, instantiate internal engines, or import
  from source/dist paths. Test-only network drivers belong outside the example.
- Distinguish built-in runtime capabilities from host queue capabilities. Supplied
  host transports do not override the built-in runtime's SOCKS connector. Never
  attach both paths to the same durable jobs.
- Keep the runnable example and integration snippets checked by `npm run example:check`.
  `npm run example` also validates the public construction path through a separate
  loopback SOCKS driver. It does not establish real Tor connectivity.

## Responsibility And Security Boundaries

The library owns addressing, discovery, federation protocols, mandatory
verification and transfer lifecycle. Applications supply encrypted content,
persistence, data-access objects, access policy and client-authorized proofs.
Adapters encapsulate databases, replication and infrastructure guarantees.

Keep application workflows and content encryption/decryption outside the core.
Never require client private keys. Tor runs separately; operators provision its
process and onion services. Preserve bounded I/O, cancellation, streaming,
backpressure, exact retries, conditional writes and lease fencing.

Transport custody is separate from inbox admission, receiver completion,
decryption and read receipts. Receiver callbacks must consume their streams,
complete documented durable effects and deduplicate repeated delivery identities.
Diagnostic events are bounded observations, not durable application effects.

Use synthetic data. Never commit private keys, credentials, authorization proofs,
raw receive addresses, identifying runtime data or traffic captures. Do not add
persistent relationship metadata solely for diagnostics.

## Fault Diagnosis

Treat debugging as fault diagnosis. State hypotheses and use source inspection,
logging, tracing or minimal reproductions to confirm or reject them. Do not change
runtime code on speculation. Cover every relevant boundary in the failing path;
component tests alone do not establish end-to-end causality.

Once a cause is established, make the smallest necessary change, verify it and
remove temporary diagnostics. Before deployment, reproduce the original failure
and verify the fix with the applicable artifacts, runtime configuration,
serialization boundaries and communicating systems. Review the final changes.

## Documentation

Keep documentation as a coherent description of the implemented library. The
changelog starts with one initial snapshot; do not reintroduce internal development
milestones, extraction/migration stories, alpha-to-alpha narratives or obsolete
proposals. Retain useful requirements as current contracts and limitations.
Required source provenance in `NOTICE.md` is not disposable development history.

- Shared architecture and application contracts: `docs/using-library/`.
- Implementation design, security, validation, contribution and releases:
  `docs/developing-library/`.
- Link both documentation streams to the architecture overview. Document component
  relationships, capability requirements, provider responsibilities and operation
  flows without duplicating detailed contracts.
- Keep examples, links, anchors and status claims consistent with source and package
  declarations. If a shipped document is added, update the package allowlist in
  `scripts/pack-release.mjs` and verify the artifact.
- A documentation cleanup does not imply rewriting Git history, changing package
  versions, publishing, or deployment.

## Validation And Reporting

Use checks proportional to the change. For documentation, check links, anchors,
terminology, examples and status claims. For code, run relevant tests and required
checks. Use the [validation guide](docs/developing-library/validation.md).

Report only checks actually executed. Distinguish source inspection, local tests,
package contents, remote CI, publication and deployment. Do not claim stable APIs,
production adapter guarantees, complete interoperability, legal review, CLA
acceptance, remote configuration or release completion without evidence.
