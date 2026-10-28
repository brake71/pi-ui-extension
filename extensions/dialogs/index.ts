import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, SelectList, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";

/** Theme-aware centered overlays. No Pi Core or transcript patches are required. */
export type DialogUI = Pick<ExtensionUIContext, "select" | "confirm" | "input" | "editor" | "notify">;
type Kind = "select" | "confirm" | "input" | "preview";
const clean = (value: string) => stripTerminalSequences(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").replace(/\r/g, "");

/** Pure frame for predictable positioning in real terminal cells. */
export function modalFrame(theme: Theme, width: number, title: string, body: string[], footer: string, danger = false): string[] {
  if (width < 10) return [truncateToWidth(title, Math.max(1, width), "…")];
  const inner = width - 4;
  const c = (name: Parameters<Theme["fg"]>[0], value: string) => theme.fg(name, value);
  const bar = c(danger ? "warning" : "accent", "─".repeat(width - 2));
  const frame = (value: string) => c("dim", "│ ") + truncateToWidth(value, inner, "…") + " ".repeat(Math.max(0, inner - visibleWidth(truncateToWidth(value, inner, "…")))) + c("dim", " │");
  return [
    c(danger ? "warning" : "accent", "╭" + "─".repeat(width - 2) + "╮"),
    frame(c(danger ? "warning" : "accent", danger ? "⚠ " : "◆ ") + c("text", theme.bold(truncateToWidth(clean(title), inner - 2, "…")))),
    c("dim", "├") + bar + c("dim", "┤"),
    ...body.map(frame),
    c("dim", "├") + bar + c("dim", "┤"),
    frame(c("muted", footer)),
    c(danger ? "warning" : "accent", "╰" + "─".repeat(width - 2) + "╯"),
  ];
}

function overlayOptions() {
  return { anchor: "center" as const, width: "68%" as const, maxHeight: "75%" as const, margin: 2 };
}

export function createDialogUI(ui: ExtensionUIContext): DialogUI {
  if (typeof ui.custom !== "function") return ui; // Test/non-TUI hosts retain native behavior.
  async function choose(title: string, options: string[], message?: string, danger = false): Promise<string | undefined> {
    if (!options.length) return undefined;
    return ui.custom<string | undefined>((tui, theme, _keys, done) => {
      const list = new SelectList(options.map((option, index) => ({ value: String(index), label: clean(option).replace(/\n/g, " ") })),
        Math.min(options.length, Math.max(2, Math.min(10, tui.terminal.rows - 12))), {
          selectedPrefix: (s) => theme.fg("accent", s),
          selectedText: (s) => theme.fg(danger ? "warning" : "text", theme.bold(s)),
          description: (s) => theme.fg("muted", s),
          scrollInfo: (s) => theme.fg("dim", s),
          noMatch: (s) => theme.fg("dim", s),
        });
      list.onSelect = (item) => done(options[Number(item.value)]);
      list.onCancel = () => done(undefined);
      // Destructive dialogs start with Cancel selected; Enter cannot delete by default.
      let bodyStart = 3;
      const component: Component = {
        render(width) {
          const inner = Math.max(1, width - 4);
          const lines = message ? wrapTextWithAnsi(clean(message), inner).slice(0, 4) : [];
          bodyStart = 3 + lines.length + (lines.length ? 1 : 0);
          const rows = [...lines.map(line => theme.fg("muted", line)), ...(lines.length ? [""] : []), ...list.render(inner)];
          return modalFrame(theme, width, title, rows, danger ? "↑↓ выбор · Enter подтвердить · Esc отмена" : "↑↓ навигация · Enter выбрать · Esc закрыть", danger);
        },
        invalidate() { list.invalidate(); },
        handleInput(data) { list.handleInput(data); tui.requestRender(); },
        handleMouse(event): TuiMouseEventResult | undefined {
          if (event.y < bodyStart) return undefined;
          const result = list.handleMouse({ ...event, x: event.x - 2, y: event.y - bodyStart, width: event.width - 4 });
          if (result?.handled) tui.requestRender();
          return result;
        },
      };
      return component;
    }, { overlay: true, overlayOptions: overlayOptions() });
  }
  return {
    notify: (message, level) => ui.notify(message, level),
    select: (title, options) => choose(title, options),
    confirm: async (title, message) => (await choose(title, ["Отмена", "В корзину"], message, true)) === "В корзину",
    input: (title, placeholder) => ui.custom<string | undefined>((tui, theme, _keys, done) => {
      const field = new Input({ prompt: "  › ", placeholder: placeholder ?? "", placeholderStyle: s => theme.fg("dim", s) });
      field.focused = true;
      field.onSubmit = value => done(value);
      field.onEscape = () => done(undefined);
      const modal: Component = {
        render(width) { return modalFrame(theme, width, title, [field.render(Math.max(1, width - 4))[0] ?? ""], "Enter сохранить · Esc отмена"); },
        invalidate() { field.invalidate(); },
        handleInput(data) { field.handleInput(data); tui.requestRender(); },
      };
      return modal;
    }, { overlay: true, overlayOptions: overlayOptions() }),
    editor: (title, content) => ui.custom<string | undefined>((tui, theme, _keys, done) => {
      const source = clean(content ?? "").split("\n");
      let position = 0;
      let page = 10;
      let wrappedWidth = -1;
      let rendered: string[] = [];
      const modal: Component = {
        render(width) {
          const inner = Math.max(1, width - 4);
          if (wrappedWidth !== inner) {
            rendered = source.flatMap(line => wrapTextWithAnsi(line, inner));
            wrappedWidth = inner;
          }
          page = Math.max(1, Math.min(22, Math.floor(tui.terminal.rows * 0.7) - 6));
          position = Math.max(0, Math.min(position, Math.max(0, rendered.length - page)));
          const lines = rendered.slice(position, position + page);
          const footer = `Только чтение · ${position + 1}-${Math.min(position + page, rendered.length)}/${rendered.length} · ↑↓ PgUp/PgDn прокрутка · Esc закрыть`;
          return modalFrame(theme, width, title, lines.map(s => theme.fg("text", s)), footer);
        },
        invalidate() {},
        handleInput(data) {
          if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.enter)) { done(undefined); return; }
          if (matchesKey(data, Key.up)) position = Math.max(0, position - 1);
          else if (matchesKey(data, Key.down)) position++;
          else if (matchesKey(data, Key.pageUp)) position = Math.max(0, position - page);
          else if (matchesKey(data, Key.pageDown)) position += page;
          else if (matchesKey(data, Key.home)) position = 0;
          else if (matchesKey(data, Key.end)) position = Number.MAX_SAFE_INTEGER;
          tui.requestRender();
        },
        handleMouse(event) {
          if (event.type !== "wheel") return undefined;
          position = Math.max(0, position + (event.wheelDelta ?? 0));
          tui.requestRender();
          return { handled: true };
        },
      };
      return modal;
    }, { overlay: true, overlayOptions: overlayOptions() }),
  };
}
