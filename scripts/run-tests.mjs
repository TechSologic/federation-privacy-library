import { readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
const suites = process.argv.slice(2);
if (!suites.length || suites.some((s) => !["unit", "e2e", "tor"].includes(s)))
  throw new Error("Choose a test suite.");
function discover(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? discover(join(path, entry.name))
      : entry.name.endsWith(".test.js")
        ? [join(path, entry.name)]
        : [],
  );
}
const files = suites.flatMap((s) => discover(resolve(".test-dist/test", s)));
if (!files.length) throw new Error("No tests discovered.");
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
