import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import {
  AssistantMessageComponent,
  getMarkdownTheme,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences } from "@earendil-works/pi-tui";
import { initTheme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { loadActivePiBundle } from "./host-bundle.ts";
import { installCompactSpacingGuard, markCompactSpacingRenderer } from "./compact-spacing.ts";
import { installCompactThinkingAdapter } from "./thinking-adapter.ts";
import { transformThinkingText } from "./thinking.ts";

const cliEntry = join(
  process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js",
);

test("the active Pi CLI bundle resolves the real host classes, not SDK copies", async () => {
  const bundle = await loadActivePiBundle(cliEntry);
  assert.ok(bundle, "official Pi CLI must provide the shared bundle index");
  assert.notEqual(bundle.ToolExecutionComponent, ToolExecutionComponent);
  assert.notEqual(bundle.AssistantMessageComponent, AssistantMessageComponent);
  assert.equal(await loadActivePiBundle(import.meta.filename), undefined,
    "an unknown executable cannot be treated as the Pi CLI");
});

test("the bundled CLI tool renderer has Compact spacing and correct click coordinates", async (t) => {
  const bundle = await loadActivePiBundle(cliEntry);
  assert.ok(bundle);
  initTheme("dark");
  const prototype = bundle.ToolExecutionComponent.prototype;
  const originalRender = prototype.render;
  const originalMouse = prototype.handleMouse;
  const sdkRender = ToolExecutionComponent.prototype.render;
  const marker = Symbol.for("pi-ui-extension:compact-spacing-guard");
  t.after(() => {
    prototype.render = originalRender;
    prototype.handleMouse = originalMouse;
    delete (prototype as unknown as Record<symbol, unknown>)[marker];
  });
  const owned = markCompactSpacingRenderer({
    renderShell: "self" as const,
    renderCall: () => new Text("›  bash", 0, 0),
    renderResult: () => new Text("⎿  result", 0, 0),
  });
  const tool = new bundle.ToolExecutionComponent(
    "bash", "bundled", {}, {}, owned as any, { requestRender() {} } as any, ".",
  );
  tool.updateResult({
    content: [{ type: "text", text: "ok" }], isError: false, durationMs: 1,
  }, false);
  assert.equal(tool.render(80)[0], "", "the actual bundled host adds one blank row");
  let mode: "compact" | "normal" = "compact";
  assert.equal(installCompactSpacingGuard(() => mode, prototype), true);
  assert.deepEqual(tool.render(80).map(stripTerminalSequences).map(line => line.trimEnd()),
    ["›  bash", "⎿  result"]);
  assert.equal(tool.handleMouse({
    type: "click", button: "left", x: 3, y: 0, screenX: 3, screenY: 0,
    width: 80, height: 2,
  } as any)?.handled, true);
  assert.equal((tool as any).expanded, true);
  assert.equal(tool.handleMouse({
    type: "click", button: "left", x: 3, y: 0, screenX: 3, screenY: 0,
    width: 80, height: 2,
  } as any)?.handled, true);
  assert.equal((tool as any).expanded, false);
  const thirdParty = new bundle.ToolExecutionComponent(
    "bash", "third-party", {}, {}, {
      renderShell: "self",
      renderCall: () => new Text("›  external", 0, 0),
      renderResult: () => new Text("⎿  result", 0, 0),
    } as any, { requestRender() {} } as any, ".",
  );
  assert.equal(thirdParty.render(80)[0], "", "third-party renderers keep Pi's native row");
  mode = "normal";
  assert.equal(tool.render(80)[0], "", "Normal mode keeps native spacing");
  assert.equal(ToolExecutionComponent.prototype.render, sdkRender,
    "installing the bundle guard must not change SDK components");
});

test("the bundled CLI Thinking title expands despite separate TUI class identities", async (t) => {
  const bundle = await loadActivePiBundle(cliEntry);
  assert.ok(bundle);
  initTheme("dark");
  const prototype = bundle.AssistantMessageComponent.prototype;
  const original = prototype.updateContent;
  const marker = Symbol.for("pi-ui-extension:compact-thinking-adapter");
  t.after(() => {
    prototype.updateContent = original;
    delete (prototype as unknown as Record<symbol, unknown>)[marker];
  });
  const status = () => ({ phase: "complete" as const });
  const transformer = (markdown: string, context: any) =>
    transformThinkingText(markdown, context, "compact", status);
  const message = new bundle.AssistantMessageComponent(
    undefined, false, getMarkdownTheme(), "Thinking...", 1, [transformer],
  );
  assert.equal(installCompactThinkingAdapter(
    () => "compact", transformer, { status }, prototype,
  ), true);
  message.updateContent({
    role: "assistant", content: [{ type: "thinking", thinking: "bundled thinking body" }],
    stopReason: "stop",
  } as any, false);
  const before = message.render(80).map(stripTerminalSequences);
  assert.match(before.join("\n"), /\+ Размышление/);
  assert.doesNotMatch(before.join("\n"), /bundled thinking body/);
  const titleRow = before.findIndex(line => line.includes("Размышление"));
  const result = message.handleMouse?.({
    type: "click", button: "left", x: 3, y: titleRow, screenX: 3, screenY: titleRow,
    width: 80, height: before.length,
  } as any);
  assert.equal(result?.handled, true);
  const after = message.render(80).map(stripTerminalSequences).join("\n");
  assert.match(after, /− Размышление/);
  assert.match(after, /bundled thinking body/);
  assert.equal(AssistantMessageComponent.prototype.updateContent === original, false,
    "the SDK component has not been confused with the host bundle");
});
