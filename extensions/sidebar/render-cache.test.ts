import assert from "node:assert/strict";
import test from "node:test";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { createDefaultSidebarPanels } from "./default-panels.ts";
import { installSidebar } from "./index.ts";

test("sidebar reads each owned panel once per width per frame without retaining stale state", () => {
  let ctxReads = 0, usageReads = 0, model = "initial";
  let count = 200;
  const tui: any = {
    [Symbol.for("@earendil-works/pi-tui/viewport")]: true,
    terminal: { rows: 40, columns: 200 }, layoutRoot: { render: () => [], invalidate() {} }, inputListeners: new Set(),
    addInputListener(fn: any) { this.inputListeners.add(fn); return () => this.inputListeners.delete(fn); },
    requestRender() {}, setLayoutRoot(root: any) { this.layoutRoot = root; },
  };
  const controller = installSidebar(tui, { fg: (_key: string, text: string) => text, bold: (text: string) => text } as any, createDefaultSidebarPanels({
    getContextUsage: () => { ctxReads++; return undefined; }, getModel: () => model, getThinkingLevel: () => "off",
    getToolViewMode: () => "compact", getToolUsage: () => {
      usageReads++;
      return { counts: Array.from({ length: count }, (_, i) => ({ name: `tool_${i}`, kind: "tool", exchange: 1, session: 1 })) };
    },
    onSelectToolViewMode() {}, loadSessions: async () => [], onSelectSession() {}, onRenameSession() {}, onDeleteSession() {}, onDeleteOthers() {}, onOpenResources() {},
  }));
  try {
    // Settle adaptive scrollbar geometry first.
    renderLayoutFrame(tui.layoutRoot, 200, 40, () => {});
    ctxReads = usageReads = 0;
    const first = renderLayoutFrame(tui.layoutRoot, 200, 40, () => {});
    assert.equal(ctxReads, 1);
    assert.equal(usageReads, 0, "collapsed Tool View does not render its hidden content");
    assert.match(first.lines.join("\n"), /initial/);
    model = "changed"; count = 0;
    const second = renderLayoutFrame(tui.layoutRoot, 200, 40, () => {});
    assert.equal(ctxReads, 2);
    assert.equal(usageReads, 0, "collapsed Tool View remains lazy across frames");
    assert.match(second.lines.join("\n"), /changed/);
    assert.doesNotMatch(second.lines.join("\n"), /tool_0/);
    tui.terminal.rows = 25;
    const resized = renderLayoutFrame(tui.layoutRoot, 200, 25, () => {});
    assert.equal(resized.lines.length, 25);
    assert.match(resized.lines.join("\n"), /changed/);
    controller.refresh();
    assert.match(renderLayoutFrame(tui.layoutRoot, 200, 25, () => {}).lines.join("\n"), /changed/);
  } finally { controller.dispose(); }
});
