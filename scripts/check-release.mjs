import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = "TechSologic/federation-privacy-library";
const packageName = "@techsologic/federation-privacy-library";
// Build metadata is deliberately excluded: every release has one unambiguous npm version.
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function releaseMetadata(manifest, lock, env = {}) {
  const match = typeof manifest.version === "string" && manifest.version.match(versionPattern);
  if (
    !match ||
    match[0] !== manifest.version ||
    match[4]?.split(".").some((part) => /^\d+$/.test(part) && /^0\d/.test(part))
  ) {
    throw new Error("Release version must be SemVer without build metadata or leading zeroes.");
  }
  if (manifest.name !== packageName) throw new Error("Unexpected npm package name.");
  if (manifest.repository?.url !== `git+https://github.com/${repository}.git`) {
    throw new Error("Package repository must match the trusted publishing repository.");
  }
  for (const record of [lock, lock.packages?.[""]]) {
    if (record?.name !== manifest.name || record?.version !== manifest.version) {
      throw new Error("package.json and package-lock.json must have matching names and versions.");
    }
  }
  if (manifest.private !== undefined && typeof manifest.private !== "boolean") {
    throw new Error("The package private field must be boolean when present.");
  }
  const tagged = env.GITHUB_REF_TYPE === "tag";
  if (tagged && env.GITHUB_REF_NAME !== `v${manifest.version}`) {
    throw new Error("Release tag must exactly match v followed by the package version.");
  }
  const requested =
    env.NPM_PUBLISH_ENABLED === "true" && env.GITHUB_EVENT_NAME === "push" && tagged;
  if (requested && manifest.private === true) {
    throw new Error(
      "Publishing is enabled, but package.json is still private. Prepare a release first.",
    );
  }
  if (requested && env.GITHUB_REPOSITORY !== repository) {
    throw new Error("Only the official repository may publish this package.");
  }
  return {
    version: manifest.version,
    dist_tag: match[4] ? "next" : "latest",
    publish: requested,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    const metadata = releaseMetadata(manifest, lock, process.env);
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        Object.entries(metadata)
          .map(([key, value]) => `${key}=${value}\n`)
          .join(""),
      );
    }
    console.log(`Validated ${metadata.version}; npm channel: ${metadata.dist_tag}.`);
    console.log(
      metadata.publish
        ? "Publishing enabled for this tag."
        : "Validation only; publishing disabled.",
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
