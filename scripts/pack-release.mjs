import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { releaseMetadata } from "./check-release.mjs";

const root = process.cwd();
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
releaseMetadata(manifest, lock);
if (!process.env.npm_execpath) throw new Error("Run this script using npm run release:pack.");

function npm(args, cwd = root) {
  const result = spawnSync(process.execPath, [process.env.npm_execpath, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "npm failed.");
  return result.stdout;
}

const output = resolve(".release");
mkdirSync(output, { recursive: true });
// npm's prepack hook builds the declarations and JavaScript before packing.
const records = JSON.parse(npm(["pack", "--json", "--pack-destination", output]));
if (records.length !== 1) throw new Error("Expected exactly one package.");
const packed = records[0];
if (packed.name !== manifest.name || packed.version !== manifest.version) {
  throw new Error("Packed identity differs from the validated manifest.");
}
if (packed.filename !== basename(packed.filename)) throw new Error("Invalid package filename.");
const files = new Set(packed.files.map((file) => file.path));
const documents = new Set([
  "package.json",
  "LICENSE",
  "NOTICE.md",
  "README.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "SUPPORT.md",
  "docs/README.md",
  "docs/using-library/README.md",
  "docs/using-library/api.md",
  "docs/using-library/architecture.md",
  "docs/using-library/runtime.md",
  "docs/using-library/privacy.md",
  "docs/using-library/api-example.ts",
  "examples/README.md",
  "examples/two-nodes.mjs",
  "examples/support/local-demo.mjs",
  "scripts/run-example.mjs",
]);
// npm can include a directory README alongside explicitly selected files within it.
const allowedDocuments = new Set([...documents, "docs/README.md"]);
for (const path of files) {
  if (
    !allowedDocuments.has(path) &&
    !/^dist\/(?:[\w-]+\/)*[\w.-]+\.(?:js|d\.ts|js\.map|d\.ts\.map)$/.test(path)
  ) {
    throw new Error(`Unexpected published file: ${path}`);
  }
}
for (const path of documents) {
  if (!files.has(path)) throw new Error(`Missing package document: ${path}`);
  if (!path.endsWith(".md")) continue;
  for (const match of readFileSync(path, "utf8").matchAll(/\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
    const target = match[1].split("#")[0];
    if (!target || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
    const destination = posix.normalize(posix.join(dirname(path), target));
    if (!files.has(destination)) throw new Error(`Broken package link: ${path} -> ${target}`);
  }
}
for (const entry of Object.values(manifest.exports)) {
  for (const path of [entry.import, entry.types]) {
    if (!path?.startsWith("./") || !files.has(path.slice(2))) {
      throw new Error(`Missing package export: ${path}`);
    }
  }
}

const tarball = join(output, packed.filename);
const consumer = mkdtempSync(join(tmpdir(), "federation-package-check-"));
try {
  writeFileSync(join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
  // Repack the exact installed production dependency tree so the consumer test
  // proves the artifact can install without consulting mutable registry state.
  const dependencyTarballs = [];
  for (const [packagePath, record] of Object.entries(lock.packages ?? {})) {
    // The isolated consumer also needs a compiler, without borrowing this
    // checkout's ambient types or development dependency resolution.
    if (!packagePath.startsWith("node_modules/")) continue;
    if (record.dev === true && packagePath !== "node_modules/typescript") continue;
    const installedPath = resolve(packagePath);
    const installedManifest = JSON.parse(readFileSync(join(installedPath, "package.json"), "utf8"));
    if (installedManifest.version !== record.version) {
      throw new Error(`Installed dependency differs from lockfile: ${packagePath}.`);
    }
    const dependencyOutput = join(consumer, "dependencies", String(dependencyTarballs.length));
    mkdirSync(dependencyOutput, { recursive: true });
    const dependencyRecords = JSON.parse(
      npm([
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        dependencyOutput,
        installedPath,
      ]),
    );
    if (
      dependencyRecords.length !== 1 ||
      dependencyRecords[0].name !== installedManifest.name ||
      dependencyRecords[0].version !== installedManifest.version
    ) {
      throw new Error(`Packed dependency identity differs from lockfile: ${packagePath}.`);
    }
    dependencyTarballs.push(join(dependencyOutput, dependencyRecords[0].filename));
  }
  npm(
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarball,
      ...dependencyTarballs,
    ],
    consumer,
  );
  const imports = Object.keys(manifest.exports).map((key) =>
    key === "." ? manifest.name : manifest.name + key.slice(1),
  );
  writeFileSync(
    join(consumer, "smoke.mjs"),
    imports.map((name) => `await import(${JSON.stringify(name)});`).join("\n") +
      `
const api = await import(${JSON.stringify(manifest.name)});
if (typeof api.createFederation !== "function" || "FederationDeliveryCoordinator" in api || "FederationLookupRpcClient" in api.protocol) throw new Error("Unexpected application API");
const federation = api.createFederation({storage:{}});
await federation.start(); await federation.stop();
for (const entry of ["delivery", "dht", "protocol"]) {
  let rejected = false;
  try { await import(${JSON.stringify(manifest.name)} + "/" + entry); }
  catch (error) { if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error; rejected = true; }
  if (!rejected) throw new Error("Internal engine subpath remains public");
}
`,
  );
  const result = spawnSync(process.execPath, ["smoke.mjs"], { cwd: consumer, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Installed package imports failed.");
  writeFileSync(
    join(consumer, "consumer.ts"),
    `import { createFederation, type FederationConfiguration } from "${manifest.name}";
import { MemoryFederationStorage } from "${manifest.name}/adapters";
import * as testing from "${manifest.name}/testing";
const configuration: FederationConfiguration = { storage: {} };
const federation = createFederation(configuration);
await federation.start();
await federation.stop();
void MemoryFederationStorage; void testing;
`,
  );
  const installedRoot = join(consumer, "node_modules", manifest.name);
  const types = spawnSync(
    process.execPath,
    [
      join(consumer, "node_modules/typescript/bin/tsc"),
      "--strict",
      "--noEmit",
      "--allowJs",
      "--checkJs",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--lib",
      "ES2022,DOM",
      "consumer.ts",
      join(installedRoot, "docs/using-library/api-example.ts"),
      join(installedRoot, "examples/two-nodes.mjs"),
      join(installedRoot, "examples/support/local-demo.mjs"),
    ],
    { cwd: consumer, stdio: "inherit" },
  );
  if (types.error) throw types.error;
  if (types.status !== 0) throw new Error("Installed package consumer or example types failed.");
  const example = spawnSync(process.execPath, [join(installedRoot, "scripts/run-example.mjs")], {
    cwd: consumer,
    stdio: "inherit",
  });
  if (example.error) throw example.error;
  if (example.status !== 0) throw new Error("Installed package example failed.");
  const installed = JSON.parse(
    readFileSync(join(consumer, "node_modules", manifest.name, "package.json"), "utf8"),
  );
  releaseMetadata(installed, lock);
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
// The publishing job receives exactly the artifact that passed the consumer check.
copyFileSync(tarball, join(output, "package.tgz"));
console.log(
  `Validated ${packed.name}@${packed.version}: package files, links, exports, clean installation, consumer types, and packaged example.`,
);
