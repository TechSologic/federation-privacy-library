# Documentation

Federation Privacy Library has an experimental runtime and tests. The original
design documents remain proposals; the API is not stable or published.

## Design And Development

- [Project overview](../README.md)
- [Runtime behavior, evidence, and remaining gaps](runtime.md)
- [Implemented public contracts](../src/contracts.ts)
- [Runnable two-node example](../examples/two-nodes.mjs)
- [Library contract baseline](design/library-contract.md)
- [Proposed public interfaces and semantics](design/proposed-api.md)
- [TypeScript design declarations](design/proposed-api.d.ts)
- [Sender and receiver design examples](design/api-examples.ts)
- [Comparison with node and managed implementations](design/implementation-map.md)
- [Developer guide](../DEVELOPING.md)
- [Contributing](../CONTRIBUTING.md)
- [Changelog](../CHANGELOG.md)

## Security And Project Policies

- [Security invariants](security/invariants.md)
- [Private security reporting](../SECURITY.md)
- [License and contributor rights](legal/README.md)
- [Contributor License Agreement](../CONTRIBUTOR_LICENSE_AGREEMENT.md)
- [CLA acceptance records](legal/cla-records.md)
- [Governance](../GOVERNANCE.md)
- [Maintainer responsibilities](../MAINTAINERS.md)
- [Branding and official releases](../TRADEMARKS.md)
- [Code of conduct](../CODE_OF_CONDUCT.md)
- [Support and project contact](../SUPPORT.md)
- [Repository setup checklist](maintainers/repository-setup.md)
- [npm release workflow and activation](maintainers/releases.md)

The design declarations and sketches are review artifacts. Runtime tests are
independent of sibling repositories and private infrastructure. Optional reference
checks do not yet establish complete legacy server or storage-adapter parity.
