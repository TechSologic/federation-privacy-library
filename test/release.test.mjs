import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseMetadata } from "../scripts/check-release.mjs";

function fixture(version = "0.1.0-alpha.1") {
  const manifest = {
    name: "@techsologic/federation-privacy-library",
    version,
    private: true,
    repository: { url: "git+https://github.com/TechSologic/federation-privacy-library.git" },
  };
  const record = { name: manifest.name, version };
  return {
    manifest,
    lock: { ...record, packages: { "": { ...record } } },
    env: {
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF_TYPE: "tag",
      GITHUB_REF_NAME: `v${version}`,
      GITHUB_REPOSITORY: "TechSologic/federation-privacy-library",
    },
  };
}

test("release stays disabled by default, including after package private is removed", () => {
  const { manifest, lock, env } = fixture();
  assert.equal(releaseMetadata(manifest, lock, env).publish, false);
  delete manifest.private;
  assert.equal(releaseMetadata(manifest, lock, env).publish, false);
  env.NPM_PUBLISH_ENABLED = "false";
  assert.equal(releaseMetadata(manifest, lock, env).publish, false);
});

test("tagged prereleases use next and stable versions use latest", () => {
  for (const [version, channel] of [
    ["0.1.0-alpha.1", "next"],
    ["1.0.0-rc.2", "next"],
    ["1.0.0", "latest"],
  ]) {
    const { manifest, lock, env } = fixture(version);
    manifest.private = false;
    env.NPM_PUBLISH_ENABLED = "true";
    assert.deepEqual(releaseMetadata(manifest, lock, env), {
      version,
      dist_tag: channel,
      publish: true,
    });
  }
});

test("manual runs and branch pushes cannot publish even when enabled", () => {
  const { manifest, lock, env } = fixture();
  manifest.private = false;
  env.NPM_PUBLISH_ENABLED = "true";
  env.GITHUB_EVENT_NAME = "workflow_dispatch";
  assert.equal(releaseMetadata(manifest, lock, env).publish, false);
  env.GITHUB_EVENT_NAME = "push";
  env.GITHUB_REF_TYPE = "branch";
  env.GITHUB_REF_NAME = "main";
  assert.equal(releaseMetadata(manifest, lock, env).publish, false);
});

test("private packages and unofficial repositories cannot be released", () => {
  const { manifest, lock, env } = fixture();
  env.NPM_PUBLISH_ENABLED = "true";
  assert.throws(() => releaseMetadata(manifest, lock, env), /still private/);
  manifest.private = false;
  env.GITHUB_REPOSITORY = "someone/federation-privacy-library";
  assert.throws(() => releaseMetadata(manifest, lock, env), /official repository/);
});

test("mismatched tags and lockfile metadata fail even in validation-only runs", () => {
  const { manifest, lock, env } = fixture();
  env.GITHUB_REF_NAME = "v9.0.0";
  assert.throws(() => releaseMetadata(manifest, lock, env), /Release tag/);
  env.GITHUB_REF_NAME = `v${manifest.version}`;
  lock.version = "9.0.0";
  assert.throws(() => releaseMetadata(manifest, lock, env), /matching names and versions/);
  lock.version = manifest.version;
  lock.packages[""].version = "9.0.0";
  assert.throws(() => releaseMetadata(manifest, lock, env), /matching names and versions/);
});

test("invalid versions, package names, and repository metadata fail closed", () => {
  for (const version of [
    "1.2",
    "01.2.3",
    "1.2.3-01",
    "1.2.3-alpha.01",
    "1.2.3+build",
    "1.2.3\nnext",
    "1.2.3\n",
    "1.2.3-",
  ]) {
    const { manifest, lock, env } = fixture(version);
    assert.throws(() => releaseMetadata(manifest, lock, env), /SemVer/);
  }
  const { manifest, lock, env } = fixture();
  manifest.name = "different-package";
  assert.throws(() => releaseMetadata(manifest, lock, env), /package name/);
  manifest.name = lock.name;
  manifest.repository.url = "git+https://github.com/someone/other.git";
  assert.throws(() => releaseMetadata(manifest, lock, env), /repository/);
});
