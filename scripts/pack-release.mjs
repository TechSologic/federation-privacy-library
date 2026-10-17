import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
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
const documents = new Set(["package.json", "LICENSE", "NOTICE.md", "README.md", "docs/runtime.md"]);
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
  // With no runtime dependencies, installation should work without registry access.
  npm(["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", tarball], consumer);
  const imports = Object.keys(manifest.exports).map((key) =>
    key === "." ? manifest.name : manifest.name + key.slice(1),
  );
  writeFileSync(
    join(consumer, "smoke.mjs"),
    imports.map((name) => `await import(${JSON.stringify(name)});`).join("\n"),
  );
  const result = spawnSync(process.execPath, ["smoke.mjs"], { cwd: consumer, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Installed package imports failed.");
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
  `Validated ${packed.name}@${packed.version}: package files, exports, and clean installation.`,
);
