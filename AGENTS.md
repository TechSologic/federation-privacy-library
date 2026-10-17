# Instructions For Coding Agents

## Scope

This repository owns Federation Privacy Library and its supporting adapters.
The checkout contains an experimental implementation, tests, documentation, and
earlier interface design examples. Do not claim stable APIs, full legacy server
parity, remote CI results, or completed release evidence without verification.

Do not modify the node, managed service, or other sibling repositories as a side
effect. Reference implementations are inspection material; this project must
build and test independently when implementation is added.

## Before Editing

Read [CONTRIBUTING.md](CONTRIBUTING.md), [DEVELOPING.md](DEVELOPING.md), the
[design baseline](docs/design/library-contract.md), and the
[security invariants](docs/security/invariants.md). Inspect working-tree changes
and preserve unrelated work.

## Responsibility Boundaries

- The library owns addressing, discovery, federation protocols, mandatory
  verification, and transfer lifecycle.
- Applications supply encrypted content, data-access objects, persistence,
  access policy, and authorization proofs.
- Adapters encapsulate database, provider, replication, and infrastructure
  behavior. Specify guarantees without exposing a cloud deployment model.
- Keep application workflows and content decryption outside the core.
- Preserve required copyright, license, and third-party notices.

## Validation And Reporting

Use checks proportional to the change. For documentation, check local links,
paths, terminology, templates, and status claims; an application build is
unnecessary when no implementation exists. For code, add relevant tests and
document how to run them.

Distinguish source review, executed tests, published artifacts, and deployed
behavior. Never claim a remote setting, legal review, CLA acceptance, or release
has been completed without evidence.

Use synthetic data. Never commit private keys, credentials, authorization proofs,
raw addresses, identifying runtime data, or traffic captures.
