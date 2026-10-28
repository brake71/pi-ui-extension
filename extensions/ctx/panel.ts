import type { ContextUsage, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TUI, type TuiInputListener } from "@earendil-works/pi-tui";
import { panelBottom, panelContent, panelTop, type PanelColor } from "../sidebar/panel.ts";
import { installPriorityInputListener, isSidebarInputBlocked, parseSgrMouseEvent } from "../sidebar/resize.ts";
import type { ContextEstimate } from "./data.ts";

export type TokenTotals = { readonly input: number; readonly output: number; readonly cache: number };

export type ContextPanelOptions = {
  readonly tui?: TUI;
  readonly getEstimate?: () => ContextEstimate;
  readonly getTokenTotals?: () => TokenTotals;
  readonly getUsage: () => ContextUsage | undefined;
  readonly getModel: () => string;
  readonly getThinkingLevel: () => string;
  readonly getDesiredWidth: () => number;
};

type LayoutRect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
type LayoutBox = {
  readonly component: Component;
  readonly rect: LayoutRect;
  readonly clip: LayoutRect;
  readonly children: readonly LayoutBox[];
};
type LayoutTui = TUI & { readonly currentLayout?: { readonly root: LayoutBox } };

function findLayoutBox(box: LayoutBox, component: Component): LayoutBox | undefined {
  if (box.component === component) return box;
  for (const child of box.children) {
    const found = findLayoutBox(child, component);
    if (found) return found;
  }
  return undefined;
}

function contains(rect: LayoutRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

function formatTokens(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "?";
  if (value < 1_000) return String(Math.max(0, Math.round(value)));
  const scale = value >= 1_000_000 ? 1_000_000 : 1_000;
  const scaled = value / scale;
  return `${scaled.toFixed(scaled >= 10 ? 0 : 1).replace(/\.0$/, "")}${scale === 1_000_000 ? "M" : "K"}`;
}

/** The category breakdown is an estimate, not provider-billed input/output usage. */
export class ContextPanel implements Component {
  private compositionExpanded = false;
  private compositionPressed = false;
  private readonly uninstallInput: () => void;

  constructor(
    private readonly theme: Theme,
    private readonly options: ContextPanelOptions,
  ) {
    const listener: TuiInputListener = (data) => this.handleMouseInput(data);
    this.uninstallInput = options.tui ? installPriorityInputListener(options.tui, listener) : () => {};
  }

  private isCompositionTarget(x: number, y: number): boolean {
    const tui = this.options.tui;
    const root = tui && (tui as LayoutTui).currentLayout?.root;
    const box = root && findLayoutBox(root, this);
    if (!box || !contains(box.rect, x, y) || !contains(box.clip, x, y)) return false;
    const contentWidth = Math.max(1, Math.min(box.rect.width, this.options.getDesiredWidth()) - 4);
    const column = x - box.rect.x - 2;
    return y === box.rect.y + (this.tokenRows(contentWidth).length + 3) && column >= 0 && column < Math.min(contentWidth, "▸ Composition".length);
  }

  private handleMouseInput(data: string): { consume: true } | undefined {
    const tui = this.options.tui;
    if (!tui) return undefined;
    if (isSidebarInputBlocked(tui)) { this.compositionPressed = false; return undefined; }
    const mouse = parseSgrMouseEvent(data);
    if (!mouse || (mouse.button & 64) !== 0) return undefined;
    const x = mouse.x - 1;
    const y = mouse.y - 1;
    if (mouse.release) {
      if (!this.compositionPressed) return undefined;
      this.compositionPressed = false;
      if (this.isCompositionTarget(x, y)) this.compositionExpanded = !this.compositionExpanded;
      tui.requestRender();
      return { consume: true };
    }
    if (mouse.motion) {
      if (!this.compositionPressed) return undefined;
      if (!this.isCompositionTarget(x, y)) this.compositionPressed = false;
      return { consume: true };
    }
    if ((mouse.button & 3) !== 0 || !this.isCompositionTarget(x, y)) return undefined;
    this.compositionPressed = true;
    return { consume: true };
  }

  private tokenRows(contentWidth: number): string[] {
    const totals = this.options.getTokenTotals?.();
    const input = `in ${formatTokens(totals?.input)}`;
    const output = `out ${formatTokens(totals?.output)}`;
    const cache = `cache ${formatTokens(totals?.cache)}`;
    const full = `${input} / ${output} / ${cache}`;
    if (visibleWidth(full) <= contentWidth) return [full];
    const first = `${input} / ${output}`;
    return visibleWidth(first) <= contentWidth ? [first, cache] : [input, output, cache];
  }

  render(width: number): string[] {
    const renderWidth = Math.max(1, Math.min(width, this.options.getDesiredWidth()));
    const contentWidth = Math.max(1, renderWidth - 4);
    const percent = this.options.getUsage()?.percent;
    const normalized = typeof percent === "number" && Number.isFinite(percent)
      ? Math.max(0, Math.min(100, percent)) : undefined;
    const color: PanelColor = normalized === undefined ? "dim" : normalized >= 85 ? "error" : normalized >= 60 ? "warning" : "success";
    const percentage = normalized === undefined ? "?%" : `${Math.round(normalized)}%`;
    const name = `${this.options.getModel() || "no-model"} · ${this.options.getThinkingLevel() || "off"} ·`;
    const nameWidth = Math.max(0, contentWidth - visibleWidth(percentage) - 1);
    const nameText = truncateToWidth(name, nameWidth, "…");
    const gap = " ".repeat(Math.max(1, contentWidth - visibleWidth(nameText) - visibleWidth(percentage)));
    const filled = normalized === undefined ? 0 : Math.round(contentWidth * normalized / 100);
    const rows = [
      panelTop(this.theme, "▾ КОНТЕКСТ", renderWidth),
      panelContent(this.theme, `${this.theme.fg("accent", nameText)}${gap}${this.theme.fg(color, percentage)}`, "dim", contentWidth),
      panelContent(this.theme, `${this.theme.fg(color, "█".repeat(filled))}${this.theme.fg("dim", "░".repeat(contentWidth - filled))}`, color, contentWidth),
      ...this.tokenRows(contentWidth).map(text => panelContent(this.theme, text, "dim", contentWidth)),
      panelContent(this.theme, `${this.compositionExpanded ? "▾" : "▸"} Composition`, this.compositionPressed ? "warning" : "accent", contentWidth),
    ];
    if (this.compositionExpanded) {
      const estimate = this.options.getEstimate?.();
      for (const category of estimate?.categories ?? []) {
        const value = category.tokens === undefined ? "?" : `~${formatTokens(category.tokens)}`;
        const percentage = category.percent === undefined ? "?" : `${Math.round(category.percent)}%`;
        const right = `${value} ${percentage}`;
        const label = truncateToWidth(`  ${category.name}`, Math.max(0, contentWidth - visibleWidth(right) - 1), "…");
        rows.push(panelContent(this.theme, `${label}${" ".repeat(Math.max(1, contentWidth - visibleWidth(label) - visibleWidth(right)))}${right}`, "dim", contentWidth));
      }
      if (!estimate) rows.push(panelContent(this.theme, "  No estimate", "dim", contentWidth));
      const images = estimate?.imagesWire;
      rows.push(panelContent(this.theme, `  Images ${images?.source === "unavailable" || !images ? "?" : images.images}`, "dim", contentWidth));
    }
    rows.push(panelBottom(this.theme, renderWidth));
    return rows.map(line => truncateToWidth(line, renderWidth, ""));
  }

  invalidate(): void {}
  dispose(): void { this.uninstallInput(); }
}
