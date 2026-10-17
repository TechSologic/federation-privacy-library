# npm Releases

The [release workflow](../../.github/workflows/release.yml) is ready for local
review. Adding it does not publish a package or configure remote services.
Automated publishing is disabled by default: the workflow requires the repository
variable `NPM_PUBLISH_ENABLED` to equal `true`. The `0.1.0-alpha.1` manifest has
had its private flag removed for the initial manual publication. Any package
marked `private: true` is still rejected by the release guard. Enable the
repository switch only after completing the remote setup below.

## What Runs

- A pushed `v*` tag validates its exact match with `package.json` and both
  lockfile version records. Release versions use SemVer without build metadata.
- A manual **npm release** run validates the selected branch or tag and creates
  an artifact, but never publishes, even when the repository switch is enabled.
- Validation runs type checks, formatting, release guard tests, unit tests,
  two-instance end-to-end tests, and the runnable example.
- Packing builds the JavaScript and declarations, checks the file allowlist and
  exports, then installs the tarball into a temporary consumer and imports every
  public entry point. Installation is offline and disables lifecycle scripts.
- A separate publishing job downloads that same tarball. It does not rebuild
  the library or run package lifecycle scripts. Only this job gets OIDC access.
- Prerelease versions such as `0.1.0-alpha.1` publish under `next`; versions
  without a prerelease suffix publish under `latest`.

Live Tor and sibling-repository checks remain separate. A passing release run
does not establish production adapter readiness or full protocol parity.

## Validate Locally Without Publishing

```bash
npm ci
npm run release:check
npm run typecheck
npm run format:check
npm test
npm run example
npm run release:pack
```

The tested tarball is `.release/package.tgz`; generated release files are ignored
by Git. The manual workflow retains its tarball artifact for fourteen days.
These commands do not contact the npm publishing endpoint.

## Remote Setup Before Enabling Releases

Complete the [repository setup checklist](repository-setup.md) and verify these
settings separately; none are configured by the files in this checkout:

1. Confirm the authorized npm owner and availability of
   `@techsologic/federation-privacy-library`. For a new package, resolve any
   initial publication needed to access its npm package settings as a separate
   first-release step. The workflow does not create npm accounts or ownership.
2. Create a GitHub environment named `npm`. Restrict release tag creation to
   maintainers using repository rules. Any environment deployment rules must
   allow the intended release tags.
3. Configure the package's npm trusted publisher with organization `TechSologic`,
   repository `federation-privacy-library`, workflow `release.yml`, and environment
   `npm`. Permit direct `npm publish`; stage-only permission is insufficient.
4. Configure the trusted publisher when the first release is ready. npm currently
   expires a new configuration if it is not successfully used within two days.
5. Run the manual workflow and inspect its artifact and check results before
   enabling the repository variable `NPM_PUBLISH_ENABLED=true`.

The publishing job uses a GitHub-hosted runner, Node.js 24, and npm 11. It uses
OIDC rather than an npm secret. npm requires a compatible CLI for trusted
publishing; provenance is automatic for public packages from public repositories
and unavailable from private repositories. The workflow does not change repository
visibility or force provenance for a private checkout. See the
[npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

## Cut A Release

1. Choose a version and update both package manifests, for example with
   `npm version 0.1.0-alpha.1 --no-git-tag-version`. Remove `private: true` or set
   it to `false` only when preparing the first publishable version.
2. Update the changelog and release evidence, run the checks above, and commit
   the reviewed release changes through the repository's contribution process.
3. Enable the repository publishing switch only after npm setup is complete.
4. Push the matching version tag on the reviewed commit, for example
   `v0.1.0-alpha.1`. The workflow reruns validation before publishing.
5. Verify the resulting npm version, distribution tag, and available provenance.
   Record the actual result; a local build is not publication evidence.

If publication fails, inspect the npm result before retrying. An already published
version is not overwritten or silently treated as a successful release. If the
version exists, verify its artifact and channel; use a new version for corrections.
Unset `NPM_PUBLISH_ENABLED` to disable future workflow publishing. The switch does
not cancel a publish already in progress or remove an existing npm release.
