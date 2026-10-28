import assert from "node:assert/strict";
import test from "node:test";
import { mcpResourceEntriesFromConfig, mcpResourceEntriesFromStatus, mergeMcpResourceEntries } from "./resources.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("discovers global and trusted project MCP configs without exposing secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-resource-"));
  const agent = join(root, "agent"), cwd = join(root, "project");
  mkdirSync(agent); mkdirSync(join(cwd, ".pi"), { recursive: true });
  try {
    writeFileSync(join(agent, "mcp.json"), JSON.stringify({ mcpServers: {
      context7: { url: "https://secret.invalid", headers: { Authorization: "secret" } },
      disabled: { disabled: true },
    } }));
    writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { "chrome-devtools": { command: "secret" } } }));
    const untrusted = mcpResourceEntriesFromConfig(agent, cwd, false);
    assert.deepEqual(untrusted.map(x => x.name), ["context7"]);
    const trusted = mcpResourceEntriesFromConfig(agent, cwd, true);
    assert.deepEqual(trusted.map(x => x.name), ["context7", "chrome-devtools"]);
    assert.doesNotMatch(JSON.stringify(trusted), /secret/);
    assert.deepEqual(mergeMcpResourceEntries(trusted, mcpResourceEntriesFromStatus({ version: 1, servers: [{ name: "context7" }] }))
      .map(x => x.description), ["Сервер MCP загружен в текущем сеансе Pi", "Сервер MCP настроен, соединение не проверено"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("builds MCP resource rows from the adapter status snapshot", () => {
  assert.deepEqual(
    mcpResourceEntriesFromStatus({
      version: 1,
      servers: [
        { name: "context7", disabled: false },
        { name: "chrome-devtools", disabled: false },
        { name: "disabled-server", disabled: true },
        { name: "context7", disabled: false },
      ],
    }),
    [
      { name: "context7", description: "Сервер MCP загружен в текущем сеансе Pi" },
      { name: "chrome-devtools", description: "Сервер MCP загружен в текущем сеансе Pi" }
    ],
  );
});

test("rejects malformed MCP status snapshots", () => {
  assert.deepEqual(mcpResourceEntriesFromStatus(undefined), []);
  assert.deepEqual(mcpResourceEntriesFromStatus({ version: 2, servers: [] }), []);
  assert.deepEqual(mcpResourceEntriesFromStatus({ version: 1, servers: "context7" }), []);
});
