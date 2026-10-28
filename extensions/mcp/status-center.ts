import { readFileSync } from "node:fs";
import { join } from "node:path";

export type McpConnectionState =
  | "unknown" | "connecting" | "connected" | "disconnected" | "needs-auth" | "failed";
export type McpStatusSource = "global" | "project" | "project override" | "extension" | "adapter";
export type McpServerStatus = {
  readonly name: string;
  readonly source: McpStatusSource;
  readonly enabled: boolean;
  readonly loaded: boolean;
  /** Only an explicit runtime observation can establish connection state. */
  readonly connection: McpConnectionState;
};
export type McpStatusSnapshot = {
  readonly servers: readonly McpServerStatus[];
  readonly warnings: readonly string[];
};

type ConfigServer = { name: string; source: McpStatusSource; enabled: boolean };
type ParsedConfig = { servers: Map<string, Record<string, unknown>> };
type RuntimeServer = { name: string; enabled: boolean; state: McpConnectionState };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Pi MCP names are deliberately constrained; never render arbitrary terminal input from events. */
function serverName(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value) ? value : undefined;
}

function isEnabled(config: Record<string, unknown>): boolean {
  // Pi uses enabled:false. Disabled:true is accepted for older adapter configs.
  return config.enabled !== false && config.disabled !== true;
}

function readConfig(path: string, warnings: string[], scope: "global" | "project"): ParsedConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`Cannot read ${scope} MCP configuration`);
    return { servers: new Map() };
  }
  try {
    const config = record(JSON.parse(raw));
    if (!config) throw new Error("invalid configuration shape");
    const servers = config.mcpServers === undefined ? {} : record(config.mcpServers);
    if (!servers) throw new Error("invalid server map");
    const entries = new Map<string, Record<string, unknown>>();
    for (const [name, value] of Object.entries(servers)) {
      const server = record(value);
      if (!serverName(name) || !server) {
        warnings.push(`Invalid server entry in ${scope} MCP configuration`);
        continue;
      }
      entries.set(name, server);
    }
    return { servers: entries };
  } catch {
    // Never include JSON contents, URLs, command lines, headers or parser excerpts.
    warnings.push(`Invalid ${scope} MCP configuration`);
    return { servers: new Map() };
  }
}

/** Read native Pi global/project MCP configuration without touching credentials or transports. */
export function configuredMcpServers(
  agentDir: string, cwd: string, trusted: boolean,
): { readonly servers: readonly ConfigServer[]; readonly warnings: readonly string[] } {
  const warnings: string[] = [];
  const global = readConfig(join(agentDir, "mcp.json"), warnings, "global");
  const entries = new Map<string, ConfigServer>();
  for (const [name, value] of global.servers) {
    entries.set(name, { name, source: "global", enabled: isEnabled(value) });
  }
  if (trusted) {
    const project = readConfig(join(cwd, ".pi", "mcp.json"), warnings, "project");
    for (const [name, value] of project.servers) {
      const overridesGlobal = entries.has(name) &&
        !("command" in value || "url" in value || "type" in value);
      const previous = entries.get(name);
      // Pi permits project-only enabled/exposure overrides of global servers.
      entries.set(name, {
        name,
        source: overridesGlobal ? "project override" : "project",
        enabled: overridesGlobal && value.enabled === undefined && value.disabled === undefined
          ? previous!.enabled : isEnabled(value),
      });
    }
  }
  return { servers: [...entries.values()], warnings };
}

/** Extract extension-registered MCP names. Registration does not prove connection. */
export function registeredMcpServers(value: unknown): readonly RuntimeServer[] {
  if (!Array.isArray(value)) return [];
  const rows = new Map<string, RuntimeServer>();
  for (const item of value) {
    const server = record(item);
    const name = serverName(server?.name);
    const config = record(server?.config);
    if (name && config) rows.set(name, { name, enabled: isEnabled(config), state: "unknown" });
  }
  return [...rows.values()];
}

/** Adapter v1 snapshots are observations, not an authoritative native Pi state API. */
export function adapterMcpServers(snapshot: unknown): readonly RuntimeServer[] | undefined {
  const value = record(snapshot);
  if (value?.version !== 1 || !Array.isArray(value.servers)) return undefined;
  const rows = new Map<string, RuntimeServer>();
  for (const entry of value.servers) {
    const server = record(entry);
    const name = serverName(server?.name);
    if (!name) continue;
    const explicit = server?.state ?? server?.status;
    const state: McpConnectionState =
      explicit === "connected" || explicit === "connecting" ||
      explicit === "disconnected" || explicit === "needs-auth" || explicit === "failed"
        ? explicit
        : server?.connected === true ? "connected"
          : server?.connected === false ? "disconnected" : "unknown";
    rows.set(name, { name, enabled: isEnabled(server!), state });
  }
  return [...rows.values()];
}

export function buildMcpStatusSnapshot(
  agentDir: string,
  cwd: string,
  trusted: boolean,
  registered: unknown,
  adapter: readonly RuntimeServer[] = [],
): McpStatusSnapshot {
  const config = configuredMcpServers(agentDir, cwd, trusted);
  const rows = new Map<string, McpServerStatus>();
  for (const server of config.servers) {
    rows.set(server.name, { ...server, loaded: false, connection: "unknown" });
  }
  for (const server of registeredMcpServers(registered)) {
    if (!rows.has(server.name)) {
      rows.set(server.name, { name: server.name, source: "extension", enabled: server.enabled, loaded: false, connection: "unknown" });
    }
  }
  for (const server of adapter) {
    const configured = rows.get(server.name);
    if (configured) {
      // An explicit project disable must not be overwritten by an adapter's stale snapshot.
      rows.set(server.name, {
        ...configured,
        loaded: server.enabled && configured.enabled,
        connection: server.enabled && configured.enabled ? server.state : "unknown",
      });
    } else {
      rows.set(server.name, {
        name: server.name, source: "adapter", enabled: server.enabled,
        loaded: server.enabled, connection: server.enabled ? server.state : "unknown",
      });
    }
  }
  return { servers: [...rows.values()], warnings: config.warnings };
}

export function describeMcpStatus(server: McpServerStatus): string {
  const state = !server.enabled ? "Отключено"
    : server.connection === "connected" ? "Подключено (статус адаптера)"
      : server.connection === "connecting" ? "Подключение (статус адаптера)"
        : server.connection === "disconnected" ? "Отключено (статус адаптера)"
          : server.connection === "needs-auth" ? "Требуется вход (статус адаптера)"
            : server.connection === "failed" ? "Ошибка (статус адаптера)"
              : server.loaded ? "Загружено (соединение не проверено)"
                : server.source === "extension" ? "Зарегистрировано (соединение не проверено)"
                  : "Настроено (соединение не проверено)";
  return `${state} · ${server.source}`;
}
