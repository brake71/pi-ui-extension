import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import piUiExtension from "../index.ts";

test("single-session delete rejects same-size rewrites with restored mtime, but trashes unchanged files", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-ui-single-delete-"));
  const directory = join(root, "sessions");
  const make = (content: string) => {
    const session = SessionManager.create(root, directory);
    session.appendMessage({ role: "user", content, timestamp: Date.now() });
    return session;
  };
  const active = make("current");
  const changed = make("AAAAAAAA");
  const unchanged = make("untouched");
  const changedPath = changed.getSessionFile()!;
  const unchangedPath = unchanged.getSessionFile()!;
  const fixed = new Date("2024-01-01T00:00:00.000Z");
  utimesSync(changedPath, fixed, fixed);
  const before = statSync(changedPath);
  const events = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const moved: string[] = [];
  const notices: string[] = [];
  let onConfirm: (() => void) | undefined;
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
    async exec(_command: string, args: string[]) {
      moved.push(args[0]!);
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
      async confirm() { onConfirm?.(); return true; },
    },
  };
  const emit = async (name: string) => {
    for (const callback of events.get(name) ?? []) await callback({}, ctx);
  };
  try {
    await piUiExtension(pi);
    await emit("session_start");
    onConfirm = () => {
      const original = readFileSync(changedPath, "utf8");
      assert.ok(original.includes("AAAAAAAA"));
      writeFileSync(changedPath, original.replace("AAAAAAAA", "BBBBBBBB"));
      utimesSync(changedPath, fixed, fixed);
    };
    await commands.get("sidebar-session-delete")!.handler(changed.getSessionId(), ctx);
    assert.equal(statSync(changedPath).size, before.size);
    assert.equal(statSync(changedPath).mtimeMs, before.mtimeMs);
    assert.ok(!moved.includes(changedPath), "a ctime-only change must block deletion");
    assert.match(notices.join("\n"), /изменилась во время подтверждения/);

    onConfirm = undefined;
    await commands.get("sidebar-session-delete")!.handler(unchanged.getSessionId(), ctx);
    assert.deepEqual(moved, [unchangedPath], "unchanged saved sessions remain deletable");
  } finally {
    await emit("session_shutdown");
    rmSync(root, { recursive: true, force: true });
  }
});
