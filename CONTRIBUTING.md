# Contributing

Federation Privacy Library is stewarded by TechSologic Inc. Contributions are
welcome through this repository's issues and pull requests. The API is experimental; see the
[architecture](docs/using-library/architecture.md) and
[runtime contracts](docs/using-library/runtime.md) for supported behavior and limits.

## Contribution Terms

You retain copyright. New original contributions require a permanent,
irrevocable, worldwide, royalty-free, non-exclusive license to TechSologic Inc.
to use, modify, distribute, and sublicense them.

Submit original work under [AGPL-3.0-only](LICENSE), contribute only material you
own or have permission to license, identify third-party material and its terms,
and preserve required copyright and license notices.

Open your pull request normally. Before your first original contribution can be
merged, a maintainer must provide a permanent link to the reviewed
[Contributor License Agreement](CONTRIBUTOR_LICENSE_AGREEMENT.md) for one-time
acceptance in a PR comment. The current terms are a draft for legal review
before first use. Opening a PR, signing a commit, or checking a template box
does not constitute CLA acceptance.

A recorded acceptance covers the accepting PR and future contributions to this
project under those terms. Acceptance for UnoLock Federated Node does not by
itself cover Federation Privacy Library. Maintainers verify coverage for each
author before merging; contributors should not have to repeat covered acceptance
for every PR. The [recording procedure](docs/developing-library/legal/cla-records.md) describes the
evidence to retain.

No CLA is needed simply to report an issue, discuss an idea, use the software,
or maintain an independent fork.

## Contribution Workflow

1. Read the [library contract](docs/developing-library/design/library-contract.md), the relevant
   documentation, and the [security invariants](docs/developing-library/security/invariants.md).
2. For a substantial interface or protocol proposal, describe the use case,
   responsibility boundary, alternatives, compatibility, and acceptance criteria
   before expanding the implementation.
3. Keep changes focused. Preserve unrelated work and existing attribution.
4. Add validation appropriate to the change. Document the commands actually run,
   their results, and any evidence still missing.
5. Update affected contracts, documentation, and the
   [Unreleased changelog](CHANGELOG.md#unreleased).
6. Open a PR describing the resulting behavior and any remaining limitations.
   Complete the contribution-rights process when a maintainer supplies the
   reviewed agreement link.

All submitted changes, including generated text and code, remain the submitter's
responsibility. Use synthetic data; keep credentials, private keys, access proofs,
raw traffic captures, and identifying runtime data out of public material.

## Review Expectations

- Preserve addressing, key binding, protocol verification, replay protection,
  resource bounds, and the separation between ciphertext transport and application
  content encryption.
- Keep database, replication, and provider behavior behind supplied adapters.
- Define storage guarantees and failure semantics before relying on them.
- Verify both producers and consumers when changing a serialized boundary.
- Distinguish planned features, source inspection, executed tests, and released
  behavior.
- Identify dependency licensing and notice obligations before importing code.

For documentation-only changes, check local links, examples, terminology, and
claims against the repository. For implementation changes, run the checks in
[development guide](docs/developing-library/development.md) and report the results actually observed.

Report suspected vulnerabilities through [SECURITY.md](SECURITY.md).
Participation follows [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). See
[GOVERNANCE.md](GOVERNANCE.md), [MAINTAINERS.md](MAINTAINERS.md), and
[SUPPORT.md](SUPPORT.md) for project responsibilities and reporting routes.
