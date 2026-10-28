import { adapterMcpServers, configuredMcpServers } from "./status-center.ts";

export type McpResourceEntry = {
  readonly name: string;
  readonly description: string;
};

export function mcpResourceEntriesFromConfig(agentDir: string, cwd: string, trusted: boolean): readonly McpResourceEntry[] {
  return configuredMcpServers(agentDir, cwd, trusted).servers
    .filter((server) => server.enabled)
    .map(({ name }) => ({ name, description: "Сервер MCP настроен, соединение не проверено" }));
}

export function mergeMcpResourceEntries(configured: readonly McpResourceEntry[], live: readonly McpResourceEntry[]): readonly McpResourceEntry[] {
  const rows = new Map(configured.map((entry) => [entry.name, entry]));
  for (const entry of live) rows.set(entry.name, entry);
  return [...rows.values()];
}

/** Convert the adapter's read-only status snapshot into configured, enabled MCP rows. */
export function mcpResourceEntriesFromStatus(value: unknown): readonly McpResourceEntry[] {
  return (adapterMcpServers(value) ?? [])
    .filter((server) => server.enabled)
    .map(({ name }) => ({ name, description: "Сервер MCP загружен в текущем сеансе Pi" }));
}
