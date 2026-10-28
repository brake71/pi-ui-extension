import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import type { ToolRendererResolver, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { installToolViewController } from "./controller.ts";

const theme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
} as any;

test("reports an actionable compatibility error on Pi without the renderer API", async () => {
  await assert.rejects(
    installToolViewController({} as any, { modeFile: join(tmpdir(), "pi-ui-missing-renderer-test.json") }),
    /Update Pi.*this extension/,
  );
});

test("uses one official renderer resolver without replacing or executing Pi tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tool-renderer-"));
  const handlers = new Map<string, Array<(event: any, ctx: any) => void>>();
  const resolvers: ToolRendererResolver[] = [];
  const commands = new Map<string, any>();
  const counters = { nativeCall: 0, nativeResult: 0, registered: 0 };
  let expanded = false;
  const expandedChanges: boolean[] = [];
  const ctx = {
    mode: "tui",
    cwd: directory,
    sessionManager: { getSessionId: () => "renderer-test" },
    ui: {
      setStatus() {},
      notify() {},
      getToolsExpanded: () => expanded,
      setToolsExpanded(value: boolean) { expanded = value; expandedChanges.push(value); },
    },
  } as any;
  const pi = {
    registerTool() { counters.registered++; throw new Error("Must not shadow Pi tool"); },
    registerToolRenderer(resolver: ToolRendererResolver) { resolvers.push(resolver); },
    registerCommand(name: string, data: any) { commands.set(name, data); },
    registerShortcut() {},
    getCommands: () => [],
    on(name: string, handler: (event: any, ctx: any) => void) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as any;
  const native: ToolRenderers = {
    renderShell: "default",
    renderCall(_args, _theme, context) {
      counters.nativeCall++;
      context.state.seenCall = true;
      return new Text("NATIVE CALL", 0, 0);
    },
    renderResult(_result, _options, _theme, context) {
      counters.nativeResult++;
      assert.equal(context.state.seenCall, true);
      return new Text("NATIVE RESULT", 0, 0);
    },
  };
  const result = { content: [{ type: "text" as const, text: "first\nsecond" }], details: {}, isError: false };
  const render = (renderer: ToolRenderers, state: any, args: any, opts: any = {}) => {
    const context = {
      cwd: directory, state, args, isPartial: false, isError: false,
      expanded: false, outputPad: 1, ...opts,
    } as any;
    const call = renderer.renderCall!(args, theme, context);
    const response = renderer.renderResult!(result, { expanded: context.expanded, isPartial: false }, theme, context);
    return [call.render(120).join("\n"), response.render(120).join("\n")].join("\n");
  };
  try {
    const controller = await installToolViewController(pi, { modeFile: join(directory, "mode.json") });
    assert.equal(resolvers.length, 1);
    assert.equal(counters.registered, 0);
    for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
    const resolver = resolvers[0]!;

    // Do not alter unrelated tools or their renderer definitions.
    assert.strictEqual(resolver("other", () => native), native);
    for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
      assert.equal(resolver(name, () => native)?.renderShell, "self");
    }

    const read = resolver("read", () => native)!;
    const args = { path: "example.ts" };
    const state = {};
    assert.match(render(read, state, args), /  ›  read  example\.ts/);
    assert.match(render(read, state, args), /2 строки/);
    assert.match(render(resolver("bash", () => native)!, {}, { command: "echo ok" }), /  ›  bash  echo ok[\s\S]*    ⎿  2 строки/);
    const styled: Array<{ color: string; value: string }> = [];
    const themeWithSpy = { ...theme, fg(color: string, value: string) {
      styled.push({ color, value });
      return value;
    } };
    const bashRenderer = resolver("bash", () => native)!;
    const bashResult = bashRenderer.renderResult!(result, { isPartial: false, expanded: false }, themeWithSpy, {
      args: { command: "echo ok" }, cwd: directory, state: {}, isError: false,
      isPartial: false, expanded: false, durationMs: 125,
    } as any);
    assert.match(bashResult.render(100).join(""), /^    ⎿  2 строки · 125ms$/);
    assert.ok(styled.some(item => item.color === "dim" && item.value === "125ms"), "direct-tool duration should be muted further");
    const narrowOutput = Array.from({ length: 36 }, (_, i) => i + 1)
      .map(width => ({ width, line: bashResult.render(width).join("") }))
      .find(item => item.line.includes("2 выв."));
    assert.ok(narrowOutput, "direct-tool output count should fall back to out on narrow terminals");
    assert.ok(visibleWidth(narrowOutput.line) <= narrowOutput.width);
    for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
      const argumentsByTool: Record<string, any> = {
        read: { path: "demo.ts" }, bash: { command: "git status" },
        edit: { path: "src/index.ts" }, write: { path: "out.txt", content: "ok" },
        grep: { pattern: "TODO" }, find: { pattern: "*.ts" }, ls: { path: "." },
      };
      const direct = resolver(name, () => native)!;
      const title = direct.renderCall!(argumentsByTool[name], theme, {
        args: argumentsByTool[name], cwd: directory, state: {}, isError: false, isPartial: false, expanded: false,
      } as any);
      assert.match(title.render(90).join(""), new RegExp(`^  ›  ${name}\\b`), `${name} must share the same chevron/title spacing`);
      for (const width of [8, 16, 25, 60]) {
        const lines = title.render(width);
        assert.equal(lines.length, 1, `${name} compact title must remain on one line`);
        assert.ok(visibleWidth(lines[0]!) <= width, `${name} compact title must fit width ${width}`);
      }
    }
    assert.match(render(resolver("write", () => native)!, {}, { path: "file.ts", content: "ok" }), /Сохранено/);
    assert.match(render(resolver("edit", () => native)!, {}, { path: "file.ts" }), /Применено/);
    const empty = resolver("bash", () => native)!;
    const zeroOutput = empty.renderResult!({
      content: [], details: {}, isError: false,
    }, { isPartial: false, expanded: false }, theme, {
      args: { command: "true" }, state: {}, cwd: directory, durationMs: 12,
      isError: false, isPartial: false, expanded: false,
    } as any);
    assert.match(zeroOutput.render(80).join(""), /^    ⎿  12ms$/, "empty output still has one result branch");
    const running = empty.renderResult!({
      content: [], details: {}, isError: false,
    }, { isPartial: true, expanded: false }, theme, {
      args: { command: "sleep 1" }, state: {}, cwd: directory, isPartial: true,
      isError: false, expanded: false,
    } as any);
    assert.match(running.render(80).join(""), /^    ⎿  … Running$/, "streaming uses the same branch without inventing output");
    assert.equal(counters.nativeCall, 0, "compact must not run native renderer unnecessarily");

    await controller.setMode("normal", ctx);
    const normal = render(read, state, args);
    assert.match(normal, /NATIVE CALL/);
    assert.match(normal, /NATIVE RESULT/);
    assert.equal(counters.nativeCall, 1);
    assert.equal(counters.nativeResult, 1);

    await controller.setMode("hidden", ctx);
    const hidden = render(read, state, args);
    assert.equal(hidden, "\n", "hidden mode must produce no visible call or result");
    assert.equal(counters.nativeResult, 2, "finishing a native renderer must release its resources");

    // Skill reads retain their original renderer even in hidden mode.
    assert.match(
      render(read, {}, { path: join(directory, ".pi", "skills", "review", "SKILL.md") }),
      /NATIVE CALL/,
    );
    await controller.setMode("compact", ctx);
    assert.match(render(read, {}, args, { expanded: true }), /NATIVE CALL/);
    assert.match(render(read, {}, args, { expanded: true }), /⌄  /, "expanded native content gets the matching downward chevron");
    assert.match(render(read, {}, args, { isError: true }), /NATIVE CALL/);
    const nextSelf = { ...native, renderShell: "self" as const };
    await controller.setMode("normal", ctx);
    assert.match(render(resolver("read", () => nextSelf)!, {}, args), /NATIVE RESULT/);

    // Exercise the actual Pi transcript component, not only renderer callbacks.
    const { ToolExecutionComponent } = await import(
      "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js"
    );
    const { initTheme } = await import(
      "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"
    );
    initTheme("dark");
    await controller.setMode("compact", ctx);
    const transcript = new ToolExecutionComponent(
      "read", "renderer-call", args, {}, read, { requestRender() {} } as any, directory,
    );
    transcript.updateResult(result, false);
    const plain = (lines: string[]) => lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
    assert.match(plain(transcript.render(100)), /  ›  read  example\.ts/);
    function clickToolHeading(marker: string) {
      const lines = transcript.render(100).map(line => line.replace(/\u001b\[[0-9;]*m/g, ""));
      const row = lines.findIndex(line => line.includes(marker));
      assert.ok(row >= 0, `missing clickable tool title: ${marker}`);
      const result = transcript.handleMouse({
        type: "click", button: "left", x: 5, y: row,
        screenX: 5, screenY: row, width: 100, height: lines.length,
      } as any);
      assert.equal(result?.handled, true, "native Pi tool expansion must remain clickable");
    }
    clickToolHeading("›  read");
    assert.match(plain(transcript.render(100)), /⌄  /, "expanded mode uses a downward chevron");
    assert.match(plain(transcript.render(100)), /NATIVE CALL/, "native detail is still visible when expanded");
    assert.match(plain(transcript.render(100)), /NATIVE RESULT/);
    clickToolHeading("⌄  ");
    assert.match(plain(transcript.render(100)), /›  read/, "click again collapses the tool");

    for (const [toolName, toolArgs] of [
      ["bash", { command: "pwd" }],
      ["edit", { path: "src/index.ts" }],
      ["write", { path: "out.txt", content: "updated" }],
      ["grep", { pattern: "TODO" }],
      ["find", { pattern: "*.ts" }],
      ["ls", { path: "." }],
    ] as const) {
      const renderer = resolver(toolName, () => native)!;
      const instance = new ToolExecutionComponent(
        toolName, `call-${toolName}`, toolArgs, {}, renderer, { requestRender() {} } as any, directory,
      );
      instance.updateResult({ ...result, durationMs: 48 }, false);
      const view = () => plain(instance.render(80));
      assert.match(view(), new RegExp(`  ›  ${toolName}\\b`), `${toolName} compact heading`);
      const lines = view().split("\n");
      const headerRow = lines.findIndex(line => line.includes(`›  ${toolName}`));
      assert.ok(headerRow >= 0);
      const clickResult = instance.handleMouse({
        type: "click", button: "left", x: 4, y: headerRow,
        screenX: 4, screenY: headerRow, width: 80, height: lines.length,
      } as any);
      assert.equal(clickResult?.handled, true, `${toolName} expansion should work`);
      assert.match(view(), /⌄  /, `${toolName} expanded native header`);
      assert.match(view(), /NATIVE RESULT/, `${toolName} native result remains available`);
      const expandedLines = view().split("\n");
      const expandedRow = expandedLines.findIndex(line => line.includes("⌄  "));
      assert.ok(expandedRow >= 0);
      instance.handleMouse({
        type: "click", button: "left", x: 4, y: expandedRow,
        screenX: 4, screenY: expandedRow, width: 80, height: expandedLines.length,
      } as any);
      assert.match(view(), new RegExp(`  ›  ${toolName}\\b`), `${toolName} should collapse again`);
    }

    const write = resolver("write", () => native)!;
    const failedWrite = new ToolExecutionComponent(
      "write", "failed-write", { path: "out.txt", content: "secret" }, {},
      write, { requestRender() {} } as any, directory,
    );
    failedWrite.updateResult({
      content: [{ type: "text", text: "Could not save" }], isError: true, durationMs: 25,
    }, false);
    assert.match(plain(failedWrite.render(100)), /NATIVE RESULT/, "failed tool uses native error details");
    assert.doesNotMatch(plain(failedWrite.render(100)), /✓  Сохранено/, "failure must not report a saved result");
    await controller.setMode("hidden", ctx);
    transcript.setExpanded(false);
    assert.deepEqual(transcript.render(100), [], "hidden mode should remove the complete transcript row");
    await controller.setMode("normal", ctx);
    transcript.setExpanded(false);
    assert.match(plain(transcript.render(100)), /NATIVE CALL/);

    await controller.setMode("compact", ctx);
    assert.deepEqual(JSON.parse(await readFile(join(directory, "mode.json"), "utf8")), { mode: "compact" });
    assert.equal(expandedChanges.length, 16, "every mode change should refresh historical transcript rows");
    assert.equal(commands.has("tool-view"), true);
    assert.equal(counters.registered, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
