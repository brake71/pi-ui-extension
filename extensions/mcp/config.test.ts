import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LoadedMcpConfig } from "@earendil-works/pi-coding-agent";
import { configuredMcpServers } from "./status-center.ts";

// Tests alone may load Pi's non-exported config reader as a behavioral oracle.
const nativeEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { loadMcpConfig } = await import(new URL("./extensions/mcp/config.js", nativeEntry).href) as {
  loadMcpConfig(options: { agentDir: string; cwd: string; projectTrusted: boolean }): LoadedMcpConfig;
};

function fixture(run: (agent: string, project: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pi-mcp-config-"));
  const agent = join(root, "agent"), project = join(root, "project");
  mkdirSync(agent);
  mkdirSync(join(project, ".pi"), { recursive: true });
  try { run(agent, project); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

function writeConfig(directory: string, servers: Record<string, unknown>, bom = ""): void {
  writeFileSync(join(directory, "mcp.json"), bom + JSON.stringify({ mcpServers: servers }));
}

function compareNative(agent: string, project: string, trusted = true) {
  const actual = configuredMcpServers(agent, project, trusted);
  const native = loadMcpConfig({ agentDir: agent, cwd: project, projectTrusted: trusted });
  assert.deepEqual(actual.servers, native.servers.map((server) => ({
    name: server.name,
    source: server.override ? "project override" : server.scope,
    enabled: server.config.enabled !== false,
  })));
  assert.equal(actual.warnings.length, native.errors.length);
  return actual;
}

test("invalid project overrides preserve global servers and emit redacted warnings", () => {
  fixture((agent, project) => {
    writeConfig(agent, { docs: { url: "https://private.invalid/mcp", headers: { Authorization: "Bearer credential-secret" } } });
    const invalid = [
      { enabled: false, timeout: 5 }, // Original regression: wrongly disabled a valid global server.
      { enabled: false, command: null }, { enabled: false, url: null }, { enabled: false, type: null },
      { enabled: false, disabled: true }, { enabled: false, headers: { Authorization: "credential-secret" } },
      { enabled: "credential-secret" }, { enabled: null }, { enabled: 0 },
      { enabled: false, exposure: "credential-secret" }, { enabled: false, exposure: null },
      { enabled: false, toolExposure: [] }, { enabled: false, toolExposure: null },
      { enabled: false, toolExposure: { "credential-secret\u001b[31m": "invalid" } },
      { enabled: false, "credential-secret\u001b[31m": "arbitrary-content" },
      { enabled: false, auth: { provider: "credential-secret" } },
    ];
    for (const override of invalid) {
      writeConfig(join(project, ".pi"), { docs: override });
      const actual = compareNative(agent, project);
      assert.deepEqual(actual.servers, [{ name: "docs", source: "global", enabled: true }]);
      assert.equal(actual.warnings.length, 1);
      assert.doesNotMatch(JSON.stringify(actual), /credential-secret|arbitrary-content|private\.invalid|Authorization|\u001b/);
    }
  });
});

test("valid project overrides retain inherited enabled state and accept all native exposure settings", () => {
  fixture((agent, project) => {
    writeConfig(agent, { docs: { command: "never-executed", enabled: false } });
    for (const exposure of ["codemode", "codemode-deferred", "deferred", "direct", "hidden"]) {
      for (const override of [{}, { exposure }, { toolExposure: { "read_*": exposure } }, { enabled: true, exposure }]) {
        writeConfig(join(project, ".pi"), { docs: override });
        const actual = compareNative(agent, project);
        assert.deepEqual(actual.servers, [{ name: "docs", source: "project override", enabled: "enabled" in override }]);
      }
    }
  });
});

test("full project entries replace globals only after validation and honor credential trust boundaries", () => {
  fixture((agent, project) => {
    writeConfig(agent, { docs: { url: "https://global.invalid/mcp", auth: { provider: "credential-secret" }, enabled: false } });
    for (const config of [
      { command: "never-executed", enabled: true },
      { url: "https://project.invalid/mcp", enabled: true, headers: { Authorization: "credential-secret" } },
    ]) {
      writeConfig(join(project, ".pi"), { docs: config });
      assert.deepEqual(compareNative(agent, project).servers, [{ name: "docs", source: "project", enabled: true }]);
    }
    for (const config of [
      { command: 42, enabled: true }, { command: "never-executed", args: [42], enabled: true },
      { url: "file:///credential-secret", enabled: true },
      { url: "https://project.invalid/mcp", auth: { provider: "credential-secret" }, enabled: true },
    ]) {
      writeConfig(join(project, ".pi"), { docs: config });
      const actual = compareNative(agent, project);
      assert.deepEqual(actual.servers, [{ name: "docs", source: "global", enabled: false }]);
      assert.doesNotMatch(JSON.stringify(actual), /credential-secret|project\.invalid/);
    }
    // Allowed overrides keep the global provider credential, without reading or exposing it.
    writeConfig(join(project, ".pi"), { docs: { enabled: true } });
    assert.deepEqual(compareNative(agent, project).servers, [{ name: "docs", source: "project override", enabled: true }]);
    // Untrusted project files are never parsed, so even malformed JSON produces no warning.
    writeFileSync(join(project, ".pi", "mcp.json"), "credential-secret malformed JSON");
    assert.deepEqual(compareNative(agent, project, false), {
      servers: [{ name: "docs", source: "global", enabled: false }], warnings: [],
    });
  });
});

test("standalone overrides, invalid global entries, and namespace collisions match native loading", () => {
  fixture((agent, project) => {
    writeConfig(agent, {
      valid: { command: "never-executed", disabled: true }, // disabled is only an adapter convention.
      "same-name": { command: "never-executed" },
      same_name: { command: "never-executed" },
      "unsafe\u001b[31m": { command: "credential-secret" },
      no_transport: { enabled: false },
      invalid_enabled: { command: "never-executed", enabled: "false" },
    });
    writeConfig(join(project, ".pi"), { standalone: { enabled: false }, valid: { enabled: false, timeout: 5 } });
    const actual = compareNative(agent, project);
    assert.deepEqual(actual.servers, [
      { name: "valid", source: "global", enabled: true },
      { name: "same-name", source: "global", enabled: true },
    ]);
    assert.doesNotMatch(JSON.stringify(actual), /unsafe|credential-secret|\u001b/);
  });
});

test("native transport and common setting validation rejects invalid full definitions", () => {
  fixture((agent, project) => {
    const configs: Record<string, unknown>[] = [
      { command: "server", exposure: false }, { command: "server", toolExposure: { read: false } },
      { command: "server", description: 1 }, { command: "server", timeout: 0 },
      { command: "server", type: "sse" }, { command: "server", type: "unknown" },
      { command: "server", env: { SECRET: 1 } }, { command: "server", cwd: false },
      { url: "https://example.invalid", headers: [] }, { url: "https://example.invalid", oauth: [] },
      ...[
        { clientId: 1 }, { clientSecret: 1 }, { scope: 1 }, { callbackPort: 0 }, { callbackPort: 65536 },
        { callbackPort: 1.5 }, { callbackUrl: "https://localhost/callback" },
        { callbackUrl: "http://example.invalid/callback" }, { callbackUrl: "http://localhost/callback?secret=x" },
        { callbackUrl: "http://localhost/callback#secret" }, { callbackUrl: "http://localhost:1234/callback", callbackPort: 5678 },
        { clientName: " " }, { clientRegistration: "invalid" }, { clientRegistration: "cimd", clientId: "id" },
        { clientRegistration: "cimd", clientName: "name" },
        { clientRegistration: "cimd", callbackUrl: "http://[::1]/callback" },
        { clientRegistration: "cimd", callbackUrl: "http://localhost/wrong" },
        { authServerMetadataUrl: "http://example.invalid" },
      ].map((oauth) => ({ url: "https://example.invalid", oauth })),
      { url: "https://example.invalid", auth: {} },
      { url: "http://example.invalid", auth: { provider: "secret" } },
    ];
    for (const config of configs) {
      writeConfig(agent, { invalid: config });
      const actual = compareNative(agent, project);
      assert.deepEqual(actual.servers, []);
      assert.equal(actual.warnings.length, 1);
    }
    for (const config of [
      { command: "server", args: ["arg"], env: { KEY: "value" }, cwd: ".", timeout: 1 },
      { url: "https://example.invalid", type: "streamable-http", oauth: { clientId: "id", clientSecret: "secret", scope: "read" } },
      { url: "http://127.0.0.1:1234", auth: { provider: "provider" } },
      { url: "https://example.invalid", oauth: { clientRegistration: "cimd", callbackUrl: "http://localhost/callback" } },
    ]) {
      writeConfig(agent, { valid: config });
      assert.equal(compareNative(agent, project).servers.length, 1);
    }
  });
});

test("UTF-8 BOM in global and trusted project configs is accepted without warnings", () => {
  fixture((agent, project) => {
    writeConfig(agent, { docs: { command: "never-executed" } }, "\uFEFF");
    writeConfig(join(project, ".pi"), { docs: { enabled: false }, local: { command: "never-executed" } }, "\uFEFF");
    const actual = configuredMcpServers(agent, project, true);
    assert.deepEqual(actual, {
      servers: [
        { name: "docs", source: "project override", enabled: false },
        { name: "local", source: "project", enabled: true },
      ], warnings: [],
    });
    assert.deepEqual(configuredMcpServers(agent, project, false), {
      servers: [{ name: "docs", source: "global", enabled: true }], warnings: [],
    });
    compareNative(agent, project);
    writeFileSync(join(project, ".pi", "mcp.json"), '\uFEFF{"credential-secret":');
    const malformed = configuredMcpServers(agent, project, true);
    assert.deepEqual(malformed.warnings, ["Invalid project MCP configuration"]);
    assert.doesNotMatch(JSON.stringify(malformed), /credential-secret/);
  });
});
