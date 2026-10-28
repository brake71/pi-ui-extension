import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { confirmSessionCleanup } from "./session-cleanup.ts";
import type { CleanupSummary } from "../session/cleanup-preview.ts";

const theme = { fg(_color: string, text: string) { return text; }, bold(text: string) { return text; } } as any;
const summary: CleanupSummary = { eligible: 4, protected: 6, current: 1, pinned: 2, active: 1, unavailable: 2 };
function modalHost(rows = 40) {
  const modals: Component[] = [];
  const configs: any[] = [];
  const ui = {
    notify() {},
    custom<T>(factory: any, options: any): Promise<T> {
      configs.push(options);
      return new Promise<T>(resolve => modals.push(factory({ terminal: { rows, columns: 88 }, requestRender() {} }, theme, {}, resolve)));
    },
  } as any;
  return { ui, modals, configs };
}

test("cleanup preview is centered, shows actionable and protected counts and defaults to cancel", async () => {
  const { ui, modals, configs } = modalHost();
  const pending = confirmSessionCleanup(ui, summary);
  const modal = modals[0]!;
  const plain = modal.render(60).map(stripTerminalSequences).join("\n");
  assert.match(plain, /Можно удалить: 4/);
  assert.match(plain, /Защищено \/ недоступно: 6/);
  assert.match(plain, /Текущая сессия\s+1/);
  assert.match(plain, /Закреплённые\s+2/);
  assert.match(plain, /Активны в другом Pi\s+1/);
  assert.match(plain, /Файлы недоступны\s+2/);
  assert.match(plain, /Недавние сессии включены/);
  assert.match(plain, /В корзину \(4\)/);
  assert.equal(configs[0].overlay, true);
  assert.equal(configs[0].overlayOptions.anchor, "center");
  modal.handleInput?.("\r");
  assert.equal(await pending, false, "Enter alone cannot delete anything");
});

test("protection reason counts share a right-aligned column, including multiple digits", async () => {
  const { ui, modals } = modalHost();
  const values = [1, 20, 300, 4000];
  confirmSessionCleanup(ui, {
    ...summary, current: values[0]!, pinned: values[1]!, active: values[2]!, unavailable: values[3]!,
  });
  const lines = modals[0]!.render(60).map(stripTerminalSequences);
  const labels = ["Текущая сессия", "Закреплённые", "Активны в другом Pi", "Файлы недоступны"];
  const countEnds = labels.map((label, index) => {
    const line = lines.find(text => text.includes(label));
    assert.ok(line, `missing ${label}`);
    const countText = String(values[index]);
    assert.match(line, new RegExp(`${label}\\s+${countText}\\s`));
    return line.indexOf(countText) + countText.length;
  });
  assert.equal(new Set(countEnds).size, 1, `count columns differ: ${countEnds}`);
});

test("only an explicit destructive selection can authorize cleanup; Esc cancels", async () => {
  const { ui, modals } = modalHost();
  const approved = confirmSessionCleanup(ui, summary);
  modals[0]!.handleInput?.("\x1b[B");
  modals[0]!.handleInput?.("\r");
  assert.equal(await approved, true);
  const cancelled = confirmSessionCleanup(ui, summary);
  modals[1]!.handleInput?.("\x1b");
  assert.equal(await cancelled, false);
});

test("zero eligible displays protection reasons but cannot authorize deletion", async () => {
  const { ui, modals } = modalHost();
  const pending = confirmSessionCleanup(ui, { ...summary, eligible: 0, protected: 10 });
  const plain = modals[0]!.render(56).map(stripTerminalSequences).join("\n");
  assert.match(plain, /Можно удалить: 0/);
  assert.doesNotMatch(plain, /В корзину \(0\)/);
  modals[0]!.handleInput?.("\x1b[B");
  modals[0]!.handleInput?.("\r");
  assert.equal(await pending, false);
});

test("compact overlay fits narrow terminal dimensions and supports mouse confirmation", async () => {
  const { ui, modals } = modalHost(16);
  const pending = confirmSessionCleanup(ui, summary);
  const modal = modals[0]!;
  const rendered = modal.render(33).map(stripTerminalSequences);
  assert.ok(rendered.length <= 14, `modal has ${rendered.length} rows for 16-row terminal`);
  for (const row of rendered) assert.ok(visibleWidth(row) <= 33);
  const actionIndex = rendered.findIndex(row => row.includes("В корзину"));
  assert.ok(actionIndex >= 0);
  const click = modal.handleMouse?.({ type: "click", button: "left", x: 5, y: actionIndex, width: 33, height: 16, screenX: 5, screenY: actionIndex } as any);
  assert.equal(click?.handled, true);
  assert.equal(await pending, true);
});

test("native UI fallback remains guarded if centered custom overlays are unavailable", async () => {
  let confirmations = 0;
  const ui = { async confirm(_title: string, message: string) { confirmations++; assert.match(message, /Недавно изменённые сессии/); return true; } } as any;
  assert.equal(await confirmSessionCleanup(ui, summary), true);
  assert.equal(await confirmSessionCleanup(ui, { ...summary, eligible: 0 }), false);
  assert.equal(confirmations, 1);
});
