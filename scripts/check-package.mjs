import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function runtimeSources(root, dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return runtimeSources(root, path);
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
    return [relative(root, path).split(sep).join("/")];
  });
}

export function checkPackageFiles(sourceRoot, paths) {
  const files = new Set(paths);
  if (!files.size) throw new Error("npm pack returned no package files");
  const excludedTests = [...files].filter((path) => /\.test\.[cm]?[jt]sx?$/.test(path));
  if (excludedTests.length) throw new Error(`Tests found in npm package: ${excludedTests.join(", ")}`);
  const required = ["README.md", "README.zh-CN.md", "LICENSE", ...runtimeSources(sourceRoot, join(sourceRoot, "extensions"))];
  const missing = required.filter((path) => !files.has(path));
  if (missing.length) throw new Error(`Runtime sources missing from npm package: ${missing.join(", ")}`);
  console.log(`npm package OK: ${files.size} files, 0 tests, all ${required.length - 3} runtime sources included`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = ["pack", "--dry-run", "--json", "--ignore-scripts"];
  // Windows Node cannot execFileSync a .cmd shim; run npm's JS entry point instead.
  const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const list = JSON.parse(execFileSync(
    process.platform === "win32" ? process.execPath : "npm",
    process.platform === "win32" ? [npmCli, ...args] : args,
    { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 60_000 },
  ));
  checkPackageFiles(root, list[0]?.files?.map((entry) => entry.path));
}
