import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { showMcpStatusDialog } from "../index.ts";
import {
  adapterMcpServers, buildMcpStatusSnapshot, configuredMcpServers,
  describeMcpStatus, registeredMcpServers,
} from "./status-center.ts";

function withConfigs<Result>(run: (agent: string, project: string) => Result): Result {
  const root = mkdtempSync(join(tmpdir(), "pi-mcp-status-"));
  const agent = join(root, "agent");
  const project = join(root, "project");
  mkdirSync(agent);
  mkdirSync(join(project, ".pi"), { recursive: true });
  try { return run(agent, project); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("native Pi enabled:false and trusted project overrides win without leaking config", () => {
  withConfigs((agent, project) => {
    writeFileSync(join(agent, "mcp.json"), JSON.stringify({ mcpServers: {
      docs: { url: "https://private.example/token-123", headers: { Authorization: "Bearer secret" } },
      blocked: { command: "super-secret-executable", enabled: false },
      reenable: { command: "secret-command", enabled: false },
    } }));
    writeFileSync(join(project, ".pi", "mcp.json"), JSON.stringify({ mcpServers: {
      docs: { enabled: false },
      reenable: { enabled: true, exposure: "direct" },
      local: { command: "private-key-path" },
    } }));

    assert.deepEqual(configuredMcpServers(agent, project, false).servers.map((s) => [s.name, s.enabled]), [
      ["docs", true], ["blocked", false], ["reenable", false],
    ]);
    const snapshot = buildMcpStatusSnapshot(agent, project, true, []);
    assert.deepEqual(snapshot.servers.map((s) => [s.name, s.source, s.enabled]), [
      ["docs", "project override", false],
      ["blocked", "global", false],
      ["reenable", "project override", true],
      ["local", "project", true],
    ]);
    assert.doesNotMatch(JSON.stringify(snapshot), /token-123|secret|private-key-path/);
    assert.match(describeMcpStatus(snapshot.servers[0]!), /Отключено/);
  });
});

test("extension registrations are not mistaken for confirmed connections", () => {
  withConfigs((agent, project) => {
    const registered = [
      { name: "extension_mcp", extensionPath: "/sensitive/path", config: { url: "https://secret.invalid" } },
      { name: "disabled_ext", config: { command: "secret", enabled: false } },
      { name: "\u001b[31munsafe", config: { command: "secret" } },
    ];
    assert.deepEqual(registeredMcpServers(registered).map((s) => s.name), ["extension_mcp", "disabled_ext"]);
    const snapshot = buildMcpStatusSnapshot(agent, project, true, registered);
    assert.deepEqual(snapshot.servers.map((s) => [s.name, s.source, s.connection]), [
      ["extension_mcp", "extension", "unknown"],
      ["disabled_ext", "extension", "unknown"],
    ]);
    assert.match(describeMcpStatus(snapshot.servers[0]!), /Зарегистрировано.*соединение не проверено/);
    assert.doesNotMatch(JSON.stringify(snapshot), /sensitive|secret|unsafe/);
  });
});

test("adapter v1 reports loading separately from explicit health and ignores disabled entries", () => {
  withConfigs((agent, project) => {
    writeFileSync(join(agent, "mcp.json"), JSON.stringify({ mcpServers: {
      docs: { command: "secret" },
      blocked: { enabled: false, command: "secret" },
    } }));
    const observed = adapterMcpServers({ version: 1, servers: [
      { name: "docs" },
      { name: "logged_in", state: "connected", error: "secret" },
      { name: "auth", status: "needs-auth", headers: { Authorization: "secret" } },
      { name: "blocked", state: "connected" },
      { name: "not_running", enabled: false, state: "connected" },
      { name: "logged_in", state: "connected" },
      { name: "\u001b[33muntrusted", state: "connected" },
    ] });
    assert.equal(observed?.length, 5);
    const snapshot = buildMcpStatusSnapshot(agent, project, true, [], observed);
    assert.deepEqual(snapshot.servers.map((s) => [s.name, s.enabled, s.loaded, s.connection]), [
      ["docs", true, true, "unknown"],
      ["blocked", false, false, "unknown"],
      ["logged_in", true, true, "connected"],
      ["auth", true, true, "needs-auth"],
      ["not_running", false, false, "unknown"],
    ]);
    assert.match(describeMcpStatus(snapshot.servers[0]!), /Загружено.*соединение не проверено/);
    assert.match(describeMcpStatus(snapshot.servers[2]!), /Подключено.*статус адаптера/);
    assert.doesNotMatch(JSON.stringify(snapshot), /secret|untrusted/);
    assert.deepEqual(
      buildMcpStatusSnapshot(agent, project, true, [], []).servers.map((s) => s.name),
      ["docs", "blocked"],
      "a replacement adapter snapshot must not retain removed servers",
    );
  });
});

test("malformed adapter snapshots and invalid config files fail safely", () => {
  assert.equal(adapterMcpServers({ version: 2, servers: [] }), undefined);
  assert.equal(adapterMcpServers({ version: 1, servers: "bad" }), undefined);
  assert.deepEqual(adapterMcpServers({ version: 1, servers: [{ name: "ok", state: "bogus" }] }), [
    { name: "ok", enabled: true, state: "unknown" },
  ]);
  withConfigs((agent, project) => {
    writeFileSync(join(agent, "mcp.json"), '{"mcpServers":{"api":{"headers":{"Authorization":"secret"}}');
    const snapshot = buildMcpStatusSnapshot(agent, project, false, []);
    assert.deepEqual(snapshot.servers, []);
    assert.deepEqual(snapshot.warnings, ["Invalid global MCP configuration"]);
    assert.doesNotMatch(JSON.stringify(snapshot), /secret/);
  });
});

test("MCP connection lifecycle replaces observations instead of keeping stale states", () => {
  withConfigs((agent, project) => {
    writeFileSync(join(agent, "mcp.json"), JSON.stringify({
      mcpServers: { remote: { command: "server" }, disabled: { enabled: false, command: "server" } },
    }));
    const registered = [{ name: "extension", config: { command: "server" } }];
    const observe = (servers: unknown[]) => buildMcpStatusSnapshot(
      agent, project, true, registered, adapterMcpServers({ version: 1, servers }) ?? [],
    );
    const state = (snapshot: ReturnType<typeof observe>, name: string) =>
      snapshot.servers.find((server) => server.name === name)!.connection;
    assert.equal(state(observe([]), "extension"), "unknown");
    assert.equal(state(observe([{ name: "remote", state: "connecting" }]), "remote"), "connecting");
    assert.equal(state(observe([{ name: "remote", state: "connected" }]), "remote"), "connected");
    assert.equal(state(observe([{ name: "remote", state: "needs-auth" }]), "remote"), "needs-auth");
    assert.equal(state(observe([{ name: "remote", state: "failed" }]), "remote"), "failed");
    assert.equal(state(observe([{ name: "remote", state: "disconnected" }]), "remote"), "disconnected");
    assert.equal(state(observe([]), "remote"), "unknown");
    assert.equal(state(observe([{ name: "disabled", state: "connected" }]), "disabled"), "unknown");
  });
});

test("MCP status center opens a safe read-only detail without leaking secrets", async () => {
  const snapshot = withConfigs((agent, project) => {
    writeFileSync(join(agent, "mcp.json"), JSON.stringify({ mcpServers: {
      docs: { command: "token-very-secret" },
      blocked: { url: "https://private.invalid", enabled: false },
    } }));
    return buildMcpStatusSnapshot(agent, project, true, [], adapterMcpServers({
      version: 1, servers: [{ name: "docs", state: "connected", token: "token-very-secret" }],
    }));
  });
  const selected: string[] = [];
  const details: string[] = [];
  showMcpStatusDialog({ ui: {
    select(title: string, choices: string[]) {
      selected.push(title, ...choices);
      return Promise.resolve(choices[0]);
    },
    editor(title: string, content = "") {
      details.push(title, content);
      return Promise.resolve(undefined);
    },
    notify() {},
  } }, snapshot);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(selected.join("\n"), /Состояние MCP.*включено: 1 \/ всего: 2/);
  assert.match(selected.join("\n"), /docs.*Подключено/);
  assert.match(selected.join("\n"), /blocked.*Отключено/);
  assert.match(details.join("\n"), /используйте встроенную команду \/mcp/);
  assert.doesNotMatch(JSON.stringify({ selected, details }), /token-very-secret|private.invalid/);
});
