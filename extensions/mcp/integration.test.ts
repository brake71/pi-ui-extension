import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import piUiExtension from "../index.ts";

test("entry wires early/late MCP status into restored and live usage without double counting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-ui-mcp-"));
  const handlers = new Map<string, any[]>(), bus = new Map<string, any>();
  const listeners = new Set<any>();
  let branch: any[] = [], footer: any;
  let idle = true;
  const commands = new Map<string, any>(), notices: string[] = [];
  let registrations: any[] = [{ name: "native_mcp", config: { command: "not-executed" }, extensionPath: "/extension.ts" }];
  const tui: any = {
    [Symbol.for("@earendil-works/pi-tui/viewport")]: true,
    terminal: { columns: 240, rows: 100 }, layoutRoot: { render: () => [], invalidate() {} }, inputListeners: listeners,
    addInputListener(fn: any) { listeners.add(fn); return () => listeners.delete(fn); },
    requestRender() {}, setLayoutRoot(root: any) { this.layoutRoot = root; },
  };
  const theme: any = { fg: (_: string, text: string) => text, bold: (text: string) => text };
  const pi: any = {
    registerTool() { throw new Error("Tool View must not register tools"); }, registerToolRenderer() {}, registerCommand(name: string, options: any) { commands.set(name, options); }, registerShortcut() {},
    getCommands: () => [], getActiveTools: () => [], getAllTools: () => [], getThinkingLevel: () => "off",
    getMcpServers: () => registrations,
    on(name: string, fn: any) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
    events: { on(name: string, fn: any) { bus.set(name, fn); return () => bus.delete(name); } },
  };
  const ctx: any = {
    mode: "tui", cwd: directory, isIdle: () => idle, isProjectTrusted: () => true, getSystemPrompt: () => "", getContextUsage: () => undefined,
    sessionManager: { getBranch: () => branch, buildContextEntries: () => [], getSessionId: () => "test", getSessionDir: () => directory },
    ui: { setStatus() {}, notify(message: string) { notices.push(message); }, setFooter(factory: any) { footer?.dispose(); footer = factory?.(tui, theme, { onBranchChange: () => () => {}, getGitBranch: () => null }); } },
  };
  const emit = async (name: string, event: any = {}) => { for (const fn of handlers.get(name) ?? []) await fn(event, ctx); };
  const status = (names: string[]) => bus.get("pi-mcp-adapter/status/v1")({ version: 1, servers: names.map(name => ({ name })) });
  const details = (server: string) => ({ mode: "script", calls: [{ operation: "call", path: `${server}_ping`, ok: true }] });
  const saved = (server: string, id = `saved-${server}`) => ({ type: "message", message: { role: "toolResult", toolCallId: id, toolName: "mcpScript", details: details(server) } });
  const output = () => renderLayoutFrame(tui.layoutRoot, 240, 100, () => {}).lines.join("\n");
  const expandToolView = () => {
    const layout = renderLayoutFrame(tui.layoutRoot, 240, 100, () => {});
    tui.currentLayout = layout;
    const wrappers = (box: any): any[] => [
      ...(box.component?.constructor.name === "CollapsiblePanel" ? [box] : []),
      ...(box.children ?? []).flatMap(wrappers),
    ];
    const box = wrappers(layout.root)[2];
    assert.ok(box, "Tool View collapsible panel is mounted");
    box.component.toggle();
  };
  try {
    await piUiExtension(pi);
    status(["early"]);
    branch = [saved("early")];
    await emit("session_start");
    expandToolView();
    assert.match(output(), /early\s+0\/1/);
    await emit("before_agent_start", { messageType: "user", prompt: "first", systemPromptOptions: {} });
    branch.push({ type: "message", message: { role: "toolResult", toolCallId: "native-1", toolName: "mcp__native_mcp__ping", details: {} } });
    await emit("tool_execution_end", { toolCallId: "native-1", toolName: "mcp__native_mcp__ping", isError: false, result: { details: {} } });
    assert.match(output(), /native_mcp\s+1\/1/);
    // Pi 1.2 also sends before_agent_start for custom-triggered runs.
    // A new run resets exchange counts but preserves saved session totals.
    idle = false; // Starting a run is already busy inside this event in Pi 1.2.
    await emit("before_agent_start", {
      messageType: "custom",
      message: { customType: "automation", content: "continue", display: false },
      systemPromptOptions: {},
    });
    assert.match(output(), /native_mcp\s+0\/1/);
    await commands.get("sessions-manager").handler("", ctx);
    assert.match(notices.join("\n"), /Дождитесь завершения текущего запуска/);
    await emit("before_agent_start", { messageType: "user", prompt: "next", systemPromptOptions: {} });
    assert.match(output(), /native_mcp\s+0\/1/);
    idle = true;
    registrations = [];
    await emit("mcp_servers_change", { servers: [] });
    assert.doesNotMatch(output(), /native_mcp\s+1\/1/);
    branch.push(saved("late", "call-1"));
    await emit("tool_execution_end", { toolCallId: "call-1", toolName: "mcpScript", isError: false, result: { details: details("late") } });
    assert.doesNotMatch(output(), /late\s+1\/1/);
    status(["early", "late"]);
    assert.match(output(), /late\s+1\/1/);
    status(["early", "late"]);
    assert.match(output(), /late\s+1\/1/);
    branch.push(saved("late", "call-2"));
    await emit("tool_execution_end", { toolCallId: "call-2", toolName: "mcpScript", isError: false, result: { details: details("late") } });
    assert.match(output(), /late\s+2\/2/);
    branch = [saved("early")];
    await emit("session_tree");
    assert.match(output(), /early\s+0\/1/);
    assert.doesNotMatch(output(), /late\s+2\/2/);
    // A new session cannot inherit the previous session's adapter state.
    await emit("session_start", { reason: "reload" });
    assert.doesNotMatch(output(), /early\s+0\/1/);
    expandToolView();
    status(["early"]);
    assert.match(output(), /early\s+0\/1/);
  } finally {
    await emit("session_shutdown");
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(bus.size, 0);
  assert.equal(listeners.size, 0);
});
