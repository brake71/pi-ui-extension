import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, type TuiInputListener } from "@earendil-works/pi-tui";
import { SessionPanel, type SessionListItem } from "./panel.ts";

const theme = { fg: (_color: string, text: string) => text } as any;

function session(id: string, title: string): SessionListItem {
  return {
    id,
    title,
    modified: new Date(0),
    userPromptCount: 1,
    current: false,
  };
}

async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("clicking the Sessions title refreshes the saved session list", async () => {
  let listener: TuiInputListener | undefined;
  let loads = 0;
  const snapshots = [
    [session("old", "Old session")],
    [session("new", "New session")],
  ];
  const tui = {
    addInputListener(next: TuiInputListener) {
      listener = next;
      return () => {};
    },
    requestRender() {},
    currentLayout: undefined as any,
  } as any;
  const panel = new SessionPanel(theme, {
    tui,
    getDesiredWidth: () => 40,
    loadSessions: async () => snapshots[Math.min(loads++, snapshots.length - 1)]!,
    onSelect() {},
    onRename() {},
    onOpenResources() {},
    onDelete() {},
    onDeleteOthers() {},
    now: () => 0,
  });
  tui.currentLayout = {
    root: {
      component: panel,
      rect: { x: 10, y: 5, width: 40, height: 7 },
      clip: { x: 10, y: 5, width: 40, height: 7 },
      children: [],
    },
  };

  panel.refresh();
  await flushAsync();
  assert.match(panel.render(40).join("\n"), /Old session/);
  assert.match(panel.render(40).join("\n"), /сейчас/, "Sessions rows retain relative time");
  assert.doesNotMatch(panel.render(40).join("\n"), /1 · сейчас/, "Sessions rows omit the user-question count");
  assert.match(panel.render(40)[0]!, /СЕССИИ ↻/);

  assert.deepEqual(listener?.("\u001b[<0;20;6M"), { consume: true });
  assert.deepEqual(listener?.("\u001b[<0;20;6m"), { consume: true });
  await flushAsync();

  assert.equal(loads, 2);
  const output = panel.render(40).join("\n");
  assert.match(output, /New session/);
  assert.doesNotMatch(output, /Old session/);
  panel.dispose();
});

test("renders and opens the MCP resource button", async () => {
  let listener: TuiInputListener | undefined;
  let opened: string | undefined;
  const tui = {
    addInputListener(next: TuiInputListener) {
      listener = next;
      return () => {};
    },
    requestRender() {},
    currentLayout: undefined as any,
  } as any;
  const panel = new SessionPanel(theme, {
    tui,
    getDesiredWidth: () => 40,
    loadSessions: async () => [session("one", "One session")],
    onSelect() {},
    onRename() {},
    onDelete() {},
    onDeleteOthers() {},
    onOpenResources(button) { opened = button; },
    now: () => 0,
  });
  tui.currentLayout = {
    root: {
      component: panel,
      rect: { x: 10, y: 5, width: 40, height: 5 },
      clip: { x: 10, y: 5, width: 40, height: 5 },
      children: [],
    },
  };

  panel.refresh();
  await flushAsync();
  assert.match(panel.render(40).join("\n"), /Правила/, "resource button should display a Russian label");
  assert.doesNotMatch(panel.render(40).join("\n"), /AGENTS\.md/, "the resource button should not display the file name");
  assert.match(panel.render(40).join("\n"), /MCP/);

  assert.deepEqual(listener?.("\u001b[<0;43;9M"), { consume: true });
  assert.deepEqual(listener?.("\u001b[<0;43;9m"), { consume: true });
  await flushAsync();

  assert.equal(opened, "mcp");
  panel.dispose();
});

test("releasing outside the Sessions title cancels a refresh click", async () => {
  let listener: TuiInputListener | undefined;
  let loads = 0;
  const tui = {
    addInputListener(next: TuiInputListener) {
      listener = next;
      return () => {};
    },
    requestRender() {},
    currentLayout: undefined as any,
  } as any;
  const panel = new SessionPanel(theme, {
    tui,
    getDesiredWidth: () => 40,
    loadSessions: async () => {
      loads++;
      return [];
    },
    onSelect() {},
    onRename() {},
    onDelete() {},
    onDeleteOthers() {},
    onOpenResources() {},
  });
  tui.currentLayout = {
    root: {
      component: panel,
      rect: { x: 10, y: 5, width: 40, height: 7 },
      clip: { x: 10, y: 5, width: 40, height: 7 },
      children: [],
    },
  };

  panel.refresh();
  await flushAsync();
  listener?.("\u001b[<0;20;6M");
  listener?.("\u001b[<0;20;7m");
  await flushAsync();

  assert.equal(loads, 1);
  panel.dispose();
});

test("renders ⊗ and clears every other session without refreshing", async () => {
  let listener: TuiInputListener | undefined;
  let loads = 0;
  let cleared = 0;
  const tui = {
    addInputListener(next: TuiInputListener) {
      listener = next;
      return () => {};
    },
    requestRender() {},
    currentLayout: undefined as any,
  } as any;
  const panel = new SessionPanel(theme, {
    tui,
    getDesiredWidth: () => 40,
    loadSessions: async () => {
      loads++;
      return [session("one", "One session")];
    },
    onSelect() {},
    onRename() {},
    onDelete() {},
    onDeleteOthers() { cleared++; },
    onOpenResources() {},
    now: () => 0,
  });
  tui.currentLayout = {
    root: {
      component: panel,
      rect: { x: 10, y: 5, width: 40, height: 7 },
      clip: { x: 10, y: 5, width: 40, height: 7 },
      children: [],
    },
  };

  panel.refresh();
  await flushAsync();
  assert.match(panel.render(40)[0]!, /⊗/);

  // ⊗ sits at the right edge of the title row: content column 33 of 38.
  assert.deepEqual(listener?.("\u001b[<0;46;6M"), { consume: true });
  assert.deepEqual(listener?.("\u001b[<0;46;6m"), { consume: true });
  await flushAsync();

  assert.equal(cleared, 1);
  assert.equal(loads, 1);
  panel.dispose();
});

test("hides ⊗ on narrow panels", async () => {
  const tui = {
    addInputListener: () => () => {},
    requestRender() {},
    currentLayout: undefined as any,
  } as any;
  const panel = new SessionPanel(theme, {
    tui,
    getDesiredWidth: () => 16,
    loadSessions: async () => [],
    onSelect() {},
    onRename() {},
    onDelete() {},
    onDeleteOthers() {},
    onOpenResources() {},
    now: () => 0,
  });
  tui.currentLayout = {
    root: {
      component: panel,
      rect: { x: 0, y: 0, width: 16, height: 7 },
      clip: { x: 0, y: 0, width: 16, height: 7 },
      children: [],
    },
  };

  panel.refresh();
  await flushAsync();
  assert.doesNotMatch(panel.render(16)[0]!, /⊗/);
  panel.dispose();
});

test("opens advanced manager from ≡ without triggering refresh or bulk trash", async () => {
  let listener: TuiInputListener | undefined;
  let opened = 0;
  let cleared = 0;
  let loads = 0;
  const tui = {
    addInputListener(next: TuiInputListener) { listener = next; return () => {}; },
    requestRender() {},
    currentLayout: undefined as any,
  } as any;
  const panel = new SessionPanel(theme, {
    tui,
    getDesiredWidth: () => 40,
    loadSessions: async () => { loads++; return [session("one", "One session")]; },
    onSelect() {}, onRename() {}, onDelete() {},
    onDeleteOthers() { cleared++; },
    onOpenResources() {},
    onOpenManager() { opened++; },
  });
  tui.currentLayout = {
    root: { component: panel, rect: { x: 10, y: 5, width: 40, height: 5 },
      clip: { x: 10, y: 5, width: 40, height: 5 }, children: [] },
  };
  panel.refresh();
  await flushAsync();
  const header = panel.render(40)[0]!;
  const managerColumn = header.indexOf("≡");
  assert.ok(managerColumn > 0, "≡ must be present in the session header");
  const x = 10 + managerColumn + 1;
  assert.deepEqual(listener?.(`\u001b[<0;${x};6M`), { consume: true });
  assert.deepEqual(listener?.(`\u001b[<0;${x};6m`), { consume: true });
  await flushAsync();
  assert.equal(opened, 1);
  assert.equal(cleared, 0);
  assert.equal(loads, 1);
  panel.dispose();
});

test("pinned and recent sessions remain visible in the expanded sidebar list", async () => {
  const tui = { addInputListener: () => () => {}, requestRender() {} } as any;
  const panel = new SessionPanel(theme, {
    tui, getDesiredWidth: () => 42,
    loadSessions: async () => [
      { ...session("starred", "Important"), pinned: true },
      ...Array.from({ length: 15 }, (_, index) => session(`other-${index}`, `Recent ${index}`)),
    ],
    onSelect() {}, onRename() {}, onDelete() {},
    onDeleteOthers() {}, onOpenResources() {},
  });
  panel.refresh();
  await flushAsync();
  const output = panel.render(42).join("\n");
  assert.match(output, /○ ★Important/);
  assert.match(output, /Recent 3/);
  assert.match(output, /Recent 4/);
  assert.match(output, /Recent 14/);
  panel.dispose();
});

test("session row ☆/★ toggles pin in place without invoking rename, delete or switch", async () => {
  let listener: TuiInputListener | undefined;
  const calls: string[] = [];
  let pinned = false;
  const tui = {
    addInputListener(next: TuiInputListener) { listener = next; return () => {}; },
    requestRender() {},
    currentLayout: undefined as any,
  } as any;
  const panel = new SessionPanel(theme, {
    tui, getDesiredWidth: () => 40,
    loadSessions: async () => [{ ...session("one", "Important session"), pinned }],
    onSelect() { calls.push("select"); },
    onRename() { calls.push("rename"); },
    onDelete() { calls.push("delete"); },
    onTogglePin(item) {
      assert.equal(item.id, "one");
      calls.push("pin");
      pinned = !pinned;
      panel.refresh();
    },
    onDeleteOthers() {}, onOpenResources() {}, now: () => 0,
  });
  tui.currentLayout = {
    root: {
      component: panel, rect: { x: 10, y: 5, width: 40, height: 5 },
      clip: { x: 10, y: 5, width: 40, height: 5 }, children: [],
    },
  };
  const click = (text: string) => {
    const row = stripTerminalSequences(panel.render(40)[1]!);
    const column = row.lastIndexOf(text);
    assert.ok(column > 0, `missing button ${text}: ${row}`);
    const x = 10 + column + 1;
    assert.deepEqual(listener?.(`\u001b[<0;${x};7M`), { consume: true });
    assert.deepEqual(listener?.(`\u001b[<0;${x};7m`), { consume: true });
  };
  panel.refresh();
  await flushAsync();
  assert.match(panel.render(40)[1]!, /☆ ✎ ×/);
  click("☆");
  await flushAsync();
  assert.equal(pinned, true);
  assert.match(panel.render(40)[1]!, /★ ✎ ×/);
  assert.match(panel.render(40)[1]!, /○ ★Important/);
  click("★");
  await flushAsync();
  assert.equal(pinned, false);
  assert.match(panel.render(40)[1]!, /☆ ✎ ×/);
  assert.deepEqual(calls, ["pin", "pin"]);

  click("✎");
  await flushAsync();
  click("×");
  await flushAsync();
  assert.deepEqual(calls, ["pin", "pin", "rename", "delete"]);
  panel.dispose();
});

test("session pin hit area is distinct from rename/delete and cancelled on off-target release", async () => {
  let listener: TuiInputListener | undefined;
  const calls: string[] = [];
  const tui = {
    addInputListener(next: TuiInputListener) { listener = next; return () => {}; },
    requestRender() {},
    currentLayout: undefined as any,
  } as any;
  const panel = new SessionPanel(theme, {
    tui, getDesiredWidth: () => 40,
    loadSessions: async () => [{ ...session("active", "Current session"), current: true }],
    onSelect() { calls.push("select"); }, onRename() { calls.push("rename"); },
    onDelete() { calls.push("delete"); }, onTogglePin() { calls.push("pin"); },
    onDeleteOthers() {}, onOpenResources() {}, now: () => 0,
  });
  tui.currentLayout = {
    root: {
      component: panel, rect: { x: 10, y: 5, width: 40, height: 5 },
      clip: { x: 10, y: 5, width: 40, height: 5 }, children: [],
    },
  };
  panel.refresh();
  await flushAsync();
  const line = panel.render(40)[1]!;
  assert.match(line, /☆ ✎ ·/);
  const pinX = 10 + line.indexOf("☆") + 1;
  const renameX = 10 + line.indexOf("✎") + 1;
  const endX = 10 + line.lastIndexOf("·") + 1;
  listener?.(`\u001b[<0;${pinX};7M`);
  listener?.(`\u001b[<0;${renameX};7m`);
  await flushAsync();
  assert.deepEqual(calls, []);
  listener?.(`\u001b[<0;${endX};7M`);
  listener?.(`\u001b[<0;${endX};7m`);
  await flushAsync();
  assert.deepEqual(calls, [], "current session cannot be deleted");
  listener?.(`\u001b[<0;${pinX};7M`);
  listener?.(`\u001b[<0;${pinX};7m`);
  await flushAsync();
  assert.deepEqual(calls, ["pin"], "current session can still be pinned");
  panel.dispose();
});

test("active pinned session shows ● ★ before its title without changing the right-side pin action", async () => {
  const tui = { addInputListener: () => () => {}, requestRender() {} } as any;
  const panel = new SessionPanel(theme, {
    tui, getDesiredWidth: () => 40,
    loadSessions: async () => [{ ...session("active", "hello"), current: true, pinned: true }],
    onSelect() {}, onRename() {}, onDelete() {}, onTogglePin() {},
    onDeleteOthers() {}, onOpenResources() {}, now: () => 0,
  });
  panel.refresh();
  await flushAsync();
  const row = stripTerminalSequences(panel.render(40)[1]!);
  assert.match(row, /● ★hello/);
  assert.match(row, /★ ✎ ·/);
  panel.dispose();
});

test("narrow sidebar keeps prior rename/delete actions without showing a truncated pin button", async () => {
  let listener: TuiInputListener | undefined;
  const actions: string[] = [];
  const tui = {
    addInputListener(next: TuiInputListener) { listener = next; return () => {}; },
    requestRender() {},
    currentLayout: undefined as any,
  } as any;
  const panel = new SessionPanel(theme, {
    tui, getDesiredWidth: () => 21,
    loadSessions: async () => [session("one", "Short")],
    onSelect() { actions.push("select"); }, onRename() { actions.push("rename"); },
    onDelete() { actions.push("delete"); }, onTogglePin() { actions.push("pin"); },
    onDeleteOthers() {}, onOpenResources() {}, now: () => 0,
  });
  tui.currentLayout = {
    root: {
      component: panel, rect: { x: 3, y: 2, width: 21, height: 5 },
      clip: { x: 3, y: 2, width: 21, height: 5 }, children: [],
    },
  };
  panel.refresh();
  await flushAsync();
  const line = stripTerminalSequences(panel.render(21)[1]!);
  assert.match(line, / ✎ ×/);
  assert.doesNotMatch(line, /☆/);
  const pencilX = 3 + line.indexOf("✎") + 1;
  assert.deepEqual(listener?.(`\u001b[<0;${pencilX};4M`), { consume: true }, `press at ${pencilX}: ${line}`);
  assert.deepEqual(listener?.(`\u001b[<0;${pencilX};4m`), { consume: true }, `release at ${pencilX}: ${line}`);
  await flushAsync();
  assert.deepEqual(actions, ["rename"]);
  panel.dispose();
});
