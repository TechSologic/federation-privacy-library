# Developing The Library

For contributors and maintainers changing the library's implementation, contracts,
tests or releases. For application integration, start with
[Using the library](../using-library/README.md).

## Development And Design

1. [Architecture](../using-library/architecture.md): shared component overview,
   capability selection, provider interfaces and operation flows.
2. [Development guide](development.md): setup, checks and engineering expectations.
3. [Library contract](design/library-contract.md): architecture, design
   patterns and responsibility boundaries.
4. [Implementation map](design/implementation-map.md): source modules and internal composition.
5. [Security invariants](security/invariants.md): implementation and review requirements.
6. [Validation guide](validation.md): checks to run and what they establish.

The [public API](../using-library/api.md) and
[provider contracts](../using-library/runtime.md) are shared with application
developers. Update those contracts when observable behavior changes.

## Contributing And Maintaining

- [Contribution workflow](../../CONTRIBUTING.md), [contributor rights](legal/README.md)
  and [CLA acceptance records](legal/cla-records.md).
- [Repository setup](maintainers/repository-setup.md) and
  [release workflow](maintainers/releases.md).
- [Changelog](../../CHANGELOG.md), [governance](../../GOVERNANCE.md),
  [maintainers](../../MAINTAINERS.md) and [trademarks](../../TRADEMARKS.md).
- [Security reporting](../../SECURITY.md), [code of conduct](../../CODE_OF_CONDUCT.md)
  and [support policy](../../SUPPORT.md).

Source checks, package publication and deployed behavior are separate evidence.
Return to the [documentation index](../README.md).
