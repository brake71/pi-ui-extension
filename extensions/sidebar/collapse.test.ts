import assert from "node:assert/strict";
import test from "node:test";
import { TuiAltScreen, sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { createDefaultSidebarPanels } from "./default-panels.ts";
import { installSidebar } from "./index.ts";

function setup() {
  const tui = new TuiAltScreen({ columns: 160, rows: 40, hideCursor() {}, write() {} } as any, false) as any;
  const original = { render: () => ["MAIN"], invalidate() {} };
  tui.setLayoutRoot(original);
  const initialListeners = tui.inputListeners.size;
  let model = "nag-norm", thinking = "high", percent: number | undefined = 23;
  const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text } as any;
  const context = {
    getUsage: () => percent === undefined ? undefined : { percent } as any,
    getModel: () => model, getThinkingLevel: () => thinking,
  };
  const panels = createDefaultSidebarPanels({
    getContextUsage: context.getUsage, getModel: context.getModel, getThinkingLevel: context.getThinkingLevel,
    getToolViewMode: () => "compact", getToolUsage: () => undefined,
    loadSessions: async () => [], onSelectSession() {}, onRenameSession() {}, onDeleteSession() {},
    onDeleteOthers() {}, onOpenResources() {}, onSelectToolViewMode() {},
  });
  const controller = installSidebar(tui, theme, panels, { context });
  const frame = () => {
    tui.currentLayout = renderLayoutFrame(tui.layoutRoot, tui.terminal.columns, tui.terminal.rows, () => {});
    return tui.currentLayout.lines.map(stripTerminalSequences) as string[];
  };
  const rail = () => {
    const lines = frame();
    const box = tui.currentLayout.root.children[2].rect;
    return { box, lines: lines.map(line => sliceByColumn(line, box.x, box.width)) };
  };
  const mouse = (x: number, y: number, suffix = "M", button = 0) =>
    tui.handleTerminalInput(`\x1b[<${button};${x + 1};${y + 1}${suffix}`);
  const click = (x: number, y: number) => { mouse(x, y); mouse(x, y, "m"); };
  const toggle = () => {
    const { box, lines } = rail();
    const y = lines.findIndex(line => line.includes(">>") || line.includes("<<"));
    assert.equal(y, tui.terminal.rows - 1, "toggle stays on the last terminal row");
    click(box.x + lines[y]!.search(/>>|<</), y);
  };
  return { tui, controller, original, initialListeners, frame, rail, toggle, mouse, click,
    change(m: string, t: string, p: number | undefined) { model = m; thinking = t; percent = p; } };
}

test("collapsing the whole sidebar leaves a narrow rail, live context and a bottom toggle", () => {
  const s = setup();
  try {
    const expandedWidth = s.rail().box.width;
    s.toggle();
    let { box, lines } = s.rail();
    assert.ok(box.width === 4, `collapsed rail must be narrow, got ${box.width}`);
    assert.equal(box.x + box.width, s.tui.terminal.columns);
    assert.deepEqual(lines.slice(0, 8).map(line => line.trim()), [..."nag-norm"]);
    assert.match(lines.map(line => line.trim()).join(""), /high/);
    assert.match(lines.join("\n"), /23%/);
    assert.match(lines.join("\n"), /░[\s\S]*█/);
    assert.doesNotMatch(lines.join("\n"), /СЕССИИ|КОНТЕКСТ|ОТОБРАЖЕНИЕ/);
    assert.equal(lines.at(-1)?.trim(), "<<");
    assert.ok(lines.every(line => visibleWidth(line) <= box.width));
    s.change("gpt-6-sol", "xhigh", 91);
    lines = s.rail().lines;
    assert.match(lines.map(line => line.trim()).join(""), /gpt-6-sol/);
    assert.match(lines.map(line => line.trim()).join(""), /xhigh/);
    assert.match(lines.join("\n"), /91%/);
    s.toggle();
    assert.equal(s.rail().box.width, expandedWidth, "expanding restores the original width");
    assert.match(s.frame().join("\n"), /КОНТЕКСТ/);
  } finally { s.controller.dispose(); }
  assert.equal(s.tui.layoutRoot, s.original);
  assert.equal(s.tui.inputListeners.size, s.initialListeners, "all sidebar listeners are released");
});

test("collapsed rail survives terminal resize and cannot be widened by dragging", () => {
  const s = setup();
  try {
    s.toggle();
    for (const columns of [100, 80, 200]) {
      s.tui.terminal.columns = columns;
      const { box, lines } = s.rail();
      assert.ok(box.width === 4);
      assert.equal(box.x + box.width, columns);
      assert.equal(lines.at(-1)?.trim(), "<<");
      s.mouse(box.x - 1, 5); s.mouse(box.x - 20, 5, "M", 32); s.mouse(box.x - 20, 5, "m");
      assert.equal(s.tui.overlayStack.length, 0, "no resize preview while collapsed");
      assert.equal(s.rail().box.width, box.width);
    }
    s.toggle();
    assert.equal(s.rail().box.width, 32, "terminal resize does not overwrite the preferred expanded width");
    s.tui.terminal.rows = 80;
    s.change("模型🙂very-long-model-name", "medium", undefined);
    s.toggle();
    assert.match(s.rail().lines.join("\n"), /\?%/);
    assert.ok(s.rail().lines.every(line => visibleWidth(line) <= 4));
    s.tui.terminal.rows = 4;
    assert.equal(s.rail().lines.at(-1)?.trim(), "<<", "short windows still retain the toggle");
    s.tui.terminal.rows = 80;
    assert.match(s.rail().lines.join("\n"), /\?%/);
    s.change("nag-norm", "high", NaN);
    assert.match(s.rail().lines.join("\n"), /\?%/);
    s.change("nag-norm", "high", 200);
    assert.match(s.rail().lines.join("\n"), /100%/);
    s.change("nag-norm", "high", -5);
    assert.match(s.rail().lines.join("\n"), /0%/);
  } finally { s.controller.dispose(); }
});

test("toggle only responds to a completed button click, not modals, wheel or release elsewhere", () => {
  const s = setup();
  try {
    const { box, lines } = s.rail();
    const x = box.x + lines.at(-1)!.indexOf(">>");
    const y = s.tui.terminal.rows - 1;
    s.mouse(x, y); s.mouse(x, y - 1, "m");
    assert.equal(s.rail().box.width, 32);
    s.click(x + 5, y);
    assert.equal(s.rail().box.width, 32, "padding is not the button");
    s.mouse(x, y, "M", 64);
    assert.equal(s.rail().box.width, 32);
    s.mouse(x, y);
    const overlay = s.tui.showOverlay({ render: () => ["Modal"], invalidate() {}, handleInput() {} }, { width: 20 });
    s.tui.handleTerminalInput("x");
    s.click(x, y);
    overlay.hide();
    s.mouse(x, y, "m");
    assert.equal(s.rail().box.width, 32);
    s.toggle();
    assert.ok(s.rail().box.width === 4);
  } finally { s.controller.dispose(); }
});
