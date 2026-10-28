import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import piUiExtension from "../index.ts";
import { createActiveSessionLease } from "./safety.ts";

test("bulk cleanup rechecks active leases and files changed during confirmation", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-ui-bulk-cleanup-"));
  const directory = join(root, "sessions");
  const activeLeaseDir = join(getAgentDir(), "pi-ui-extension", "active-sessions");
  const otherInstance = createActiveSessionLease(activeLeaseDir);
  const makeSession = (title: string) => {
    const manager = SessionManager.create(root, directory);
    manager.appendMessage({ role: "user", timestamp: Date.now(), content: [{ type: "text", text: title }] });
    return manager;
  };
  const active = makeSession("current");
  const changed = makeSession("changed while confirming");
  const otherActive = makeSession("other Pi instance");
  const unchanged = makeSession("safe to trash");
  const recentlyModified = makeSession("recent activity");
  const old = new Date(Date.now() - 3600_000);
  for (const manager of [changed, otherActive, unchanged]) {
    utimesSync(manager.getSessionFile()!, old, old);
  }

  const events = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const moves: string[] = [];
  const notices: string[] = [];
  const pi: any = {
    registerToolRenderer() {}, registerShortcut() {},
    registerCommand(name: string, command: any) { commands.set(name, command); },
    getCommands: () => [], getActiveTools: () => [], getAllTools: () => [],
    getMcpServers: () => [], getThinkingLevel: () => "off",
    registerMarkdownTransformer() {}, getSettings: () => ({}),
    events: { on: () => () => {} },
    on(name: string, callback: (event: any, ctx: any) => unknown) {
      events.set(name, [...(events.get(name) ?? []), callback]);
    },
    async exec(command: string, args: string[]) {
      if (command === "powershell.exe") {
        const script = Buffer.from(args[4]!, "base64").toString("utf16le");
        const encodedPath = script.match(/DeleteFile\('((?:''|[^'])*)'/)?.[1];
        assert.ok(encodedPath, "PowerShell recycle command includes the target path");
        moves.push(encodedPath.replace(/''/g, "'"));
      } else moves.push(args[0]!);
      return { code: 0, stderr: "" };
    },
  };
  const ctx: any = {
    mode: "rpc", cwd: root, isIdle: () => true, isProjectTrusted: () => true,
    getSystemPrompt: () => "", getContextUsage: () => undefined,
    sessionManager: active,
    ui: {
      notify(message: string) { notices.push(message); },
      setStatus() {},
      async confirm() {
        // A running second Pi becomes active, and another historical session
        // changes while this confirmation modal is still open.
        otherInstance.update(otherActive.getSessionId(), otherActive.getSessionFile());
        appendFileSync(changed.getSessionFile()!, JSON.stringify({ type: "message", message: { role: "user" } }) + "\n");
        return true;
      },
    },
  };
  const emit = async (name: string) => {
    for (const callback of events.get(name) ?? []) await callback({}, ctx);
  };
  try {
    await piUiExtension(pi);
    await emit("session_start");
    await commands.get("sidebar-session-clear-others")!.handler("", ctx);
    assert.deepEqual(new Set(moves), new Set([unchanged.getSessionFile(), recentlyModified.getSessionFile()]));
    assert.match(notices.join("\n"), /защищены\/изменены\): 2/);
    assert.ok(!moves.includes(active.getSessionFile()!));
    assert.ok(moves.includes(recentlyModified.getSessionFile()!), "recent historical sessions are now eligible");
  } finally {
    await emit("session_shutdown");
    otherInstance.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
