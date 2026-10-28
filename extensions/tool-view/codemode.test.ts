import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ToolRendererResolver, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { installToolViewController } from "./controller.ts";

const privateCode = "const apiKey = 'DO_NOT_DISPLAY';\ntext(await tools.search({ token: apiKey }));";
const secretOutput = "PRIVATE_OUTPUT_TEXT";
const privateArgs = '{"token":"PRIVATE_NESTED_ARGS"}';
const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");

test("Codemode uses compact summaries until clicked, native details when expanded, and no row in Hidden", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codemode-view-"));
  const renderers: ToolRendererResolver[] = [];
  const callbacks = new Map<string, Array<(event: any, ctx: any) => void>>();
  let registered = 0;
  let expanded = false;
  const expansions: boolean[] = [];
  const ui = {
    setStatus() {},
    notify() {},
    getToolsExpanded: () => expanded,
    setToolsExpanded(next: boolean) { expanded = next; expansions.push(next); },
  };
  const ctx = { mode: "tui", ui, sessionManager: { getSessionId: () => "session" }, cwd: directory } as any;
  const pi = {
    registerTool() { registered++; throw new Error("Tool execution must remain with Pi"); },
    registerToolRenderer(resolver: ToolRendererResolver) { renderers.push(resolver); },
    registerCommand() {},
    registerShortcut() {},
    getCommands: () => [],
    on(event: string, cb: (event: any, ctx: any) => void) {
      callbacks.set(event, [...(callbacks.get(event) ?? []), cb]);
    },
  } as any;
  try {
    const controller = await installToolViewController(pi, { modeFile: join(directory, "mode.json") });
    assert.equal(renderers.length, 1);
    assert.equal(registered, 0);
    for (const callback of callbacks.get("session_start") ?? []) callback({}, ctx);

    const { codemodeRenderers } = await import(
      "../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/renderer.js"
    );
    const { initTheme } = await import(
      "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"
    );
    const { ToolExecutionComponent } = await import(
      "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js"
    );
    initTheme("dark");
    const resolver = renderers[0]!;
    const native: ToolRenderers = { ...codemodeRenderers };
    assert.strictEqual(resolver("custom_tool", () => native), native);
    const renderer = resolver("codemode", () => native)!;
    assert.equal(renderer.renderShell, "self");

    const result = {
      content: [
        { type: "text" as const, text: "Script completed\nWall time 1.2 seconds\nOutput:\n" },
        { type: "text" as const, text: secretOutput + "\nresult" },
        { type: "image" as const, data: "abc", mimeType: "image/png" },
      ],
      details: {
        calls: [
          { id: "x/1", name: "search", args: privateArgs, status: "ok", durationMs: 200 },
          { id: "x/2", name: "write", args: privateArgs, status: "error", error: secretOutput, durationMs: 350 },
          { id: "x/3", name: "read", args: privateArgs, status: "cancelled", durationMs: 50 },
        ],
      },
      isError: false,
      durationMs: 1250,
    };
    const transcript = new ToolExecutionComponent(
      "codemode", "call", { code: privateCode }, {}, renderer, { requestRender() {} } as any, directory,
    );
    transcript.updateResult(result, false);
    const visible = () => stripAnsi(transcript.render(110).join("\n"));

    // Default compact mode summarizes metadata, hiding executable code and nested arguments.
    assert.match(visible(), /  ›  codemode\b/);
    assert.doesNotMatch(visible(), /code lines|Code: \?/, "collapsed Codemode must not show code line counts");
    assert.match(visible(), /3 вызова/);
    assert.match(visible(), /1 успешн\./);
    assert.match(visible(), /1 ошибок/);
    assert.match(visible(), /1 отменено/);
    assert.match(visible(), /2 строки/);
    assert.match(visible(), /1 изображение/);
    assert.match(visible(), /1.3s/);
    assert.doesNotMatch(visible(), /✓/, "Compact must omit redundant green success checkmarks");
    assert.match(visible(), /! Частично/, "successful parent with failed nested calls is not marked fully successful");
    assert.doesNotMatch(visible(), /[\u3400-\u9fff]/, "Compact labels must be English-only");
    assert.doesNotMatch(visible(), /DO_NOT_DISPLAY|PRIVATE_OUTPUT_TEXT|PRIVATE_NESTED_ARGS/);
    const clickTitle = (marker: string, width = 110) => {
      const lines = transcript.render(width).map(line => stripAnsi(line));
      const y = lines.findIndex(line => line.includes(marker));
      assert.ok(y >= 0, `missing clickable Codemode title: ${marker}`);
      const clicked = transcript.handleMouse({
        type: "click", button: "left", x: 5, y, screenX: 5,
        screenY: y, width, height: lines.length,
      } as any);
      assert.equal(clicked?.handled, true, "native Pi tool click must toggle the Codemode row");
    };
    clickTitle("›  codemode");
    assert.match(visible(), /⌄  /, "expanded Codemode has the same down chevron as direct tools");
    assert.match(visible(), /DO_NOT_DISPLAY/, "expanded Codemode shows its native script");
    assert.match(visible(), /PRIVATE_OUTPUT_TEXT/, "expanded Codemode shows its native output");
    assert.match(visible(), /PRIVATE_NESTED_ARGS/, "expanded Codemode shows nested tool details");
    assert.doesNotMatch(visible(), /⎿\s*! Partial/, "native expanded details must replace, not duplicate, the compact result row");
    for (const width of [20, 40, 80, 110]) {
      const rendered = transcript.render(width);
      assert.ok(rendered.length > 2, `native expanded output should have multiple rows at ${width}`);
      for (const line of rendered) {
        assert.ok(visibleWidth(line) <= width, `expanded Codemode overflow at ${width}`);
      }
    }
    clickTitle("⌄  ");
    assert.match(visible(), /›  codemode/, "click again collapses the row");
    assert.doesNotMatch(visible(), /DO_NOT_DISPLAY|PRIVATE_OUTPUT_TEXT|PRIVATE_NESTED_ARGS/);

    await controller.setMode("normal", ctx);
    transcript.setExpanded(true);
    assert.match(visible(), /DO_NOT_DISPLAY/);
    assert.match(visible(), /PRIVATE_OUTPUT_TEXT/);
    assert.match(visible(), /PRIVATE_NESTED_ARGS/);

    await controller.setMode("hidden", ctx);
    transcript.setExpanded(false);
    assert.deepEqual(transcript.render(110), []);
    transcript.setExpanded(true);
    assert.deepEqual(transcript.render(110), []);

    await controller.setMode("compact", ctx);
    transcript.setExpanded(false);
    assert.match(visible(), /3 вызова/);

    // The in-progress callback is a metadata-only summary as well.
    transcript.updateResult({
      content: [], details: {
        calls: [
          { id: "y/1", name: "search", args: privateArgs, status: "ok" },
          { id: "y/2", name: "read", args: privateArgs, status: "running" },
        ],
      }, isError: false,
    }, true);
    assert.match(visible(), /Выполняется/);
    assert.match(visible(), /1 выполняется/);
    assert.doesNotMatch(visible(), /DO_NOT_DISPLAY|PRIVATE_NESTED_ARGS/);
    clickTitle("›  codemode");
    assert.match(visible(), /⌄  /);
    assert.match(visible(), /DO_NOT_DISPLAY/, "can inspect Codemode while it is still streaming");
    assert.match(visible(), /PRIVATE_NESTED_ARGS/, "running native nested calls are available on demand");
    clickTitle("⌄  ");
    assert.match(visible(), /… Выполняется/);
    assert.doesNotMatch(visible(), /PRIVATE_NESTED_ARGS/);

    transcript.updateResult({
      content: [{ type: "text", text: secretOutput }],
      details: { calls: [{ id: "z/1", name: "write", args: privateArgs, status: "error", error: secretOutput }] },
      isError: true,
      durationMs: 400,
    }, false);
    assert.match(visible(), /✗ Ошибка/);
    assert.match(visible(), /1 ошибок/);
    assert.match(visible(), /400ms/);
    assert.doesNotMatch(visible(), /DO_NOT_DISPLAY|PRIVATE_OUTPUT_TEXT|PRIVATE_NESTED_ARGS/);
    clickTitle("›  codemode");
    assert.match(visible(), /⌄  /);
    assert.match(visible(), /DO_NOT_DISPLAY/);
    assert.match(visible(), /PRIVATE_OUTPUT_TEXT/);
    clickTitle("⌄  ");
    assert.doesNotMatch(visible(), /DO_NOT_DISPLAY|PRIVATE_OUTPUT_TEXT|PRIVATE_NESTED_ARGS/);
    assert.equal(expansions.length, 6, "mode switching requests transcript refresh");
    assert.equal(registered, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("one Thinking followed by multiple codemode calls preserves independent tool rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codemode-multiple-"));
  let resolver: ToolRendererResolver | undefined;
  const pi = {
    registerToolRenderer(cb: ToolRendererResolver) { resolver = cb; },
    registerCommand() {}, registerShortcut() {}, on() {},
  } as any;
  try {
    await installToolViewController(pi, { modeFile: join(directory, "mode.json") });
    const { initTheme, getMarkdownTheme } = await import(
      "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"
    );
    const { AssistantMessageComponent } = await import(
      "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/assistant-message.js"
    );
    const { ToolExecutionComponent } = await import(
      "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js"
    );
    const { transformThinkingText } = await import("./thinking.ts");
    initTheme("dark");
    const thinking = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), "Thinking...", 1, [
      (text, ctx) => transformThinkingText(text, ctx, "compact", () => ({
        phase: "complete", duration: { ms: 3000, approximate: false },
      })),
    ]);
    thinking.updateContent({
      role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "Private reasoning" }],
    } as any, false);

    const tool = resolver!("codemode", () => ({}))!;
    const first = new ToolExecutionComponent(
      "codemode", "first", { code: "text('a')" }, {}, tool, { requestRender() {} } as any, directory,
    );
    const second = new ToolExecutionComponent(
      "codemode", "second", { code: "text('b')\ntext('c')" }, {}, tool, { requestRender() {} } as any, directory,
    );
    first.updateResult({
      content: [{ type: "text", text: "one" }],
      details: { calls: [{ status: "ok" }] }, durationMs: 225, isError: false,
    } as any, false);
    second.updateResult({
      content: [{ type: "text", text: "one\ntwo\nthree" }],
      details: { calls: [{ status: "ok" }, { status: "ok" }] }, durationMs: 1900, isError: false,
    } as any, false);
    const combined = [thinking, first, second].map((c) => stripAnsi(c.render(110).join("\n"))).join("\n");
    assert.equal((combined.match(/\+ Размышление · 3\.0s/g) ?? []).length, 1);
    assert.equal((combined.match(/  ›  codemode/g) ?? []).length, 2);
    assert.match(combined, /1 вызов · 1 успешн\./);
    assert.match(combined, /2 вызова · 2 успешн\./);
    assert.match(combined, /1 строка · 225ms/);
    assert.match(combined, /3 строки · 1.9s/);
    assert.doesNotMatch(combined, /⎿\s*✓/, "success rows should contain data without a checkmark");
    assert.doesNotMatch(combined, /✓ Done|Private reasoning|text\('a'\)|text\('b'\)/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codemode Compact estimates live elapsed time and stops ticking after completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codemode-ticking-"));
  let resolver: ToolRendererResolver | undefined;
  const pi = {
    registerToolRenderer(callback: ToolRendererResolver) { resolver = callback; },
    registerCommand() {}, registerShortcut() {}, on() {},
  } as any;
  try {
    await installToolViewController(pi, { modeFile: join(directory, "mode.json") });
    const renderer = resolver!("codemode", () => ({}))!;
    const theme = { fg: (_: string, value: string) => value, bold: (value: string) => value } as any;
    let invalidations = 0;
    const context = {
      args: { code: "text('x')" }, state: {}, isError: false,
      durationMs: undefined, invalidate: () => { invalidations++; },
    } as any;

    const partial = renderer.renderResult!(
      { content: [], details: { calls: [{ status: "running" }] } },
      { isPartial: true, expanded: false }, theme, context,
    );
    assert.match(partial.render(100).join(""), /~\d+ms/);
    await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
    assert.ok(invalidations >= 1, "live row must request a redraw");
    assert.match(partial.render(100).join(""), /~1\.\ds/);

    context.durationMs = 1_500;
    const done = renderer.renderResult!(
      { content: [], details: { calls: [{ status: "ok" }] } },
      { isPartial: false, expanded: false }, theme, context,
    );
    assert.match(done.render(100).join(""), /1\.5s/);
    assert.doesNotMatch(done.render(100).join(""), /~1\.5s/);
    const ticks = invalidations;
    await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
    assert.equal(invalidations, ticks, "timer must stop after final result");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codemode Compact handles missing, malformed, or very large metadata without throwing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codemode-empty-"));
  let resolver: ToolRendererResolver | undefined;
  const pi = {
    registerToolRenderer(cb: ToolRendererResolver) { resolver = cb; },
    registerCommand() {}, registerShortcut() {}, on() {},
  } as any;
  try {
    await installToolViewController(pi, { modeFile: join(directory, "mode.json") });
    const renderer = resolver!("codemode", () => ({}))!;
    const theme = { fg: (_: string, value: string) => value, bold: (value: string) => value } as any;
    const context = { args: { code: 123 }, state: {}, durationMs: NaN, isError: false } as any;
    const call = renderer.renderCall!({ code: 123 }, theme, context);
    assert.match(call.render(100).join(""), /codemode/);
    assert.doesNotMatch(call.render(100).join(""), /Code: \?|code lines/, "invalid code metadata must not appear");
    const response = renderer.renderResult!(
      { content: [], details: { calls: [{ status: "unknown" }, null, { status: "ok" }] } },
      { isPartial: false, expanded: false }, theme, context,
    );
    assert.match(response.render(100).join(""), /3 вызова/);
    assert.match(response.render(100).join(""), /1 успешн\./);
    assert.doesNotMatch(response.render(100).join(""), /NaN/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codemode Compact keeps each styled row to one terminal line and prioritizes useful metrics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codemode-width-"));
  let resolver: ToolRendererResolver | undefined;
  const pi = {
    registerToolRenderer(cb: ToolRendererResolver) { resolver = cb; },
    registerCommand() {}, registerShortcut() {}, on() {},
  } as any;
  try {
    await installToolViewController(pi, { modeFile: join(directory, "mode.json") });
    const renderer = resolver!("codemode", () => ({}))!;
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as any;
    const context = { args: { code: "one\ntwo\nthree" }, state: {}, durationMs: 1480, isError: true } as any;
    const call = renderer.renderCall!({ code: "one\ntwo\nthree" }, theme, context);
    const result = renderer.renderResult!({
      content: [{ type: "text", text: "output\nmore output" }],
      details: { calls: [
        { status: "ok" }, { status: "ok" }, { status: "error" }, { status: "cancelled" },
      ] },
    }, { isPartial: false, expanded: false }, theme, context);
    for (const width of [1, 6, 12, 20, 28, 40, 60, 95]) {
      for (const component of [call, result]) {
        const lines = component.render(width);
        assert.equal(lines.length, 1, `width ${width} must stay one line`);
        assert.ok(visibleWidth(lines[0]!) <= width, `width ${width} overflow: ${lines[0]}`);
      }
    }
    assert.match(result.render(28).join(""), /Ошибка/);
    assert.match(result.render(28).join(""), /4 вызова/);
    assert.doesNotMatch(result.render(28).join(""), /2 (?:вывод|строки)/);
    assert.match(result.render(95).join(""), /2 строки/);
    assert.match(result.render(95).join(""), /1\.5s/);
    assert.match(call.render(95).join(""), /codemode/);
    assert.doesNotMatch(call.render(95).join(""), /code lines/);
    assert.deepEqual(call.render(0), []);
    assert.deepEqual(result.render(0), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codemode output count falls back from lines to out only on narrow rows; duration and separators are subdued", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codemode-output-layout-"));
  let resolver: ToolRendererResolver | undefined;
  const pi = {
    registerToolRenderer(cb: ToolRendererResolver) { resolver = cb; },
    registerCommand() {}, registerShortcut() {}, on() {},
  } as any;
  const applied: Array<{ name: string; value: string }> = [];
  const theme = {
    fg(name: string, value: string) { applied.push({ name, value }); return value; },
    bold(value: string) { return value; },
  } as any;
  try {
    await installToolViewController(pi, { modeFile: join(directory, "mode.json") });
    const renderer = resolver!("codemode", () => ({}))!;
    const context = { args: { code: "text('x')" }, isError: false, durationMs: 213, state: {} } as any;
    const result = renderer.renderResult!({
      content: [{ type: "text", text: Array.from({ length: 179 }, () => "output").join("\n") }],
      details: { calls: Array.from({ length: 6 }, () => ({ status: "ok" })) },
    }, { isPartial: false, expanded: false }, theme, context);
    const full = result.render(110).join("");
    assert.match(full, /^    ⎿  6 вызовов · 6 успешн. │ 179 строк · 213ms$/);
    assert.doesNotMatch(full, /✓/, "no standalone success status glyph");
    assert.ok(applied.some(item => item.name === "dim" && item.value === " │ "));
    assert.ok(applied.some(item => item.name === "dim" && item.value === "213ms"));
    assert.ok(applied.some(item => item.name === "muted" && item.value === "179 строк"));
    const narrowFallback = Array.from({ length: 85 }, (_, i) => i + 1)
      .map(width => ({ width, value: result.render(width).join("") }))
      .find(item => item.value.includes("179 выв."));
    assert.ok(narrowFallback, "output lines should fall back to out before hiding the count");
    assert.ok(visibleWidth(narrowFallback.value) <= narrowFallback.width);
    assert.doesNotMatch(narrowFallback.value, /179 строки/);
    const reallyNarrow = result.render(10).join("");
    assert.ok(reallyNarrow.length > 0, "narrow rows should keep an available metric");
    assert.ok(visibleWidth(reallyNarrow) <= 10);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
