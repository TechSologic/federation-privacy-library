# npm Releases

Official packages are published from the [release workflow](../../../.github/workflows/release.yml).
Publication requires an authorized tag push, matching package metadata, completed
validation, configured npm trusted publishing, and the repository variable
`NPM_PUBLISH_ENABLED=true`. The workflow files do not configure remote accounts
or repository settings.

## Workflow

- A pushed `v*` tag must exactly match `v` followed by the version in
  `package.json` and both lockfile version records. Versions use SemVer without
  build metadata.
- A manual **npm release** run validates its selected branch/tag and creates an
  artifact; manual runs do not publish.
- Validation runs type checks, formatting, release guard tests, unit tests,
  two-instance end-to-end tests and the application example.
- Packing builds JavaScript/declarations, checks the package file allowlist and
  exports, then installs the tarball into a temporary offline consumer with
  lifecycle scripts disabled, imports every public entry point, compiles an
  isolated TypeScript consumer and the shipped examples, checks local package
  documentation links, and runs the packaged offline example.
- The publishing job downloads that same tarball and uses OIDC. It does not rebuild
  the library or run package lifecycle scripts.
- Prerelease versions publish under `next`; versions without a prerelease suffix
  publish under `latest`. A package marked `private: true` cannot be published.

Live Tor, production adapters and consumer interoperability require their own
validation. Library checks do not establish those guarantees.

## Local Validation

```bash
npm ci
npm run release:check
npm run typecheck
npm run format:check
npm test
npm run example
npm run release:pack
```

These commands build and inspect a local package without publishing it. The
validated artifact is `.release/package.tgz`; generated files are ignored by Git.
The manual workflow retains its package artifact for fourteen days.

## Package Artifacts

Identify a review package by its source revision, tarball hash and lockfile
integrity. A version string alone does not distinguish local builds. Never
replace the bytes of a published npm version.

Editing source or documentation does not update installed consumers. Repack and
reinstall explicitly when validating an updated artifact. Package publication,
consumer packaging and service deployment are separate operations.

The package contains built code/declarations, license/source notices, application
guides, support/security policies, the changelog, runnable examples and their
offline driver. Implementation source and developer procedures are linked to
the repository. `scripts/pack-release.mjs`
enforces the file allowlist and required public exports.

## Publishing Configuration

Complete the [repository setup checklist](repository-setup.md), then verify:

1. The authorized npm owner and selected package name
   `@techsologic/federation-privacy-library`. Establish package ownership through
   an authorized account if needed.
2. A GitHub environment named `npm`, protected release tag creation, and any
   environment rules required for the intended tags.
3. The package's trusted publisher for organization `TechSologic`, repository
   `federation-privacy-library`, workflow `release.yml`, and environment `npm`,
   with permission to publish.
4. The manual workflow's artifact, metadata and validation results.
5. The repository publishing variable, enabled only when the preceding settings
   and release review are complete.

The publishing job uses a GitHub-hosted Node.js 24 runner and installs npm 11.
Follow the [npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/)
for account requirements, supported configurations and provenance behavior.

## Release Procedure

1. Select an unpublished version and synchronize `package.json` with the lockfile.
   Use `npm version` with `--no-git-tag-version` when changing the version.
2. Update the changelog with the release version and reviewed contents. Record
   validation and artifact identity, and commit through the contribution process.
3. Confirm publishing configuration and authorization.
4. Push the matching version tag on the reviewed commit. The workflow validates
   that artifact before publishing.
5. Verify the npm version, distribution tag and available provenance. Record the
   actual publication result.

On failure, inspect the publishing result before retrying. If the version exists,
verify its artifact and channel; corrections require a new version. Disabling
`NPM_PUBLISH_ENABLED` prevents future workflow publishing, but does not cancel
an active publication or remove a package.
