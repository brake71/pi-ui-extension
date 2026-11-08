import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EXPECTED_CHECKS, NODE_VERSIONS, PI_VERSIONS, SDK_PACKAGES, aggregateResults, classifyEvent, docsOnly,
  installedSdkPackages, sdkInstallArgs, sdkResolutionErrors, sdkVersionErrors,
} from "./ci.mjs";

// Build a fake node_modules so resolution can be checked without installing anything.
function sdkTree(packages) {
  const root = mkdtempSync(join(tmpdir(), "pi-sdk-"));
  for (const [path, version] of Object.entries(packages)) {
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, path, "package.json"), JSON.stringify({ version }));
  }
  return root;
}

test("the required matrix matches the workflow, the declared minimums and the pinned development SDK", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const workflow = read("../.github/workflows/ci.yml");
  const manifest = JSON.parse(read("../package.json"));
  const axis = key => [...workflow.match(new RegExp(`\n\\s*${key}: \\[([^\\]]*)\\]`))[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  const nodes = axis("node-version");
  const pi = axis("pi-version");
  assert.deepEqual(nodes, NODE_VERSIONS, "ci.yml and the release gate must list the same Node versions");
  assert.deepEqual(pi, PI_VERSIONS, "ci.yml and the release gate must list the same Pi SDK versions");
  assert.equal(manifest.engines.node, `>=${nodes[0]}`,
    `package.json must declare the lowest tested Node version as its runtime minimum`);
  assert.equal(new Set(PI_VERSIONS).size, PI_VERSIONS.length, "an axis must not repeat a Pi SDK version");
  // A single axis is valid while one Pi SDK is maintained; PI_VERSIONS[0] is the peer minimum.
  // The development pin is a tested axis of its own; it must not raise what users have to install.
  const pinned = manifest.devDependencies["@earendil-works/pi-coding-agent"];
  assert.ok(PI_VERSIONS.includes(pinned), `the development SDK must be a tested axis, got ${pinned}`);
  for (const name of ["pi-coding-agent", "pi-tui"]) {
    const dependency = `@earendil-works/${name}`;
    assert.equal(manifest.peerDependencies[dependency], `>=${PI_VERSIONS[0]}`,
      `${dependency} must keep the lowest tested Pi SDK as its minimum supported version`);
    assert.equal(manifest.devDependencies[dependency], pinned,
      `both directly developed ${dependency} copies must be pinned to the same axis`);
  }
  assert.equal(EXPECTED_CHECKS.length, nodes.length * pi.length, "no extra or missing matrix job");
  // Each axis must switch and verify the whole Pi family, not only the two peer packages.
  assert.match(workflow, /install-sdk \$\{\{ matrix\.pi-version \}\}/);
  assert.match(workflow, /verify-sdk \$\{\{ matrix\.pi-version \}\}/);
});
test("an SDK axis cannot pass with a mixed or incomplete Pi family", () => {
  const complete = Object.fromEntries(SDK_PACKAGES.map(name => [`@earendil-works/${name}`, "1.5.0"]));
  const noBundle = ["the installed Pi CLI ships no dist/bundle/cli.js for the host bundle tests"];
  assert.deepEqual(sdkVersionErrors("1.5.0", complete, "test"), noBundle);
  assert.equal(sdkVersionErrors("1.4.0", complete, "test").length, SDK_PACKAGES.length + 1,
    "a 1.5 install cannot pass as an axis that expects another version");
  assert.match(sdkVersionErrors("1.5.0", { ...complete, "@earendil-works/pi-tui": "1.4.0" }, "test")[0],
    /pi-tui: expected 1\.5\.0, got 1\.4\.0/);
  // A sibling such as pi-schema is only checked when it is part of the installed family.
  assert.deepEqual(sdkVersionErrors("1.5.0", { ...complete, "@earendil-works/pi-schema": "1.5.0" }, "test"), noBundle);
  assert.match(sdkVersionErrors("1.5.0", { ...complete, "@earendil-works/pi-schema": "1.4.0" }, "test").join(),
    /pi-schema: expected 1\.5\.0/);
  const { "@earendil-works/pi-mcp": _missing, ...incomplete } = complete;
  assert.match(sdkVersionErrors("1.5.0", incomplete, "test").join(), /pi-mcp is not installed/);
  // A consistent root list must not hide a second copy nested inside the host CLI.
  const nested = { ...complete, "@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui": "1.4.0" };
  assert.match(sdkVersionErrors("1.5.0", nested, "test").join(),
    /pi-coding-agent\/node_modules\/@earendil-works\/pi-tui: expected 1\.5\.0, got 1\.4\.0/);
  for (const version of PI_VERSIONS) {
    const args = sdkInstallArgs(version);
    assert.ok(SDK_PACKAGES.every(name => args.includes(`@earendil-works/${name}@${version}`)));
    assert.ok(args.includes("--no-save") && args.includes("--no-package-lock"),
      "a matrix install must not rewrite the manifest or the lockfile");
  }
  assert.throws(() => sdkInstallArgs("1.3.0"), /Unknown Pi SDK version/);
});

test("the installed Pi tree is read including nested copies and their versions", () => {
  const root = sdkTree({
    "node_modules/@earendil-works/pi-tui": "1.5.0",
    "node_modules/@earendil-works/pi-coding-agent": "1.5.0",
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui": "1.4.0",
  });
  assert.deepEqual(installedSdkPackages(join(root, "node_modules")), {
    "@earendil-works/pi-tui": "1.5.0",
    "@earendil-works/pi-coding-agent": "1.5.0",
    "@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui": "1.4.0",
  });
  assert.deepEqual(installedSdkPackages(join(root, "missing")), {});
});

test("the host CLI must resolve the root Pi TUI, not a nested copy", () => {
  const deduped = sdkTree({
    "node_modules/@earendil-works/pi-tui": "1.4.0",
    "node_modules/@earendil-works/pi-coding-agent/dist/bundle": "1.4.0",
  });
  assert.deepEqual(sdkResolutionErrors("1.4.0", join(deduped, "node_modules")), []);
  assert.match(sdkResolutionErrors("1.5.0", join(deduped, "node_modules"))[0],
    /resolves .*node_modules\/@earendil-works\/pi-tui \(1\.4\.0\), not the root .* \(1\.5\.0\)/,
    "the wrong axis must fail on the resolved version");
  const mixed = sdkTree({
    "node_modules/@earendil-works/pi-tui": "1.5.0",
    "node_modules/@earendil-works/pi-coding-agent/dist/bundle": "1.5.0",
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui": "1.5.0",
  });
  assert.match(sdkResolutionErrors("1.5.0", join(mixed, "node_modules"))[0],
    /resolves .*pi-coding-agent\/node_modules\/@earendil-works\/pi-tui/,
    "a nested copy of the same version still breaks TUI class identity");
  assert.deepEqual(sdkResolutionErrors("1.5.0", join(mixed, "absent")),
    [`${join(mixed, "absent")}/@earendil-works/pi-tui is not installed`]);
});

test("only known documentation changes skip the SDK matrix", () => {
  assert.equal(docsOnly(["README.md", "README.zh-CN.md", "docs/ARCHITECTURE.md"]), true);
  for (const paths of [[], ["extensions/index.ts"], ["docs/tool.js"], ["README.md", "package-lock.json"], [".github/workflows/ci.yml"], ["scripts/ci.mjs"]]) assert.equal(docsOnly(paths), false);
});
test("missing, new-branch or unreadable diffs get full validation", () => {
  const sha = "a".repeat(40), other = "b".repeat(40);
  assert.equal(classifyEvent({ before: "0".repeat(40), after: sha }), false);
  assert.equal(classifyEvent({ before: sha, after: other }, () => { throw Error("missing base"); }), false);
  const calls = [];
  const result = classifyEvent({ pull_request: { base: { sha }, head: { sha: other } } }, args => {
    calls.push(args);
    return args[0] === "merge-base" ? sha : "README.md\0extensions/old.ts\0";
  });
  assert.equal(result, false, "renaming code into docs must still run tests");
  assert.ok(calls[1].includes("--no-renames"));
});
test("CI summary cannot pass after a skipped, failed or cancelled required job", () => {
  for (const docs of [true, false]) {
    const needs = { changes: { result: "success", outputs: { docs_only: String(docs) } }, docs: { result: docs ? "success" : "skipped" }, check: { result: docs ? "skipped" : "success" } };
    assert.equal(aggregateResults(needs), true);
    for (const result of ["failure", "cancelled", "skipped"]) {
      const failed = structuredClone(needs);
      failed[docs ? "docs" : "check"].result = result;
      assert.equal(aggregateResults(failed), false);
    }
    needs.changes.result = "failure";
    assert.equal(aggregateResults(needs), false);
  }
});
