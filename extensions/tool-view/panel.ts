import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
  type TuiInputListener,
} from "@earendil-works/pi-tui";
import { panelBottom, panelContent, panelTop } from "../sidebar/panel.ts";
import { installPriorityInputListener, isSidebarInputBlocked, parseSgrMouseEvent } from "../sidebar/resize.ts";
import { TOOL_VIEW_MODES, type ToolViewMode } from "./types.ts";
import type { ToolUsageCount, ToolUsageKind, ToolUsageSnapshot } from "./usage.ts";

export type ToolViewPanelOptions = {
  readonly tui: TUI;
  readonly getDesiredWidth: () => number;
  readonly getMode: () => ToolViewMode | undefined;
  readonly getUsage: () => ToolUsageSnapshot | undefined;
  readonly onSelect: (mode: ToolViewMode) => void;
  readonly showBottomBorder?: boolean;
};

type LayoutRect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
type LayoutBox = {
  readonly component: Component;
  readonly rect: LayoutRect;
  readonly clip: LayoutRect;
  readonly children: readonly LayoutBox[];
};
type LayoutTui = TUI & { readonly currentLayout?: { readonly root: LayoutBox } };

function contains(rect: LayoutRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

function findLayoutBox(box: LayoutBox, component: Component): LayoutBox | undefined {
  if (box.component === component) return box;
  for (const child of box.children) {
    const match = findLayoutBox(child, component);
    if (match) return match;
  }
  return undefined;
}

function modeLabel(mode: ToolViewMode): string {
  switch (mode) {
    case "normal": return "Полный";
    case "compact": return "Краткий";
    case "hidden": return "Скрытый";
  }
}

function centerText(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width), "");
  const padding = Math.max(0, width - visibleWidth(clipped));
  const left = Math.floor(padding / 2);
  return `${" ".repeat(left)}${clipped}${" ".repeat(padding - left)}`;
}

type UsageColor = "dim" | "muted" | "text" | "accent" | "success";

function colored(theme: Theme, color: UsageColor, value: string): string {
  return theme.fg(color, value);
}

/** Keep aligned counters readable without ever wrapping in narrow terminals. */
function alignedRow(theme: Theme, left: string, right: string, width: number): string {
  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) return panelContent(theme, truncateToWidth(right, width, ""), "dim", width);
  const label = truncateToWidth(left, Math.max(0, width - rightWidth - 1), "…");
  const gap = " ".repeat(Math.max(1, width - visibleWidth(label) - rightWidth));
  return panelContent(theme, label + gap + right, "dim", width);
}

function usageCount(theme: Theme, exchange: number, session: number): string {
  return colored(theme, exchange > 0 ? "success" : "dim", String(exchange)) +
    colored(theme, "dim", "/") +
    colored(theme, "text", String(session));
}

function sectionLabel(kind: "direct" | "nested" | "mcp", count: number, width: number): string {
  const full = kind === "mcp" ? "MCP" : kind === "direct" ? "ВЫЗОВЫ" : "ВЛОЖЕННЫЕ";
  const short = kind === "mcp" ? "MCP" : kind === "direct" ? "ВЫЗОВЫ" : "ВЛОЖ.";
  const base = width >= 32 ? full : width >= 18 ? short : kind === "direct" ? "ВЫЗ." : kind === "nested" ? "ВЛОЖ." : "MCP";
  return width >= 15 ? `${base} · ${count}` : base;
}

function sectionTotal(counts: readonly ToolUsageCount[]): { run: number; total: number } {
  return counts.reduce((sum, count) => ({
    run: sum.run + count.exchange,
    total: sum.total + count.session,
  }), { run: 0, total: 0 });
}

function separator(theme: Theme, width: number): string {
  return panelContent(theme, colored(theme, "dim", "─".repeat(width)), "dim", width);
}

/** Spans edge-to-edge, joining the side borders without any content padding. */
function flushSeparator(theme: Theme, renderWidth: number): string {
  if (renderWidth < 2) return theme.fg("dim", "─".repeat(renderWidth));
  return theme.fg("dim", `├${"─".repeat(renderWidth - 2)}┤`);
}


export function groupUsageCounts(counts: readonly ToolUsageCount[]): Readonly<Record<ToolUsageKind, readonly ToolUsageCount[]>> {
  return Object.freeze({
    tool: Object.freeze(counts.filter((count) => count.kind === "tool")),
    mcp: Object.freeze(counts.filter((count) => count.kind === "mcp")),
  });
}

/** Clickable single-row selector for tool transcript rendering mode. */
export class ToolViewPanel implements Component {
  private pressedMode: ToolViewMode | undefined;
  private disposed = false;
  private readonly uninstallInput: () => void;

  constructor(
    private readonly theme: Theme,
    private readonly options: ToolViewPanelOptions,
  ) {
    const listener: TuiInputListener = (data) => this.handleMouseInput(data);
    this.uninstallInput = installPriorityInputListener(options.tui, listener);
  }

  private getLayoutBox(): LayoutBox | undefined {
    const root = (this.options.tui as LayoutTui).currentLayout?.root;
    return root ? findLayoutBox(root, this) : undefined;
  }

  private modeAt(x: number, y: number): ToolViewMode | undefined {
    const box = this.getLayoutBox();
    if (!box || !contains(box.clip, x, y) || !contains(box.rect, x, y)) return undefined;
    if (y - box.rect.y !== 1) return undefined;

    const contentWidth = Math.max(1, Math.min(box.rect.width, this.options.getDesiredWidth()) - 4);
    const contentColumn = x - box.rect.x - 2;
    if (contentColumn < 0 || contentColumn >= contentWidth) return undefined;

    const index = Math.min(
      TOOL_VIEW_MODES.length - 1,
      Math.floor(contentColumn * TOOL_VIEW_MODES.length / contentWidth),
    );
    return TOOL_VIEW_MODES[index];
  }

  private isInsidePanel(x: number, y: number): boolean {
    const box = this.getLayoutBox();
    return Boolean(box && contains(box.clip, x, y) && contains(box.rect, x, y));
  }

  private handleMouseInput(data: string): { consume: true } | undefined {
    if (isSidebarInputBlocked(this.options.tui)) {
      this.pressedMode = undefined;
      return undefined;
    }
    const mouse = parseSgrMouseEvent(data);
    // Let the enclosing ScrollView receive wheel events before any click handling.
    if (!mouse || (mouse.button & 64) !== 0) return undefined;

    const x = mouse.x - 1;
    const y = mouse.y - 1;
    const inside = this.isInsidePanel(x, y);
    const isLeft = (mouse.button & 3) === 0;

    if (mouse.release) {
      const pressed = this.pressedMode;
      if (!pressed) return undefined;
      this.pressedMode = undefined;
      const released = this.modeAt(x, y);
      if (released === pressed) {
        queueMicrotask(() => {
          const currentMode = this.options.getMode();
          if (!this.disposed && !isSidebarInputBlocked(this.options.tui) && currentMode !== undefined && currentMode !== released) {
            this.options.onSelect(released);
          }
        });
      }
      this.options.tui.requestRender();
      return { consume: true };
    }

    if (mouse.motion) {
      if (!this.pressedMode) return undefined;
      if (this.modeAt(x, y) !== this.pressedMode) {
        this.pressedMode = undefined;
        this.options.tui.requestRender();
      }
      return { consume: true };
    }

    if (!inside) return undefined;
    if (!isLeft) return undefined;

    if (this.options.getMode() === undefined) return { consume: true };
    this.pressedMode = this.modeAt(x, y);
    if (this.pressedMode) this.options.tui.requestRender();
    return this.pressedMode ? { consume: true } : undefined;
  }

  render(width: number): string[] {
    const renderWidth = Math.max(1, Math.min(width, this.options.getDesiredWidth()));
    const contentWidth = Math.max(1, renderWidth - 4);
    const currentMode = this.options.getMode();
    const connected = currentMode !== undefined;
    const baseWidth = Math.floor(contentWidth / TOOL_VIEW_MODES.length);
    const remainder = contentWidth % TOOL_VIEW_MODES.length;
    const body = TOOL_VIEW_MODES.map((mode, index) => {
      const selected = mode === currentMode;
      const pressed = mode === this.pressedMode;
      const marker = !connected ? "·" : selected ? "●" : "○";
      const segmentWidth = baseWidth + (index < remainder ? 1 : 0);
      const text = centerText(`${marker} ${modeLabel(mode)}`, segmentWidth);
      return pressed
        ? this.theme.fg("warning", text)
        : selected
          ? this.theme.fg("success", text)
          : this.theme.fg("dim", text);
    }).join("");
    const usage = this.options.getUsage();
    const grouped = groupUsageCounts(usage?.counts ?? []);
    const direct = grouped.tool.filter((count) => count.scope !== "nested");
    const nested = grouped.tool.filter((count) => count.scope === "nested");
    const all = sectionTotal(grouped.tool); // MCP rows attribute existing calls, not extra executions.
    const usageRows: string[] = [
      alignedRow(this.theme, colored(this.theme, "dim", "СЕЙЧАС"), colored(this.theme, "dim", "ВСЕГО"), contentWidth),
      alignedRow(
        this.theme,
        colored(this.theme, all.run > 0 ? "success" : "muted", String(all.run)),
        colored(this.theme, "text", String(all.total)),
        contentWidth,
      ),
    ];
    const appendGroup = (kind: "direct" | "nested" | "mcp", counts: readonly ToolUsageCount[]): void => {
      if (counts.length === 0) return;
      usageRows.push(separator(this.theme, contentWidth));
      usageRows.push(panelContent(
        this.theme,
        colored(this.theme, "accent", sectionLabel(kind, counts.length, contentWidth)),
        "dim",
        contentWidth,
      ));
      for (const count of counts) {
        const prefix = kind === "mcp" ? "  " : "";
        const name = colored(this.theme, "dim", prefix) +
          colored(this.theme, count.exchange > 0 ? "text" : "muted", count.name);
        usageRows.push(alignedRow(
          this.theme,
          name,
          usageCount(this.theme, count.exchange, count.session),
          contentWidth,
        ));
      }
    };
    appendGroup("direct", direct);
    appendGroup("nested", nested);
    appendGroup("mcp", grouped.mcp);

    const lines = [
      panelTop(this.theme, "ОТОБРАЖЕНИЕ", renderWidth),
      panelContent(this.theme, body, "dim", contentWidth),
      flushSeparator(this.theme, renderWidth),
      ...usageRows,
    ];
    if (this.options.showBottomBorder !== false) lines.push(panelBottom(this.theme, renderWidth));
    return lines.map((line) => truncateToWidth(line, renderWidth, ""));
  }

  invalidate(): void {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pressedMode = undefined;
    this.uninstallInput();
  }
}
