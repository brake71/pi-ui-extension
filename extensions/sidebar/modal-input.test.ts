import assert from "node:assert/strict";
import test from "node:test";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { createDefaultSidebarPanels } from "./default-panels.ts";
import { installSidebar } from "./index.ts";

test("capturing overlays block sidebar clicks and drags and cancel pending gestures", async () => {
  const tui = new TuiAltScreen({ columns: 200, rows: 50, hideCursor() {}, write() {} } as any, false) as any;
  tui.setLayoutRoot({ render: () => [], invalidate() {} });
  const actions: string[] = [];
  const panels = createDefaultSidebarPanels({
    getContextUsage: () => undefined, getModel: () => "model", getThinkingLevel: () => "off",
    getToolViewMode: () => "compact", getToolUsage: () => undefined,
    onSelectToolViewMode: () => actions.push("mode"),
    loadSessions: async () => [{ id: "other", title: "Other", current: false, modified: new Date(), userPromptCount: 1 }],
    onSelectSession: () => actions.push("switch"), onRenameSession: () => actions.push("rename"),
    onDeleteSession: () => actions.push("delete"), onDeleteOthers: () => actions.push("cleanup"),
    onOpenResources: () => actions.push("resource"),
  });
  const controller = installSidebar(tui, { fg: (_: string, text: string) => text, bold: (text: string) => text } as any, panels);
  const mouse = (x: number, y: number, suffix = "M") => tui.handleTerminalInput(`\x1b[<0;${x + 1};${y + 1}${suffix}`);
  const modal = () => tui.showOverlay({ render: () => ["Modal"], invalidate() {}, handleInput() {} }, { anchor: "center", width: 30 });
  let overlay: any;
  try {
    await new Promise(resolve => setImmediate(resolve));
    tui.currentLayout = renderLayoutFrame(tui.layoutRoot, 200, 50, () => {});
    const find = (box: any, name: string): any => box.component?.constructor.name === name ? box : box.children?.map((child: any) => find(child, name)).find(Boolean);
    const wrappers = (box: any): any[] => [
      ...(box.component?.constructor.name === "CollapsiblePanel" ? [box] : []),
      ...(box.children ?? []).flatMap(wrappers),
    ];
    const collapsedPanels = wrappers(tui.currentLayout.root);
    assert.equal(collapsedPanels.length, 3);
    const sessionHeader = collapsedPanels[0]!.component.render(collapsedPanels[0]!.rect.width)[0]!.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    const sessionTitleX = collapsedPanels[0]!.rect.x + sessionHeader.indexOf("СЕССИИ");
    mouse(sessionTitleX, collapsedPanels[0]!.rect.y);
    mouse(sessionTitleX, collapsedPanels[0]!.rect.y, "m");
    tui.currentLayout = renderLayoutFrame(tui.layoutRoot, 200, 50, () => {});
    const updatedPanels = wrappers(tui.currentLayout.root);
    mouse(updatedPanels[2]!.rect.x + 4, updatedPanels[2]!.rect.y);
    mouse(updatedPanels[2]!.rect.x + 4, updatedPanels[2]!.rect.y, "m");
    tui.currentLayout = renderLayoutFrame(tui.layoutRoot, 200, 50, () => {});
    const sessions = find(tui.currentLayout.root, "SessionPanel").rect;
    const view = find(tui.currentLayout.root, "ToolViewPanel").rect;
    // A press begun before the modal must not fire after it closes.
    mouse(sessions.x + 4, sessions.y + 1);
    overlay = modal();
    tui.handleTerminalInput("x");
    for (const [x, y] of [[sessions.x + 4, sessions.y + 1], [view.x + 4, view.y + 1], [159, 4]]) {
      mouse(x!, y!); mouse(x!, y!, "m");
    }
    assert.equal(tui.overlayStack.length, 1, "divider cannot create a preview behind the modal");
    overlay.hide();
    mouse(sessions.x + 4, sessions.y + 1, "m");
    await Promise.resolve();
    assert.deepEqual(actions, []);
    // Also guard callbacks queued just before a modal opens.
    mouse(sessions.x + 4, sessions.y + 1); mouse(sessions.x + 4, sessions.y + 1, "m");
    overlay = modal(); await Promise.resolve(); assert.deepEqual(actions, []); overlay.hide();
    // Non-capturing drag previews remain usable, and a new modal cancels them.
    mouse(159, 4); assert.equal(tui.overlayStack.length, 1);
    overlay = modal(); tui.handleTerminalInput("x");
    assert.equal(tui.overlayStack.length, 1);
    overlay.hide(); mouse(149, 4, "m");
    assert.equal(tui.layoutRoot.entries[2].basis, 40, "cancelled drag must not resize");
    mouse(sessions.x + 4, sessions.y + 1); mouse(sessions.x + 4, sessions.y + 1, "m");
    await Promise.resolve(); assert.deepEqual(actions, ["switch"]);
  } finally { overlay?.hide(); controller.dispose(); }
});
