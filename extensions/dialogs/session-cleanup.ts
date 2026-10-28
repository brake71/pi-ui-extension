import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { SelectList, type Component, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { modalFrame } from "./index.ts";
import type { CleanupSummary } from "../session/cleanup-preview.ts";

/** Centered, cancellation-first preview with an explicit protection breakdown. */
export async function confirmSessionCleanup(ui: ExtensionUIContext, summary: CleanupSummary): Promise<boolean> {
  const description = `Можно удалить: ${summary.eligible}; защищено/недоступно: ${summary.protected} (` +
    `текущая ${summary.current}, закреплённые ${summary.pinned}, активные ${summary.active}, недоступные ${summary.unavailable}). ` +
    `Недавно изменённые сессии тоже попадут в список. Pi без этого расширения обнаружить нельзя.`;
  if (typeof ui.custom !== "function") {
    return summary.eligible > 0 && ui.confirm("Очистить остальные сессии", description);
  }
  return ui.custom<boolean>((tui, theme, _keys, done) => {
    const actions = summary.eligible > 0 ? ["Отмена", `В корзину (${summary.eligible})`] : ["Отмена"];
    const list = new SelectList(actions.map((label, index) => ({ value: String(index), label })), actions.length, {
      selectedPrefix: text => theme.fg("accent", text),
      selectedText: text => theme.fg("warning", theme.bold(text)),
      description: text => theme.fg("muted", text),
      scrollInfo: text => theme.fg("dim", text),
      noMatch: text => theme.fg("dim", text),
    });
    list.onSelect = item => done(item.value === "1");
    list.onCancel = () => done(false);
    let actionsY = 0;
    const component: Component = {
      render(width) {
        const rows = tui.terminal.rows;
        const total = `Можно удалить: ${summary.eligible}`;
        const kept = `Защищено / недоступно: ${summary.protected}`;
        const tiny = rows < 17;
        const compact = rows < 28 || width < 34;
        const reasons = [
          ["Текущая сессия", summary.current],
          ["Закреплённые", summary.pinned],
          ["Активны в другом Pi", summary.active],
          ["Файлы недоступны", summary.unavailable],
        ] as const;
        const labelWidth = Math.max(...reasons.map(([label]) => label.length));
        const countWidth = Math.max(...reasons.map(([, count]) => String(count).length));
        const details = compact
          ? [`Текущая ${summary.current} · Закреплено ${summary.pinned}`, `Другой Pi ${summary.active} · Недоступно ${summary.unavailable}`]
          : reasons.map(([label, count]) => `${label.padEnd(labelWidth)}  ${String(count).padStart(countWidth)}`);
        const info = tiny ? [
          theme.fg("success", total), theme.fg("warning", kept),
          theme.fg("muted", `Тек. ${summary.current} · Закр. ${summary.pinned} · Pi ${summary.active} · Недост. ${summary.unavailable}`),
        ] : [
          theme.fg("success", theme.bold(total)),
          theme.fg("warning", kept),
          "",
          theme.fg("muted", "Причины защиты:"),
          ...details.map(text => theme.fg("muted", text)),
          "",
          theme.fg("warning", "Недавние сессии включены; другие Pi могут быть активны."),
          "",
        ];
        actionsY = 3 + info.length;
        return modalFrame(theme, width, "Очистить остальные сессии", [
          ...info, ...list.render(Math.max(1, width - 4)),
        ], "↑↓ выбор · Enter подтвердить · Esc отмена", true);
      },
      invalidate() { list.invalidate(); },
      handleInput(data) { list.handleInput(data); tui.requestRender(); },
      handleMouse(event): TuiMouseEventResult | undefined {
        if (event.y < actionsY) return undefined;
        const result = list.handleMouse({ ...event, x: event.x - 2, y: event.y - actionsY, width: event.width - 4 });
        if (result?.handled) tui.requestRender();
        return result;
      },
    };
    return component;
  }, { overlay: true, overlayOptions: { anchor: "center", width: "68%", maxHeight: "85%", margin: 2 } });
}
