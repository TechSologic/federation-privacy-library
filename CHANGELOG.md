# Changelog

User-visible changes are recorded here. Planned behavior is described in design
documents and is not a claim that the library has been implemented.

## Unreleased

### Changed

- Use Node.js 24-based GitHub Actions and pin CI and release runners to
  Ubuntu 24.04, avoiding deprecated action runtimes and automatic image migration.

### Added

- Initial README and documentation of the library's scope and responsibility
  boundaries.
- TechSologic governance, contributor-license draft, acceptance-record process,
  maintainer responsibilities, and community policies.
- Security reporting guidance, development guidance, and GitHub contribution
  templates.
- Repository formatting and ignore conventions.
- Proposed TypeScript public contracts and type-checkable sender/receiver
  examples, with storage, lifecycle, authorization, and recovery semantics.
- Source comparison against the federated node and managed server, including
  explicit remaining adapter and interoperability validation work.
- Standalone ESM TypeScript package for Node.js 22+, with locked development
  dependencies, declarations, package exports, build scripts, and local CI configuration.
- Experimental address management, bounded DHT publication/lookup, Tor SOCKS
  transport, durable message custody, transfer lifecycle, and archive protocols.
- Streaming archive uploads/reads, multipart progress recovery, signed request
  verification, and conditional signed version commits through supplied adapters.
- Unit and two-instance end-to-end tests, an opt-in real Tor test, reference
  codec checks, and a runnable two-node example.
- Tag-triggered npm release workflow with validation-only runs, explicit publication
  gating, version/channel checks, package installation checks, and OIDC publishing
  of the tested artifact. Publishing remains disabled pending release setup.

The implementation is experimental. No stable API, npm release, or migration of
the existing node/managed applications is introduced. See [runtime status](docs/runtime.md).
