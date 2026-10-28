# Development and release guide

[Back to README](../README.md) · [简体中文 README](../README.zh-CN.md) · [Architecture](ARCHITECTURE.md)

This document contains maintainer-level instructions for `pi-ui-extension`. User-facing commands and feature descriptions belong in the main README.

## Prerequisites

- Node.js **>= 22.19.0** and npm. `@types/node` stays on the Node 22 series (the same baseline as the Pi SDK's own development types) to prevent type checking from drifting to a newer major API surface; it does not pin the exact patch level, so CI still verifies the declared minimum 22.19.0 itself. Dependabot ignores major bumps of that package.
- Pi Coding Agent with `registerToolRenderer()`, **>= 1.3.0**. Development uses Pi SDK **1.4.0**; CI also verifies the minimum supported **1.3.0**. Pi 1.2.0 is no longer supported.
- Pi fullscreen mode for the sidebar. The standard shell command may resolve to a Bun-global or npm-global Pi installation.

## Checkout and test

```bash
git clone https://github.com/1993yihuan/pi-ui-extension.git
cd pi-ui-extension
npm ci
npm run check
```

`npm run check` runs type checking, tests, documentation checks, and package validation:

```bash
npm run typecheck
npm test
npm run check:docs
npm run check:package
```

The package check verifies that published runtime TypeScript files are included, while `*.test.ts` files are excluded from the npm tarball. Preview it with:

```bash
npm pack --dry-run
```

For one-off testing against **local source**, use the entry point from the repository root:

```bash
pi --no-extensions -e builtin:mcp -e ./extensions/index.ts --tui-mode fullscreen
```

`--no-extensions` prevents auto-discovery of a second, previously installed copy; explicitly listed `-e` extensions continue to load. To install a local path persistently instead, use `pi install ./path/to/pi-ui-extension`, noting that this changes Pi package configuration.

## Source layout

```text
pi-ui-extension/
├── extensions/
│   ├── ctx/                 # Compact context summary, token totals, composition
│   ├── dialogs/             # Centered TUI overlay dialogs and keyboard handling
│   ├── footer/              # Compact footer
│   ├── mcp/                 # MCP resources, runtime state and attribution
│   ├── session/             # Session browsing, question count and cleanup
│   ├── sidebar/             # Fullscreen panels, scrolling and resize
│   ├── tool-view/           # Normal/Compact/Hidden, Thinking and tool counters
│   └── index.ts             # Pi extension entry point
├── docs/
│   ├── ARCHITECTURE.md
│   ├── DEVELOPMENT.md
│   └── FORK-CHANGES.md      # Changes specific to this fork
├── .github/workflows/
│   ├── ci.yml
│   └── release.yml
├── package.json
└── tsconfig.check.json
```

Pi discovers the runtime entry point through the `pi.extensions` manifest in `package.json`:

```json
{
  "pi": {
    "extensions": ["./extensions/index.ts"]
  }
}
```

The `pi-package` keyword and declared package image make the published package eligible for Pi Package Catalog discovery. The image URL in `package.json` is also used by gallery/catalog consumers; do not change it without an updated visual asset.

## Supported test matrix

The [CI workflow](../.github/workflows/ci.yml) validates all four combinations on pushes to `main` and pull requests that change code, dependencies, scripts, or configuration:

| Node.js | Pi SDK |
| --- | --- |
| 22.19.0 | 1.3.0 |
| 22.19.0 | 1.4.0 |
| 24 | 1.3.0 |
| 24 | 1.4.0 |

The matrix, the release gate, and `package.json` must agree: `scripts/ci.mjs` holds the Node/Pi lists, and its tests fail if the workflow, the declared `engines.node`, or the declared minimum supported SDK drifts from them. `scripts/check-docs.mjs` additionally requires both root READMEs to state that Node minimum, and rejects any document whose explicit Node minimum differs from `engines.node`.

Each Pi SDK leg pins the entire `@earendil-works/pi-*` SDK family to the version under test so transitive semver ranges do not mix incompatible versions. The installed SDK versions are checked before running the complete test suite.

Changes limited to root README files, `LICENSE`, and Markdown/images under `docs/` instead run a lightweight job without installing dependencies. It checks Markdown UTF-8, final newlines, conflict markers, existing local link targets, and npm package contents. External links and section anchors are not fetched or validated. Missing or unreadable Git diffs fall back to the full matrix.

Configure branch protection to require **`CI result`**. This check runs for both routes and fails if any required job fails, is cancelled, or is unexpectedly skipped. Do not require individual matrix jobs, which are intentionally skipped for documentation-only commits. Superseded CI runs are cancelled; release runs use a separate package-wide queue.

When editing workflow helpers, their focused regression checks can be run without installing the SDK:

```bash
node --test scripts/ci.test.mjs scripts/check-docs.test.mjs scripts/release.test.mjs
```

For workflow syntax checks with `actionlint` 1.7.12, ignore only its unsupported `concurrency.queue` key diagnostic; the queue itself follows the GitHub specification linked below:

```bash
actionlint -ignore '^unexpected key "queue" for "concurrency" section\.'
```

**Do not rely on local SDK-only tests for host UI compatibility.** Global Pi distributions may run a separately bundled class instance with different minified method text. `extensions/tool-view/host-bundle.test.ts` verifies that the real bundled CLI classes (not the unbundled SDK copies) receive the spacing and Thinking patches, with tool-click and Thinking expansion assertions. The CI matrix runs these tests with both Pi 1.3.0 and 1.4.0. Also smoke-test the actual `pi -e` fullscreen UI with an isolated `PI_CODING_AGENT_DIR`, no saved session, and explicit `-e ./extensions/index.ts` when changing guarded host UI interactions. See [Architecture](ARCHITECTURE.md).

## Multiple Pi installations

A shell can resolve a Bun-global Pi instead of an npm-global Pi, even when npm has a newer package. Verify the active binary before diagnosing behavior:

```bash
command -v pi
pi --version
bun pm ls -g
npm ls -g @earendil-works/pi-coding-agent --depth=0
pi list
```

Check which shells and projects rely on each installation before removing an older package. For example, `npm uninstall -g @earendil-works/pi-coding-agent` is only appropriate if that particular global npm install is no longer needed. This repository does not uninstall Pi automatically.

## Release workflow

Use [`.github/workflows/release.yml`](../.github/workflows/release.yml) for publishing. Tag pushes matching `v*` enter the workflow, but only canonical stable tags such as `v1.8.4` are accepted; prereleases and build suffixes are rejected. Every release of this package shares a [queue](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency#example-queueing-multiple-pending-runs) (`queue: max`, no cancellation), so pending versions do not replace one another.

For a documentation-only correction, use a patch release, e.g. `1.5.1`. Bump the package version, update the lockfile and **version-pinned installation examples in both README languages**, then run validation:

```bash
npm version patch --no-git-tag-version
npm run check
npm pack --dry-run
```

Review the diff, commit only intended files, push to `main`, and wait for all four CI checks. Then create the matching annotated tag at the tested commit and push it:

```bash
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

Substitute the exact version for `X.Y.Z`. Avoid pushing a tag for an untested commit; never force-push release tags. The Release workflow performs:

1. Validate tag, `main` ancestry, package name/version, and the latest `main` push CI run for that **exact commit SHA**. All four Node/Pi jobs must have succeeded; a documentation-only CI run is insufficient. It waits up to ten minutes for CI to finish.
2. Check out the exact source SHA, install dependencies under Node.js 24 with pinned npm **11.21.0**, and run `npm run check`.
3. Pack once, validate actual tarball contents, and record its SHA-512 integrity and source SHA. The packed manifest includes `gitHead`; the source manifest is restored afterward. The same artifact is passed between jobs and retained for 14 days.
4. Look for an existing npm version. If its `gitHead` and integrity match, skip publication. Otherwise publish the validated tarball once with **npm Trusted Publishing (OIDC)**. New publication requires the matching tag event or an explicitly requested `release` dispatch from `main` for a verified existing stable tag, and cannot move npm `latest` backwards.
5. Verify registry `gitHead`, tarball integrity, and visibility of `latest` within one **ten-minute deadline**. Each HTTP request is limited to 20 seconds; 404 indexing delays, network errors, 429, and server errors may retry. Authentication failures and mismatched artifacts fail immediately. `npm publish` itself is never automatically retried.
6. Recheck the remote tag SHA, then create or complete the official GitHub Release. Recovery preserves existing release notes and does not mark an older release as latest.

Permissions are scoped to jobs: validation and packaging are read-only, only npm publication receives `id-token: write`, and only the final GitHub Release job receives `contents: write`. Checkouts do not persist credentials. Actions are pinned to full commit SHAs; Dependabot tracks their updates.

### Validation and recovery

The manual workflow entry accepts an existing stable `tag` and an `operation`:

```bash
# Validate the tag, exact-commit CI and package without publishing or changing Releases.
gh workflow run release.yml --ref main -f tag=vX.Y.Z -f operation=validate

# Publish an existing verified stable tag after confirming the version is absent from npm.
gh workflow run release.yml --ref main -f tag=vX.Y.Z -f operation=release

# Verify an already uploaded package and create/complete its GitHub Release.
gh workflow run release.yml --ref main -f tag=vX.Y.Z -f operation=recover
```

`recover` never runs `npm publish`. Use it when npm accepted the upload but indexing or GitHub Release creation failed. It rebuilds the artifact from the tag with the pinned npm version and requires the same SHA and bytes as the registry. Legacy packages or packaging changes that produce different bytes fail verification without overwriting anything.

If publication never reached npm, rerun the original **tag-triggered** workflow after resolving the error, or explicitly select `operation=release` on `main` for the existing stable tag. The manual release path still validates tag/main ancestry, package version, and the complete CI matrix for the exact source SHA before publication. `validate` never publishes; `recover` only verifies an existing upload. When rerunning failed jobs, the workflow reuses the successful packaging job's artifact name. If its 14-day artifact retention has expired, rerun all jobs to rebuild and verify the package.

Before announcing a successful release, independently verify:

```bash
npm view pi-ui-extension@X.Y.Z version --registry=https://registry.npmjs.org --prefer-online
gh release view vX.Y.Z
git rev-parse HEAD
git rev-parse origin/main
git rev-list -n1 vX.Y.Z
```

If registry verification times out, inspect npm first and use `recover` for an accepted upload. npm versions are immutable, and publication may have succeeded even though indexing is delayed.

## Compatibility changes

Raising the minimum supported Pi version affects existing users even when runtime code is unchanged. Announce the affected versions and migration/rollback path prominently in both README languages and GitHub Release notes; plan future support removals as breaking changes rather than ordinary patch releases. For v1.9.3, Pi 1.2.x users must upgrade Pi first or pin this extension to v1.9.2. The declared peer range is broader than the exact CI-tested versions.

## Documentation conventions

- `README.md` and `README.zh-CN.md` describe the same user-facing features and commands.
- Preserve session deletion warnings, MCP connectivity limits, CTX estimation caveats, and Thinking visibility requirements.
- Internal algorithms, version-specific Pi adapters and diagnostics belong in `ARCHITECTURE.md` rather than duplicated across the user README files.
- Keep both language versions and install pins synchronized for each release.
