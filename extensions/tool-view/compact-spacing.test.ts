import assert from "node:assert/strict";
import test from "node:test";
import { ToolExecutionComponent, VERSION } from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { initTheme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { hasCompatibleSelfToolLayout, installCompactSpacingGuard, markCompactSpacingRenderer } from "./compact-spacing.ts";
import type { ToolViewMode } from "./types.ts";

function createTool(owned: boolean, id: string) {
  const native = {
    renderShell: "self" as const,
    renderCall() { return new Text("›  bash", 0, 0); },
    renderResult() { return new Text("⎿  ✓  1 out", 0, 0); },
  };
  const renderer = owned ? markCompactSpacingRenderer(native) : native;
  const component = new ToolExecutionComponent(
    "bash", id, { command: "pwd" }, {}, renderer as any, { requestRender() {} } as any, ".",
  );
  component.updateResult({
    content: [{ type: "text", text: "ok" }], isError: false, durationMs: 30,
  }, false);
  return component;
}

function clickAt(component: ToolExecutionComponent, y: number, width = 80) {
  const event: TuiMouseEvent = {
    type: "click", button: "left", x: 3, y,
    screenX: 3, screenY: y, width, height: component.render(width).length,
  } as TuiMouseEvent;
  return component.handleMouse(event);
}

test("Pi bundle and local SDK both match the supported tool spacing layout", async () => {
  const bundlePath = pathToFileURL(join(
    process.cwd(), "node_modules", "@earendil-works",
    "pi-coding-agent", "dist", "bundle", "index.js",
  )).href;
  const bundled = await import(bundlePath) as { ToolExecutionComponent: typeof ToolExecutionComponent };
  assert.notEqual(bundled.ToolExecutionComponent, ToolExecutionComponent,
    "real Pi CLI uses a different bundled class; local-only prototype tests are insufficient");
  assert.ok(hasCompatibleSelfToolLayout(ToolExecutionComponent.prototype), "unbundled SDK layout");
  assert.ok(hasCompatibleSelfToolLayout(bundled.ToolExecutionComponent.prototype), "minified Pi CLI layout");
  assert.equal(hasCompatibleSelfToolLayout({
    render() { return []; },
    handleMouse() { return undefined; },
  } as any), false, "unknown host implementation must disable the adapter");
});

test("Compact removes only the native leading tool gap; clicks still expand and collapse", () => {
  assert.ok(hasCompatibleSelfToolLayout(ToolExecutionComponent.prototype),
    `verify Pi ${VERSION} keeps the tool layout this guard trims`);
  initTheme("dark");
  const prototype = ToolExecutionComponent.prototype;
  const originalRender = prototype.render;
  const originalMouse = prototype.handleMouse;
  const symbol = Symbol.for("pi-ui-extension:compact-spacing-guard");
  let mode: ToolViewMode = "compact";
  try {
    const tool = createTool(true, "owned");
    assert.equal(tool.render(80)[0], "", "Pi native self shell begins with one spacer line");
    assert.equal(installCompactSpacingGuard(() => mode), true);
    const compact = tool.render(80).map(stripTerminalSequences);
    assert.equal(compact.length, 2, "call and result occupy exactly two rows");
    assert.match(compact[0]!, /bash/);
    assert.match(compact[1]!, /1 out/);
    assert.equal(clickAt(tool, 0)?.handled, true, "top row remains clickable at its new y coordinate");
    assert.equal((tool as any).expanded, true);
    assert.equal(clickAt(tool, 0)?.handled, true);
    assert.equal((tool as any).expanded, false);

    const unowned = createTool(false, "third-party");
    assert.equal(unowned.render(80)[0], "", "other plugins keep Pi native spacing");
    const unownedBefore = unowned.render(80).length;
    assert.equal(clickAt(unowned, 1)?.handled, true, "native tool click uses its original y coordinate");
    assert.equal(unowned.render(80).length, unownedBefore);

    mode = "normal";
    assert.equal(tool.render(80)[0], "", "Normal restores native tool spacing");
    assert.equal(clickAt(tool, 1)?.handled, true, "Normal click targets the unshifted header");
    mode = "hidden";
    assert.deepEqual(tool.render(80), [], "Hidden suppresses the full owned tool row, including native images");
    assert.equal(clickAt(tool, 0), undefined, "Hidden rows do not accept mouse interaction");
    mode = "compact";
    assert.match(tool.render(80)[0]!, /^›  bash/, "Compact switches back without reinstallation");
  } finally {
    prototype.render = originalRender;
    prototype.handleMouse = originalMouse;
    delete (prototype as any)[symbol];
  }
});

test("Compact spacing adapter reloads idempotently and only trims exact native blank rows", () => {
  initTheme("dark");
  const prototype = ToolExecutionComponent.prototype;
  const originalRender = prototype.render;
  const originalMouse = prototype.handleMouse;
  const symbol = Symbol.for("pi-ui-extension:compact-spacing-guard");
  try {
    prototype.render = function (width: number) { return ["modified by another extension", String(width)]; };
    assert.equal(installCompactSpacingGuard(() => "compact"), false, "unknown prior host patches must fail closed");
    prototype.render = originalRender;
    assert.equal(installCompactSpacingGuard(() => "compact"), true);
    assert.equal(installCompactSpacingGuard(() => "normal"), true);
    assert.equal((prototype as any)[symbol].originalRender, originalRender);
    assert.equal((prototype as any)[symbol].originalMouse, originalMouse);
    assert.equal(createTool(true, "new-mode").render(80)[0], "");
    assert.equal(installCompactSpacingGuard(() => "compact"), true);
    assert.match(createTool(true, "restored").render(80)[0]!, /bash/);

    // A host change to the native component layout must not trigger trimming
    // or a mismatched mouse offset.
    const old = (prototype as any)[symbol];
    prototype.render = function (...args) {
      return ["different host layout", ...old.originalRender.apply(this, args).slice(1)];
    };
    assert.equal(installCompactSpacingGuard(() => "compact"), false, "do not stack on unknown patches");
  } finally {
    prototype.render = originalRender;
    prototype.handleMouse = originalMouse;
    delete (prototype as any)[symbol];
  }
});
