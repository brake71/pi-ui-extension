import type { ContextUsage, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { panelBottom, panelContent, panelTop, type PanelColor } from "../sidebar/panel.ts";

import type { ContextEstimate } from "./data.ts";
import {
  formatDuration,
  formatTps,
  formatTtft,
  type RunActivitySnapshot,
} from "./activity.ts";

export type ContextPanelOptions = {
  readonly getEstimate?: () => ContextEstimate;
  readonly getDelta?: () => number | undefined;
  readonly getActivity?: () => RunActivitySnapshot | undefined;
  readonly now?: () => number;
  readonly getCacheHitRate?: () => number | undefined;
  readonly getCacheTokens?: () => number | undefined;
  readonly getUsage: () => ContextUsage | undefined;
  readonly getModel: () => string;
  readonly getThinkingLevel: () => string;
  readonly getDesiredWidth: () => number;
};

function gradientText(text: string): string {
  if (text.length === 0) return "";
  const start = [80, 200, 255];
  const end = [255, 80, 180];
  const last = Math.max(1, text.length - 1);
  return [...text].map((character, index) => {
    const ratio = index / last;
    const red = Math.round(start[0] + (end[0] - start[0]) * ratio);
    const green = Math.round(start[1] + (end[1] - start[1]) * ratio);
    const blue = Math.round(start[2] + (end[2] - start[2]) * ratio);
    return `\x1b[38;2;${red};${green};${blue}m${character}`;
  }).join("") + "\x1b[39m";
}

function formatContextWindow(contextWindow: number | undefined): string {
  if (!contextWindow) return "?";

  const scale = contextWindow >= 1_000_000 ? 1_000_000 : contextWindow >= 1_000 ? 1_000 : 1;
  const suffix = scale === 1_000_000 ? "M" : scale === 1_000 ? "K" : "";
  const value = contextWindow / scale;
  const amount = value.toFixed(value >= 10 ? 0 : 1).replace(/\.0$/, "");
  return `${amount}${suffix}`;
}

/** Activity rows moved into CTX: status/duration, AVERAGE TPS, latest TTFT. */
function activityRows(
  theme: Theme,
  getActivity: () => RunActivitySnapshot | undefined,
  now: () => number,
  contentWidth: number,
): string[] {
  const activity = getActivity();
  if (!activity) return [];
  const at = now();
  const duration = activity.phase === "settled"
    ? formatDuration(activity.durationMs ?? 0)
    : formatDuration(Math.max(0, at - (activity.startedAt ?? at)));
  const status = activity.phase === "idle"
    ? "Готово"
    : `${activity.turns.length} ход. · ${activity.phase === "running" ? duration : `${activity.aborted ? "прервано" : "готово"} ${duration}`}`;
  const plain = (value: string): string => value.replace(/\[[^\]]+\]/g, "");
  const average = `СРЕДН. TTFT ${plain(formatTtft(activity.averagePerformance?.ttftMs))} · TPS ${plain(formatTps(activity.averagePerformance?.tokensPerSecond))}`;
  const compact = `${activity.turns.length} ход. ${activity.phase === "settled" ? (activity.aborted ? "прервано " : "готово ") : ""}${duration}`;
  const narrowCompact = `${activity.turns.length}х ${activity.phase === "settled" ? (activity.aborted ? "прерв. " : "готово ") : ""}${duration}`;
  const header = [`${status} · ${average}`, status, compact, narrowCompact, average]
    .find((candidate) => visibleWidth(candidate) <= contentWidth) ?? compact;
  const statusColor: PanelColor = activity.phase === "running"
    ? "warning"
    : activity.aborted ? "warning" : activity.failedCount > 0 ? "error" : "success";
  const performances = activity.turns.map((turn) => turn.durationMs === undefined ? activity.performance : turn.performance);
  let ttft: number | undefined;
  for (let index = performances.length - 1; index >= 0; index--) {
    const value = performances[index]?.ttftMs;
    if (value !== undefined && Number.isFinite(value)) { ttft = value; break; }
  }
  const pending = activity.phase === "running" && activity.turns.length > 0 && ttft === undefined;
  return [
    panelContent(theme, "─".repeat(contentWidth), "dim", contentWidth),
    panelContent(theme, header, statusColor, contentWidth),
    // Latest observed TTFT, not the run average: AVG TTFT stays in the header.
    panelContent(theme, `TTFT ${formatTtft(ttft)}${pending ? " · ожидание" : ""}`, "accent", contentWidth),
  ];
}

export class ContextPanel implements Component {
  constructor(
    private readonly theme: Theme,
    private readonly options: ContextPanelOptions,
  ) {}

  render(width: number): string[] {
    const renderWidth = Math.max(1, Math.min(width, this.options.getDesiredWidth()));
    const contentWidth = Math.max(1, renderWidth - 4);
    const usage = this.options.getUsage();
    const percent = usage?.percent;
    const normalizedPercent = percent === null || percent === undefined
      ? undefined
      : Math.max(0, Math.min(100, percent));
    const color: PanelColor = normalizedPercent === undefined
      ? "dim"
      : normalizedPercent >= 85
        ? "error"
        : normalizedPercent >= 60
          ? "warning"
          : "success";
    const filledWidth = normalizedPercent === undefined
      ? 0
      : Math.round(contentWidth * normalizedPercent / 100);
    const contextWindow = formatContextWindow(usage?.contextWindow);
    const windowTokens = usage?.contextWindow;
    const rawDelta = this.options.getDelta?.();
    const delta = typeof rawDelta === "number" && Number.isFinite(rawDelta) && rawDelta !== 0 ? rawDelta : undefined;
    const baseSummary = `${normalizedPercent === undefined ? "?" : `${Math.round(normalizedPercent)}%`}/${contextWindow}`;
    const deltaSuffix = delta === undefined ? "" : ` ${delta > 0 ? "+" : "−"}${formatContextWindow(Math.abs(delta))}`;
    const deltaColor: PanelColor = delta !== undefined && delta < 0 ? "warning" : "accent";
    const summary = `${baseSummary}${deltaSuffix}`;
    const cacheHitRate = this.options.getCacheHitRate?.();
    const cacheTokens = this.options.getCacheTokens?.();
    const cacheRateLabel = cacheHitRate === undefined ? undefined : `${Math.round(Math.max(0, Math.min(100, cacheHitRate)))}%`;
    const cacheSummary = cacheTokens === undefined
      ? cacheRateLabel === undefined ? "Кэш:?" : `Кэш:${cacheRateLabel}`
      : `Кэш: ${formatContextWindow(cacheTokens)} ток. · ${cacheRateLabel ?? "?%"}`;
    const summaryText = `${this.theme.fg(color, baseSummary)}${deltaSuffix ? this.theme.fg(deltaColor, deltaSuffix) : ""}`;
    const cacheFitsBesideSummary = visibleWidth(summary) + visibleWidth(cacheSummary) + 1 <= contentWidth;
    const summaryRow = cacheFitsBesideSummary
      ? `${summaryText}${" ".repeat(contentWidth - visibleWidth(summary) - visibleWidth(cacheSummary))}${this.theme.fg(color, cacheSummary)}`
      : summaryText;
    const cacheRow = cacheFitsBesideSummary ? undefined : panelContent(this.theme, cacheSummary, color, contentWidth);
    const deltaWidth = delta === undefined || delta <= 0 || filledWidth === 0 ||
      typeof windowTokens !== "number" || !Number.isFinite(windowTokens) || windowTokens <= 0
      ? 0
      : Math.min(filledWidth, Math.max(1, Math.round(contentWidth * delta / windowTokens)));
    const model = this.options.getModel() || "no-model";
    const thinking = this.options.getThinkingLevel() || "off";
    const modelLabel = `${this.theme.fg("accent", model)}${this.theme.fg("dim", "｜")}${gradientText(thinking)}`;

    const rows: string[] = [];
    const row = (text: string): void => { rows.push(panelContent(this.theme, text, "dim", contentWidth)); };
    const estimate = this.options.getEstimate?.();
    const amount = (tokens: number | undefined, percent: number | undefined): string =>
      tokens === undefined ? "нет данных" : `~${tokens === 0 ? "0" : formatContextWindow(tokens)} ${percent === undefined ? "?" : percent.toFixed(1)}%`;
    const alignedRow = (label: string, value: string, labelColor: PanelColor = "dim", valueColor: PanelColor = "dim"): void => {
      const gap = contentWidth - visibleWidth(label) - visibleWidth(value) - 1;
      if (gap >= 1) {
        row(`${this.theme.fg(labelColor, label)}${" ".repeat(gap)}${this.theme.fg(valueColor, value)}`);
      } else {
        row(this.theme.fg(labelColor, truncateToWidth(label, contentWidth, "…")));
        row(this.theme.fg(valueColor, value));
      }
    };
    const estimateRow = (label: string, tokens: number | undefined, percent: number | undefined): void => {
      alignedRow(`${label}:`, amount(tokens, percent));
    };
    const imagesWire = estimate?.imagesWire ?? { images: 0, source: "unavailable" as const };
    const imageLabel = imagesWire.source === "unavailable" ? "⚠ Изображения" : "Изображения";
    const imageValue = imagesWire.source === "unavailable"
      ? "нет данных"
      : `${imagesWire.images} шт.`;
    row("─".repeat(contentWidth));
    for (const category of estimate?.categories ?? []) {
      const labels: Record<string, string> = {
        System: "Система", Tools: "Инструм.", Messages: "Сообщения",
        "Tool Results": "Результаты", Summary: "Сводка", Other: "Другое",
      };
      estimateRow(labels[category.name] ?? category.name, category.tokens, category.percent);
    }
    if (!estimate) row("Нет данных для отображения");
    alignedRow(imageLabel, imageValue, imagesWire.source === "unavailable" ? "warning" : "dim", "dim");
    return [
      panelTop(this.theme, "КОНТЕКСТ", renderWidth),
      panelContent(this.theme, modelLabel, "accent", contentWidth),
      panelContent(this.theme, summaryRow, color, contentWidth),
      ...(cacheRow ? [cacheRow] : []),
      panelContent(
        this.theme,
        `${this.theme.fg(color, "█".repeat(filledWidth - deltaWidth))}${deltaWidth > 0 ? this.theme.fg("accent", "█".repeat(deltaWidth)) : ""}${this.theme.fg(color, "░".repeat(contentWidth - filledWidth))}`,
        color,
        contentWidth,
      ),
      ...rows,
      ...activityRows(
        this.theme,
        this.options.getActivity ?? (() => undefined),
        this.options.now ?? Date.now,
        contentWidth,
      ),
      panelBottom(this.theme, renderWidth),
    ].map((line) => truncateToWidth(line, renderWidth, ""));
  }

  invalidate(): void {}

}
