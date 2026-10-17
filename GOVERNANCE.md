# Project Governance

Federation Privacy Library is a maintainer-led project stewarded by
TechSologic Inc. Its scope is the reusable federation library and supporting
adapters described in the [design baseline](docs/design/library-contract.md).

Software use, modification, and redistribution follow [LICENSE](LICENSE).
Contributions follow [CONTRIBUTING.md](CONTRIBUTING.md).

## Decisions And Review

TechSologic authorizes maintainers to decide what is merged and officially
released. Significant changes to public interfaces, addressing, cryptographic
formats, authorization, persistence, transport, or recovery need a documented
problem, responsibility boundary, alternatives, compatibility assessment, and
verification plan.

Resolve disagreements with evidence and the
[security invariants](docs/security/invariants.md). Changes to those boundaries
need explicit review and a recorded decision. Repository access, sponsorship,
or a passing check does not replace review.

The intended branch policy requires pull requests and approving review for
ordinary changes. Actual GitHub protections must be configured separately;
this file does not establish that they are enabled. See
[repository setup](docs/maintainers/repository-setup.md).

## Responsibilities And Contribution Rights

[Maintainers](MAINTAINERS.md) coordinate technical review, documentation, dependency
review, releases, and private security reports. Repository administrators manage
access and publishing credentials separately.

Contributors retain copyright. New original contributions require explicit
acceptance of the [Contributor License Agreement](CONTRIBUTOR_LICENSE_AGREEMENT.md),
granting TechSologic Inc. the permanent, irrevocable, worldwide, royalty-free,
non-exclusive rights described there. Maintainers verify each author's coverage
before merge and preserve the accepted revision and record. Technical approval
does not waive contribution terms. Third-party material retains its own terms.

Record maintainer appointments and departures without publishing private
credentials or employment documents. Grant access for defined responsibilities
and review it when those responsibilities change.

## Official Releases And Independent Operation

TechSologic controls official project releases while it operates. Authorized
release maintainers act under that authority. [TRADEMARKS.md](TRADEMARKS.md)
covers branding and release provenance.

This authority concerns the official project, not control over independently
operated federation participants. Compatible applications and forks can operate
under the software license and protocol rules. The network still needs
participating operators, reachable peers, connectivity, and maintenance.

## Succession After Permanent Cessation

If TechSologic permanently ceases operating, project stewardship and official
release responsibility are to pass to specifically named successor maintainers
through a documented, authorized handover. No successor is currently designated
for this project; [MAINTAINERS.md](MAINTAINERS.md#designated-successors) records
the status.

Permanent cessation must be established through an authorized company
announcement or a verifiable legal record. An outage, inactivity, or an expired
domain is insufficient.

A handover must record the successors' public identities and acceptance,
appointment authority, security and release responsibilities, and separate
arrangements for trademarks, repository and package access, and signing-key
custody or verified rotation. Keep credentials and private legal records private.

Repository text alone does not transfer copyrights, trademarks, accounts, or
credentials. Acquiring an abandoned name or account does not confer stewardship.
If no authorized successor can be established, official succession remains
unresolved; independent operation and AGPL rights remain available.

## Private Reports And Conflicts

Security reports follow [SECURITY.md](SECURITY.md); conduct reports follow
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). A maintainer directly involved in a
conduct complaint should not decide its outcome.

Propose governance changes through pull requests and record material changes
in [CHANGELOG.md](CHANGELOG.md). Do not describe a pending review, appointment,
or release as complete.
