import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSidebar } from "./index.ts";

const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");

function createTui(columns: number): any {
  const root = { render: () => [], invalidate() {} };
  const listeners = new Set<any>();
  const tui: any = {
    [Symbol.for("@earendil-works/pi-tui/viewport")]: true,
    terminal: { columns, rows: 40 },
    layoutRoot: root,
    layoutRootBefore: root,
    inputListeners: listeners,
    addInputListener(fn: any) { listeners.add(fn); return () => listeners.delete(fn); },
    setLayoutRoot(next: any) { this.layoutRoot = next; },
    requestRender() {},
    showOverlay() { return { hide() {} }; },
  };
  return tui;
}

const theme = { fg: (_color: string, text: string) => text } as any;

/** A layout frame starts with the extension's own root callback. */
function frame(tui: any): void {
  (tui.layoutRoot as { [LAYOUT_NODE]?: () => unknown })[LAYOUT_NODE]?.();
}

function basis(tui: any): number {
  return tui.layoutRoot.entries[2].basis;
}

/** A real drag: press on the divider, drag with motion, then release. */
function dragTo(tui: any, releaseColumn: number): void {
  const dividerColumn = tui.terminal.columns - basis(tui);
  const input = (data: string): void => { [...tui.inputListeners][0]?.(data); };
  input(`\x1b[<0;${dividerColumn};5M`);
  input(`\x1b[<32;${releaseColumn};5M`);
  input(`\x1b[<0;${releaseColumn};5m`);
}

/** A click: press and release on one column, with no motion in between. */
function clickAt(tui: any, column: number): void {
  const input = (data: string): void => { [...tui.inputListeners][0]?.(data); };
  input(`\x1b[<0;${column};5M`);
  input(`\x1b[<0;${column};5m`);
}

test("a stored width is restored on mount and clamped to the current terminal", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-ui-layout-"));
  try {
    const path = join(dir, "ui-layout.json");
    writeFileSync(path, JSON.stringify({ version: 1, sidebarWidth: 30 }));
    // Default at 160 columns would be 35, so a restored 30 proves the file wins.
    const wide = createTui(160);
    const wideController = installSidebar(wide, theme, [], { layoutPath: path });
    try {
      assert.equal(wideController.mounted, true);
      assert.equal(basis(wide), 30);
    } finally { wideController.dispose(); }

    // 90 columns cannot host 30 next to the 64-column main view: the shown
    // width follows the clamp while the stored preference stays 30.
    writeFileSync(path, JSON.stringify({ version: 1, sidebarWidth: 30 }));
    const narrow = createTui(90);
    const narrowController = installSidebar(narrow, theme, [], { layoutPath: path });
    try {
      assert.equal(basis(narrow), 26);
      frame(narrow);
      assert.equal(basis(narrow), 26);
      assert.equal(JSON.parse(readFileSync(path, "utf8")).sidebarWidth, 30, "mount clamping never rewrites the file");
    } finally { narrowController.dispose(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("missing, invalid and corrupt layout files keep the original default width", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-ui-layout-"));
  try {
    const path = join(dir, "ui-layout.json");
    const defaults = [["missing", undefined], ["invalid", '{"sidebarWidth":999}'], ["corrupt", "{"]] as const;
    for (const [label, text] of defaults) {
      if (text !== undefined) writeFileSync(path, text);
      const tui = createTui(160);
      const controller = installSidebar(tui, theme, [], { layoutPath: path });
      try {
        assert.equal(controller.mounted, true, label);
        assert.equal(basis(tui), 32, `default width for a ${label} layout file`);
      } finally { controller.dispose(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a terminal resize narrows the shown width without overwriting the stored preference", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-ui-layout-"));
  try {
    const path = join(dir, "ui-layout.json");
    writeFileSync(path, JSON.stringify({ version: 1, sidebarWidth: 40 }));
    const tui = createTui(160);
    const controller = installSidebar(tui, theme, [], { layoutPath: path });
    try {
      assert.equal(basis(tui), 40);

      tui.terminal.columns = 90;
      frame(tui);
      assert.equal(basis(tui), 26, "narrow terminal clamps the visible width");

      tui.terminal.columns = 120;
      frame(tui);
      assert.equal(basis(tui), 40, "the saved preference returns after widening");

      tui.terminal.columns = 80;
      frame(tui);
      assert.equal(basis(tui), 18, "never below the sidebar minimum");
      frame(tui);
      assert.equal(basis(tui), 18, "repeated frames with unchanged columns are idempotent");
    } finally { controller.dispose(); }
    assert.equal(JSON.parse(readFileSync(path, "utf8")).sidebarWidth, 40, "resize alone leaves the file untouched");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("only a completed drag saves the user width, and the save survives session teardown", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-ui-layout-"));
  try {
    const path = join(dir, "ui-layout.json");
    const tui = createTui(160);
    // A long debounce proves dispose flushes the pending width instead of a timer.
    const controller = installSidebar(tui, theme, [], { layoutPath: path, layoutSaveDelayMs: 60_000 });
    dragTo(tui, 120);
    assert.equal(basis(tui), 40, "drag release applies the new width immediately");
    assert.equal(existsSync(path), false, "no synchronous write during the gesture");
    controller.dispose();
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { version: 1, sidebarWidth: 40 });

    const restored = createTui(160);
    const restoredController = installSidebar(restored, theme, [], { layoutPath: path });
    try {
      assert.equal(basis(restored), 40, "next mount restores the dragged width");
    } finally { restoredController.dispose(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an unwritable layout path does not block mounting, dragging or teardown", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-ui-layout-"));
  try {
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "");
    const tui = createTui(160);
    const controller = installSidebar(tui, theme, [], {
      layoutPath: join(blocked, "ui-layout.json"),
      layoutSaveDelayMs: 1,
    });
    try {
      assert.equal(controller.mounted, true);
      dragTo(tui, 130);
      assert.equal(basis(tui), 30);
    } finally {
      assert.doesNotThrow(() => controller.dispose());
    }
    assert.equal(tui.layoutRoot, tui.layoutRootBefore, "the original layout root is restored");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("without a layout path the sidebar keeps the in-memory behaviour", () => {
  const tui = createTui(160);
  const controller = installSidebar(tui, theme, []);
  try {
    assert.equal(basis(tui), 32);
    dragTo(tui, 130);
    assert.equal(basis(tui), 30);
  } finally { controller.dispose(); }
  assert.equal(tui.layoutRoot, tui.layoutRootBefore);
});

test("narrow start keeps the stored preference and restores it after widening", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-ui-layout-"));
  try {
    const path = join(dir, "ui-layout.json");
    writeFileSync(path, JSON.stringify({ version: 1, sidebarWidth: 72 }));
    // 120 columns can only show 120-64 = 56 next to the 64-column main view.
    const tui = createTui(120);
    const controller = installSidebar(tui, theme, [], { layoutPath: path });
    try {
      assert.equal(basis(tui), 56, "the narrow terminal limits the displayed width");

      tui.terminal.columns = 160;
      frame(tui);
      assert.equal(basis(tui), 72, "widening restores the stored preference, not the clamped one");
      frame(tui);
      assert.equal(basis(tui), 72, "restoring is idempotent");
    } finally { controller.dispose(); }
    assert.equal(JSON.parse(readFileSync(path, "utf8")).sidebarWidth, 72, "the stored width is never rewritten");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an in-place press and release never saves the terminal-limited width", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-ui-layout-"));
  try {
    const path = join(dir, "ui-layout.json");
    writeFileSync(path, JSON.stringify({ version: 1, sidebarWidth: 72 }));
    const tui = createTui(120);
    const controller = installSidebar(tui, theme, [], { layoutPath: path, layoutSaveDelayMs: 1 });
    try {
      assert.equal(basis(tui), 56);
      // Real geometry: a clamped split is one column wider than the terminal, so
      // the visible divider renders one column right of columns - basis.
      const dividerX = tui.terminal.columns - basis(tui);
      assert.equal(dividerX, 64, "the fake mirrors Pi's getDividerX() at 120 columns");
      for (const column of [dividerX - 1, dividerX, dividerX + 1]) clickAt(tui, column);
      assert.equal(basis(tui), 56, "a click without movement does not move the divider");
    } finally { controller.dispose(); }
    assert.equal(JSON.parse(readFileSync(path, "utf8")).sidebarWidth, 72, "the preference survives the click");

    const restored = createTui(160);
    const restoredController = installSidebar(restored, theme, [], { layoutPath: path });
    try {
      assert.equal(basis(restored), 72, "the next wide start still shows the stored preference");
    } finally { restoredController.dispose(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a real drag in a narrow terminal still changes and saves the preference", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-ui-layout-"));
  try {
    const path = join(dir, "ui-layout.json");
    writeFileSync(path, JSON.stringify({ version: 1, sidebarWidth: 72 }));
    const tui = createTui(120);
    const controller = installSidebar(tui, theme, [], { layoutPath: path, layoutSaveDelayMs: 60_000 });
    try {
      assert.equal(basis(tui), 56);
      dragTo(tui, 90);
      assert.equal(basis(tui), 30, "the divider follows the drag");
    } finally { controller.dispose(); }
    assert.equal(JSON.parse(readFileSync(path, "utf8")).sidebarWidth, 30, "a real drag replaces the preference");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
