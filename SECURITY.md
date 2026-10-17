# Security Policy

Federation Privacy Library is in initial design and documentation development.
There is no released library version or supported production release yet.
Reports about the proposed security boundaries and future implementation are
welcome; no completed audit or production qualification is asserted.

## Reporting

Do not open a public issue with an unpatched vulnerability or private data.

Use this repository's GitHub private vulnerability reporting when it is
available. That feature must be enabled separately by a repository administrator;
adding this policy does not enable it.

If private reporting is unavailable, contact
[support@unolock.com](mailto:support@unolock.com) with the subject
"Federation Privacy Library security reporting channel" and request an encrypted
reporting method before sending exploit details. Send no sensitive details in
that initial email. The mailbox is a reporting contact, not technical support.

Include the affected revision, runtime and adapter configuration without secrets,
the trust boundary involved, a minimal synthetic reproduction, observed and
expected behavior, and likely impact or preconditions.

Do not include live content, raw receive addresses, private onion identities,
private keys, credentials, authorization proofs, signed URLs, traffic captures,
or complete databases.

## Scope And Review Baseline

Start with the [security invariants](docs/security/invariants.md) and the
[design baseline](docs/design/library-contract.md).

Examples of relevant issues include key substitution, authorization bypass,
replay protection failures, unintended identifying metadata, integrity failures,
unsafe partial-archive visibility, lost durable work, and unbounded resource use.

The ability to send encrypted bytes does not by itself establish application
security or anonymity. Tor is a transport boundary; content encryption and
application authorization remain separate responsibilities.

## Response And Disclosure

TechSologic maintainers coordinate triage, remediation, and disclosure with
reporters. Initial development has no guaranteed response or remediation time.
Keep undisclosed details private while maintainers assess impact and recovery.

A report against a consumer application may also require coordination with that
application's maintainers. Do not assume a library change alone resolves every
affected deployment.

Before a first release, maintainers must define supported versions and document
the validation and release evidence. See the
[repository setup checklist](docs/maintainers/repository-setup.md).
