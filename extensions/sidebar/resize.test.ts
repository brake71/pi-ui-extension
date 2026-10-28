import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { installSidebar } from "./index.ts";
import { installPriorityInputListener } from "./resize.ts";
import type { SidebarPanelDefinition } from "./registry.ts";

test("sidebar ignores hidden divider hits and cancels drags after terminal resize", async () => {
  let overlays = 0, hidden = 0;
  const listeners = new Set<any>();
  const root = { render: () => [], invalidate() {} };
  const tui: any = {
    [Symbol.for("@earendil-works/pi-tui/viewport")]: true,
    terminal: { columns: 80, rows: 40 }, layoutRoot: root,
    inputListeners: listeners,
    addInputListener(fn: any) { listeners.add(fn); return () => listeners.delete(fn); },
    setLayoutRoot(next: any) { this.layoutRoot = next; },
    requestRender() {},
    showOverlay() { overlays++; return { hide() { hidden++; } }; },
  };
  const controller = installSidebar(tui, { fg: (_: string, text: string) => text } as any, []);
  const input = (data: string) => [...listeners][0]?.(data);
  try {
    assert.equal(controller.mounted, true);
    assert.equal(input("\x1b[<0;80;5M"), undefined);
    assert.equal(overlays, 0);
    tui.terminal.columns = 160;
    assert.deepEqual(input("\x1b[<0;142;5M"), { consume: true });
    assert.deepEqual(input("\x1b[<0;130;5m"), { consume: true });
    assert.equal(tui.layoutRoot.entries[2].basis, 30);
    assert.equal(hidden, 1);
    assert.deepEqual(input("\x1b[<0;130;5M"), { consume: true });
    tui.terminal.columns = 80;
    await delay(50);
    assert.equal(hidden, 2);
    assert.equal(input("\x1b[<0;70;5m"), undefined);
    assert.equal(tui.layoutRoot.entries[2].basis, 30);
    tui.terminal.columns = 160;
    input("\x1b[<0;130;5M");
    tui.terminal.rows = 30;
    assert.equal(input("\x1b[<0;120;5m"), undefined);
    assert.equal(hidden, 3);
    assert.equal(tui.layoutRoot.entries[2].basis, 30);
  } finally { controller.dispose(); }
  assert.equal(listeners.size, 0);
  assert.equal(tui.layoutRoot, root);
});

test("sidebar paints separator rows instead of leaving stale main-view colors", () => {
  const root = { render: () => [], invalidate() {} };
  const tui: any = {
    [Symbol.for("@earendil-works/pi-tui/viewport")]: true,
    terminal: { columns: 160, rows: 6 }, layoutRoot: root,
    inputListeners: new Set(),
    addInputListener() { return () => {}; },
    setLayoutRoot(next: any) { this.layoutRoot = next; },
    requestRender() {},
  };
  const panel = (id: string): SidebarPanelDefinition => ({
    id,
    create: () => ({ component: { render: () => [id], invalidate() {} } }),
  });
  const controller = installSidebar(
    tui,
    { fg: (_: string, text: string) => text } as any,
    [panel("one"), panel("two")],
  );
  try {
    const lines = tui.layoutRoot.entries[2].component.render(32);
    assert.equal(lines[1], `\x1b[0m${" ".repeat(32)}`);
  } finally { controller.dispose(); }
});

test("priority input listener precedes built-in handlers and unsubscribes cleanly", () => {
  const existingA = () => undefined;
  const existingB = () => undefined;
  const priority = () => ({ consume: true });
  const listeners = new Set<any>([existingA, existingB]);
  const tui: any = {
    inputListeners: listeners,
    addInputListener(fn: any) { listeners.add(fn); return () => listeners.delete(fn); },
  };

  const unsubscribe = installPriorityInputListener(tui, priority);
  assert.equal(typeof unsubscribe, "function");
  assert.deepEqual([...listeners], [priority, existingA, existingB]);
  unsubscribe?.();
  assert.deepEqual([...listeners], [existingA, existingB]);
});

test("ordinary panel input still falls back to public registration without private priority access", () => {
  const listeners = new Set<any>();
  const listener = () => ({ consume: true });
  const tui: any = {
    addInputListener(fn: any) { listeners.add(fn); return () => listeners.delete(fn); },
  };

  const unsubscribe = installPriorityInputListener(tui, listener);
  assert.deepEqual([...listeners], [listener]);
  unsubscribe();
  assert.equal(listeners.size, 0);

  const disabled = installPriorityInputListener(tui, listener, { requirePriority: true });
  assert.equal(listeners.size, 0);
  disabled();
});

test("missing private input listener Set disables resize without hiding the sidebar", () => {
  const root = { render: () => [], invalidate() {} };
  let installs = 0;
  const tui: any = {
    [Symbol.for("@earendil-works/pi-tui/viewport")]: true,
    terminal: { columns: 160, rows: 30 }, layoutRoot: root,
    addInputListener() { installs++; return () => {}; },
    setLayoutRoot(next: any) { this.layoutRoot = next; },
    requestRender() {},
  };

  const controller = installSidebar(tui, { fg: (_: string, text: string) => text } as any, []);
  assert.equal(controller.mounted, true);
  assert.notEqual(tui.layoutRoot, root);
  assert.equal(installs, 0);
  controller.dispose();
  assert.equal(tui.layoutRoot, root);
});

test("invalid or absent private layout root fails closed before creating panels", () => {
  for (const layoutRoot of [undefined, {}, { render: () => [] }]) {
    let created = 0;
    const tui: any = {
      [Symbol.for("@earendil-works/pi-tui/viewport")]: true,
      terminal: { columns: 160, rows: 30 }, layoutRoot,
      setLayoutRoot() { throw new Error("must not alter incompatible layout"); },
    };
    const controller = installSidebar(tui, {} as any, [{
      id: "test",
      create: () => {
        created++;
        return { component: { render: () => [], invalidate() {} } };
      },
    }]);
    assert.equal(controller.mounted, false);
    assert.equal(created, 0);
    assert.equal(tui.layoutRoot, layoutRoot);
  }
});

test("failed input registration restores original root and disposes panels", () => {
  const root = { render: () => [], invalidate() {} };
  let disposed = 0;
  const tui: any = {
    [Symbol.for("@earendil-works/pi-tui/viewport")]: true,
    terminal: { columns: 160, rows: 30 }, layoutRoot: root,
    inputListeners: new Set(),
    addInputListener() { throw new Error("incompatible listener API"); },
    setLayoutRoot(next: any) { this.layoutRoot = next; },
    requestRender() {},
  };
  const controller = installSidebar(tui, { fg: (_: string, text: string) => text } as any, [{
    id: "test",
    create: () => ({
      component: { render: () => [], invalidate() {} },
      dispose() { disposed++; },
    }),
  }]);
  assert.equal(controller.mounted, false);
  assert.equal(tui.layoutRoot, root);
  assert.equal(disposed, 1);
});

test("sidebar disposal does not replace a later host-owned layout root", () => {
  const root = { render: () => [], invalidate() {} };
  const laterRoot = { render: () => [], invalidate() {} };
  const listeners = new Set<any>();
  const tui: any = {
    [Symbol.for("@earendil-works/pi-tui/viewport")]: true,
    terminal: { columns: 160, rows: 30 }, layoutRoot: root,
    inputListeners: listeners,
    addInputListener(fn: any) { listeners.add(fn); return () => listeners.delete(fn); },
    setLayoutRoot(next: any) { this.layoutRoot = next; },
    requestRender() {},
  };
  const controller = installSidebar(tui, { fg: (_: string, text: string) => text } as any, []);
  assert.equal(controller.mounted, true);
  tui.layoutRoot = laterRoot;
  controller.dispose();
  assert.equal(tui.layoutRoot, laterRoot);
  assert.equal(listeners.size, 0);
});
