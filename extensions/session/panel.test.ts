import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth, type TuiInputListener } from "@earendil-works/pi-tui";
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

test("resource button clicks match every rendered cell at uneven and narrow widths", async () => {
  const cases = [
    { width: 26, segments: ["Правил", "Навыки", "Плаги", " MCP "] },
    { width: 25, segments: ["Правил", "Навык", "Плаги", " MCP "] },
    { width: 27, segments: ["Правил", "Навыки", "Плагин", " MCP "] },
    { width: 24, segments: ["Прави", "Навык", "Плаги", " MCP "] },
    { width: 28, segments: ["Правил", "Навыки", "Плагин", " MCP  "] },
    { width: 7, segments: ["П", "Н", "П", ""] },
    { width: 8, segments: ["П", "Н", "П", "M"] },
    { width: 26, desiredWidth: 40, segments: ["Правил", "Навыки", "Плаги", " MCP "] },
    { width: 40, desiredWidth: 26, segments: ["Правил", "Навыки", "Плаги", " MCP "] },
  ];
  const ids = ["agents", "skills", "extensions", "mcp"];
  for (const { width, desiredWidth = width, segments } of cases) {
    let listener: TuiInputListener | undefined;
    const opened: string[] = [];
    const tui = {
      addInputListener(next: TuiInputListener) { listener = next; return () => {}; },
      requestRender() {},
      currentLayout: undefined as any,
    } as any;
    const panel = new SessionPanel(theme, {
      tui,
      getDesiredWidth: () => desiredWidth,
      loadSessions: async () => [],
      onSelect() {}, onRename() {}, onDelete() {}, onDeleteOthers() {},
      onOpenResources(button) { opened.push(button); },
    });
    panel.refresh();
    await flushAsync();
    const lines = panel.render(width);
    assert.equal(stripTerminalSequences(lines.at(-2)!), `│ ${segments.join("")} │`);
    tui.currentLayout = {
      root: {
        component: panel,
        rect: { x: 10, y: 5, width, height: lines.length },
        clip: { x: 10, y: 5, width, height: lines.length }, children: [],
      },
    };
    let column = 0;
    for (const [index, segment] of segments.entries()) {
      for (const _cell of segment) {
        const x = 13 + column++;
        const y = 5 + lines.length - 1;
        listener?.(`\u001b[<0;${x};${y}M`);
        listener?.(`\u001b[<0;${x};${y}m`);
        await flushAsync();
        assert.deepEqual(opened.splice(0), [ids[index]],
          `width ${width}, desired ${desiredWidth}, content column ${column - 1}`);
      }
    }
    panel.dispose();
  }
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

function deferredLoader() {
  const pending: Array<{ resolve: (rows: readonly SessionListItem[]) => void; reject: (error: Error) => void }> = [];
  let loads = 0;
  return {
    loads: () => loads,
    loadSessions: () => {
      loads++;
      return new Promise<readonly SessionListItem[]>((resolve, reject) => { pending.push({ resolve, reject }); });
    },
    settle: (index: number, rows: readonly SessionListItem[]) => pending[index]!.resolve(rows),
    fail: (index: number, message: string) => pending[index]!.reject(new Error(message)),
  };
}

function panelHarness(options: { width: number; loadSessions: () => Promise<readonly SessionListItem[]>; onTogglePin?: () => void }) {
  let listener: TuiInputListener | undefined;
  const tui = {
    addInputListener(next: TuiInputListener) { listener = next; return () => {}; },
    requestRender() {},
    currentLayout: undefined as any,
  } as any;
  const panel = new SessionPanel(theme, {
    tui,
    getDesiredWidth: () => options.width,
    loadSessions: options.loadSessions,
    onSelect() {}, onRename() {}, onDelete() {},
    onTogglePin: options.onTogglePin,
    onDeleteOthers() {}, onOpenResources() {}, now: () => 0,
  });
  tui.currentLayout = {
    root: {
      component: panel, rect: { x: 10, y: 5, width: options.width, height: 7 },
      clip: { x: 10, y: 5, width: options.width, height: 7 }, children: [],
    },
  };
  return { panel, press: (x: number, y: number) => {
    listener?.(`\u001b[<0;${x};${y}M`);
    listener?.(`\u001b[<0;${x};${y}m`);
  } };
}

test("a failed first load shows a retry hint instead of No saved sessions", async () => {
  const loader = deferredLoader();
  const { panel, press } = panelHarness({ width: 40, loadSessions: loader.loadSessions });
  panel.refresh();
  loader.fail(0, "offline");
  await flushAsync();

  const output = panel.render(40).join("\n");
  assert.doesNotMatch(output, /No saved sessions/);
  assert.match(output, /Ошибка: offline/);
  assert.match(panel.render(40)[0]!, /СЕССИИ ⚠/);
  assert.match(panel.render(40)[0]!, /СЕССИИ ⚠/, "the header flags the failure on the retry target itself");

  press(20, 6);
  await flushAsync();
  assert.equal(loader.loads(), 2, "clicking the title retries the load");
  loader.settle(1, [session("one", "One session")]);
  await flushAsync();

  const recovered = panel.render(40).join("\n");
  assert.match(recovered, /One session/);
  assert.doesNotMatch(recovered, /Ошибка:/);
  assert.match(panel.render(40)[0]!, /СЕССИИ ↻/);
  panel.dispose();
});

test("a failed refresh keeps the last good list and the hint fits a narrow panel", async () => {
  const loader = deferredLoader();
  const { panel, press } = panelHarness({ width: 44, loadSessions: loader.loadSessions });
  panel.refresh();
  loader.settle(0, [session("one", "First session"), session("two", "Second session")]);
  await flushAsync();
  press(24, 6);
  await flushAsync();
  loader.fail(1, "permission denied on a long error message");
  await flushAsync();

  const lines = panel.render(44);
  const output = lines.join("\n");
  assert.match(output, /First session/);
  assert.match(output, /Second session/);
  assert.match(output, /Ошибка: permission denied/);
  assert.doesNotMatch(output, /Нет сохранённых сессий/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 44), "failure hint stays inside the panel width");
  assert.match(stripTerminalSequences(lines[3]!), /⚠ Ошибка: permission/, "the long reason is truncated, not wrapped");
  panel.dispose();
});

test("a refresh requested during an in-flight load runs once, and dispose stops queued work", async () => {
  const loader = deferredLoader();
  const { panel } = panelHarness({ width: 40, loadSessions: loader.loadSessions });

  panel.refresh();
  panel.refresh();
  assert.equal(loader.loads(), 1, "a second click is queued, not started");
  assert.match(panel.render(40)[0]!, /СЕССИИ …/);

  loader.settle(0, [session("old", "Old session")]);
  await flushAsync();
  assert.equal(loader.loads(), 2, "the queued refresh runs after the first load");
  loader.settle(1, [session("new", "New session")]);
  await flushAsync();
  assert.match(panel.render(40).join("\n"), /New session/);

  panel.refresh();
  assert.equal(loader.loads(), 3);
  panel.dispose();
  loader.settle(2, [session("late", "Late session")]);
  await flushAsync();
  assert.equal(loader.loads(), 3, "dispose stops further loads");
  assert.doesNotMatch(panel.render(40).join("\n"), /Late session/);
});

test("after a failed refresh the error hint row triggers no session action, and drawn rows still work", async () => {
  const loader = deferredLoader();
  const calls: string[] = [];
  let opened: string | undefined;
  let listener: TuiInputListener | undefined;
  const tui = {
    addInputListener(next: TuiInputListener) { listener = next; return () => {}; },
    requestRender() {},
    currentLayout: undefined as any,
  } as any;
  const five = Array.from({ length: 5 }, (_, index) => session(`row-${index}`, `Row ${index}`));
  const panel = new SessionPanel(theme, {
    tui, getDesiredWidth: () => 40,
    loadSessions: loader.loadSessions,
    onSelect(item) { calls.push(`select:${item.id}`); },
    onRename(item) { calls.push(`rename:${item.id}`); },
    onDelete(item) { calls.push(`delete:${item.id}`); },
    onTogglePin(item) { calls.push(`pin:${item.id}`); },
    onDeleteOthers() { calls.push("clear"); },
    onOpenResources(button) { opened = button; },
    now: () => 0,
  });
  // Title(1) + all five rows + hint + divider + buttons + bottom = 10 lines.
  tui.currentLayout = {
    root: {
      component: panel, rect: { x: 10, y: 5, width: 40, height: 10 },
      clip: { x: 10, y: 5, width: 40, height: 10 }, children: [],
    },
  };
  const press = (x: number, y: number) => {
    listener?.(`\u001b[<0;${x};${y}M`);
    listener?.(`\u001b[<0;${x};${y}m`);
  };

  panel.refresh();
  loader.settle(0, five);
  await flushAsync();
  press(24, 6);
  await flushAsync();
  assert.equal(loader.loads(), 2);
  loader.fail(1, "boom");
  await flushAsync();

  const lines = panel.render(40);
  assert.match(stripTerminalSequences(lines[5]!), /Row 4/, "all five rows remain visible beside the hint");
  assert.match(stripTerminalSequences(lines[6]!), /Ошибка: boom/);

  // The hint follows every retained session and must never trigger a row action.
  // Content columns start at rect.x + 2, and SGR x is one-based.
  for (const column of [0, 31, 32, 34, 35]) press(13 + column, 12);
  await flushAsync();
  assert.deepEqual(calls, [], "the error hint row never selects, pins, renames or deletes");

  press(13, 7);
  await flushAsync();
  assert.deepEqual(calls, ["select:row-0"], "a drawn row is still clickable");

  press(44, 14);
  await flushAsync();
  assert.equal(opened, "mcp", "resource buttons keep working next to the hint");
  panel.dispose();
});


test("a blank failure message still shows the retry hint instead of No saved sessions", async () => {
  const loader = deferredLoader();
  const { panel, press } = panelHarness({ width: 40, loadSessions: loader.loadSessions });
  panel.refresh();
  loader.fail(0, "");
  await flushAsync();

  const output = panel.render(40).join("\n");
  assert.doesNotMatch(output, /No saved sessions/);
  assert.match(output, /Ошибка: Unknown/);
  assert.match(panel.render(40)[0]!, /СЕССИИ ⚠/);

  press(20, 6);
  await flushAsync();
  loader.settle(1, [session("one", "One session")]);
  await flushAsync();
  const recovered = panel.render(40).join("\n");
  assert.match(recovered, /One session/);
  assert.doesNotMatch(recovered, /Ошибка:/);
  panel.dispose();
});

test("a synchronously throwing load reports the failure and the title click retries it", async () => {
  let calls = 0;
  const { panel, press } = panelHarness({ width: 40, loadSessions: () => {
    calls++;
    if (calls === 1) throw new Error("sync boom");
    return Promise.resolve([session("one", "One session")]);
  } });
  panel.refresh();
  await flushAsync();

  const output = panel.render(40).join("\n");
  assert.match(output, /Ошибка: sync boom/);
  assert.doesNotMatch(output, /No saved sessions/);
  assert.doesNotMatch(output, /Loading sessions/, "a synchronous throw never leaves the panel loading forever");

  press(20, 6);
  await flushAsync();
  assert.equal(calls, 2, "the title click retries after a synchronous throw");
  assert.match(panel.render(40).join("\n"), /One session/);
  panel.dispose();
});
