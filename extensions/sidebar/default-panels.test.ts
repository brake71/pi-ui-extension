import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultSidebarPanels, createToolViewScrollView, SESSION_PANEL_ID, TOOL_VIEW_PANEL_ID } from "./default-panels.ts";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { ToolViewPanel } from "../tool-view/panel.ts";

function options(): Parameters<typeof createDefaultSidebarPanels>[0] {
  return {
    getContextUsage: () => undefined,
    getModel: () => "test-model",
    getThinkingLevel: () => "off",
    getToolViewMode: () => "compact",
    getToolUsage: () => undefined,
    onSelectToolViewMode() {},
    loadSessions: async () => [],
    onSelectSession() {},
    onRenameSession() {},
    onDeleteSession() {},
    onDeleteOthers() {},
    onOpenResources() {},
  };
}

test("registers sessions without removed standalone panels", () => {
  const ids = createDefaultSidebarPanels(options()).map((panel) => panel.id);
  assert.deepEqual(ids, [SESSION_PANEL_ID, "context", TOOL_VIEW_PANEL_ID]);
  assert.ok(!ids.includes("activity"));
  assert.ok(ids.includes("context"));
  const context = createDefaultSidebarPanels(options()).find(panel => panel.id === "context")!;
  const sessions = createDefaultSidebarPanels(options()).find(panel => panel.id === SESSION_PANEL_ID)!;
  assert.equal(sessions.layout?.minSize instanceof Function ? sessions.layout.minSize({ terminalRows: 40, terminalColumns: 100 }) : sessions.layout?.minSize, 2);
  assert.equal(sessions.layout?.maxSize instanceof Function ? sessions.layout.maxSize({ terminalRows: 40, terminalColumns: 100 }) : sessions.layout?.maxSize, 2);
  assert.equal(context.layout?.minSize instanceof Function ? context.layout.minSize({ terminalRows: 40, terminalColumns: 100 }) : context.layout?.minSize, 6);
  assert.equal(context.layout?.maxSize instanceof Function ? context.layout.maxSize({ terminalRows: 40, terminalColumns: 100 }) : context.layout?.maxSize, 34);
  const toolView = createDefaultSidebarPanels(options()).find(panel => panel.id === TOOL_VIEW_PANEL_ID)!;
  assert.equal(toolView.layout?.maxSize instanceof Function ? toolView.layout.maxSize({ terminalRows: 40, terminalColumns: 100 }) : toolView.layout?.maxSize, 2);
  assert.ok(!ids.includes("resources"));
  assert.ok(!ids.includes("mcp"));
});


test("always registers Tool View", () => {
  const ids = createDefaultSidebarPanels(options()).map((panel) => panel.id);
  assert.ok(ids.includes(TOOL_VIEW_PANEL_ID));
});

test("Context is open by default and its layout size updates", () => {
  const context = createDefaultSidebarPanels(options()).find((panel) => panel.id === "context")!;
  const instance = context.create({
    tui: { addInputListener: () => () => {}, requestRender() {} } as any,
    theme: { fg: (_color: string, value: string) => value } as any,
    getDesiredWidth: () => 50,
  });
  try {
    assert.match(instance.component.render(50).join("\n"), /▾ КОНТЕКСТ/);
    assert.equal(context.layout?.minSize instanceof Function ? context.layout.minSize({ terminalRows: 40, terminalColumns: 100 }) : context.layout?.minSize, 6);
    assert.equal(context.layout?.maxSize instanceof Function ? context.layout.maxSize({ terminalRows: 40, terminalColumns: 100 }) : context.layout?.maxSize, 34);
  } finally {
    instance.dispose?.();
  }
});


test("keeps Tool View anchored at the top when usage rows overflow", () => {
  const tui = { addInputListener: () => () => {}, requestRender() {} } as any;
  const theme = { fg: (_color: string, text: string) => text } as any;
  const panel = new ToolViewPanel(theme, {
    tui,
    getDesiredWidth: () => 60,
    getMode: () => "compact",
    getUsage: () => ({ counts: Array.from({ length: 30 }, (_, index) => ({
      name: `tool-${index}`,
      kind: "tool" as const,
      exchange: 0,
      session: index + 1,
    })) }),
    onSelect() {},
  });
  const scroll = createToolViewScrollView(panel, theme);
  scroll.updateLayout(8, 10, () => {});
  assert.equal(scroll.scrollbar, "hidden");

  scroll.updateLayout(10, 10, () => {});
  assert.equal(scroll.scrollbar, "hidden");

  scroll.updateLayout(40, 10, () => {});
  assert.equal(scroll.scrollTop, 0);
  assert.equal(scroll.isFollowingEnd, false);
  assert.equal(scroll.scrollbar, "always");
  panel.dispose();
});

test("keeps the Tool View bottom border visible when usage rows overflow", () => {
  const tui = { addInputListener: () => () => {}, requestRender() {} } as any;
  const theme = { fg: (_color: string, text: string) => text } as any;
  const panel = new ToolViewPanel(theme, {
    tui,
    getDesiredWidth: () => 30,
    getMode: () => "compact",
    getUsage: () => ({ counts: Array.from({ length: 20 }, (_, index) => ({
      name: `tool-${index}`,
      kind: "tool" as const,
      exchange: 0,
      session: index + 1,
    })) }),
    onSelect() {},
  });
  const scroll = createToolViewScrollView(panel, theme);
  const frame = renderLayoutFrame(scroll, 30, 8, () => {});
  assert.equal(frame.lines.at(-1), "╰────────────────────────────╯");
  panel.dispose();
});
