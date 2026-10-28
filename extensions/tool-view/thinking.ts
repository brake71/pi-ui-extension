import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { MarkdownTransformContext } from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
  type MarkdownTheme,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { ToolViewMode } from "./types.ts";

/**
 * Braille indicator for a live Thinking run. The frame is derived from the
 * clock at render time, so animating it never creates a timer that can leak.
 */
export const THINKING_INDICATOR_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const INDICATOR_FRAME_MS = 100;
/** Grey quote bar in front of every expanded Thinking body line. */
const BODY_BAR = "│ ";
const COLLAPSED_GLYPH = "+";
const EXPANDED_GLYPH = "−";

export interface ThinkingDuration {
  ms: number;
  approximate: boolean;
}

export type ThinkingPhase = "streaming" | "complete";

export interface ThinkingStatus {
  phase: ThinkingPhase;
  /** Only set for a measured run; never invented for history or interrupted runs. */
  duration?: ThinkingDuration;
}

/** Theme-derived styling shared by the Compact/Hidden adapter and the fallback transformer. */
export interface ThinkingColors {
  /** Completed title, warm like a finished note. */
  accent: (text: string) => string;
  /** Live indicator glyph. */
  indicator: (text: string) => string;
  /** Live title and Thinking body text. */
  label: (text: string) => string;
  bold: (text: string) => string;
  /** Grey bar in front of each expanded body line. */
  bar: (text: string) => string;
}

export interface ThinkingRun {
  startIndex: number;
  /** Consecutive Thinking blocks joined exactly like Pi's native renderer. */
  text: string;
}

type ThinkingBlockLike = { type: string; thinking?: string; text?: string };

/**
 * Group consecutive Thinking blocks the way Pi's AssistantMessageComponent
 * does, so run indexes line up with the MouseRegions it builds.
 */
export function thinkingRuns(content: readonly ThinkingBlockLike[] | undefined): ThinkingRun[] {
  const runs: ThinkingRun[] = [];
  const blocks = content ?? [];
  let index = 0;
  while (index < blocks.length) {
    if (blocks[index]?.type !== "thinking") {
      index++;
      continue;
    }
    const startIndex = index;
    const parts: string[] = [];
    while (index < blocks.length && blocks[index]?.type === "thinking") {
      const text = blocks[index]?.thinking?.trim();
      if (text) parts.push(text);
      index++;
    }
    if (parts.length > 0) runs.push({ startIndex, text: parts.join("\n\n") });
  }
  return runs;
}

export function markdownThinkingColors(
  markdownTheme: MarkdownTheme,
  bodyColor?: (text: string) => string,
): ThinkingColors {
  const label = bodyColor ?? markdownTheme.quote;
  return {
    accent: markdownTheme.heading,
    indicator: label,
    label,
    bold: markdownTheme.bold,
    bar: markdownTheme.quoteBorder,
  };
}

let cachedDefaultColors: ThinkingColors | undefined;

/**
 * Colors for renders that have no native Markdown child to borrow from, such
 * as the fallback transformer. The cached functions read the live theme, so a
 * theme switch still applies.
 */
export function defaultThinkingColors(): ThinkingColors {
  cachedDefaultColors ??= markdownThinkingColors(getMarkdownTheme());
  return cachedDefaultColors;
}

export function thinkingIndicatorFrame(now: number): string {
  const clock = Number.isFinite(now) ? Math.max(0, now) : 0;
  return THINKING_INDICATOR_FRAMES[Math.floor(clock / INDICATOR_FRAME_MS) % THINKING_INDICATOR_FRAMES.length]!;
}

/**
 * Measured Thinking time. Everything under a minute keeps one decimal so 1.3s
 * is never rounded to 1s; a minute or more uses the compact 1m05s form.
 */
export function formatThinkingDuration(duration?: ThinkingDuration): string {
  if (!duration || !Number.isFinite(duration.ms) || duration.ms < 0) return "";
  const tenths = Math.max(1, Math.round(duration.ms / 100));
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  const seconds = Math.max(1, Math.round(duration.ms / 1_000));
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

export interface ThinkingHeaderOptions {
  status: ThinkingStatus;
  colors: ThinkingColors;
  /** Compact draws the +/− disclosure glyph; Hidden stays read-only. */
  disclosure?: boolean;
  expanded?: boolean;
  /** Clock for the live frame; injectable for tests. */
  now?: number;
  width?: number;
}

/** Single title line for every Thinking state. */
export function renderThinkingHeader(options: ThinkingHeaderOptions): string {
  const { status, colors } = options;
  let header: string;
  if (status.phase === "streaming") {
    const frame = colors.indicator(thinkingIndicatorFrame(options.now ?? Date.now()));
    header = `${frame} ${colors.label(colors.bold("Думает"))}`;
  } else {
    const glyph = options.disclosure ? `${options.expanded ? EXPANDED_GLYPH : COLLAPSED_GLYPH} ` : "";
    const duration = formatThinkingDuration(status.duration);
    const label = `${glyph}Размышление${duration ? ` · ${duration}` : ""}`;
    header = colors.accent(colors.bold(label));
  }
  if (options.width === undefined) return header;
  return truncateToWidth(header, Math.max(1, options.width), "…");
}

/**
 * Prefix every body row with the grey quote bar. Paragraph breaks keep their
 * row and get the bar alone, so the column stays continuous. `indent` shifts
 * the bar to the message's native output padding so the bar lines up with the
 * title and with Pi's own message text.
 */
export function decorateThinkingBody(
  lines: readonly string[],
  colors: ThinkingColors,
  indent = "",
): string[] {
  const bar = indent + BODY_BAR;
  const bareBar = bar.trimEnd();
  return lines.map((line) => (stripTerminalSequences(line).trim().length > 0
    ? colors.bar(bar) + line
    : colors.bar(bareBar)));
}

/** Native message output padding, read defensively from Pi's own Markdown child. */
const MAX_OUTPUT_PAD = 16;
/** Pi's own constructor default for assistant-message output padding. */
export const ASSUMED_OUTPUT_PAD = 1;

/** Clamp an untyped padding value to something safe to render. */
export function normalizeOutputPad(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(MAX_OUTPUT_PAD, Math.floor(value));
}

/**
 * Title-only Thinking block. The body is a native-quality Markdown component
 * rendered at bar width; the title row is the only click target. Both rows keep
 * the message's native output padding so the block lines up with Pi's own text.
 */
export class ThinkingBlockView implements Component {
  private titleStart = 0;
  private titleWidth = 0;

  constructor(private readonly options: ThinkingBlockOptions) {}

  private outputPad(): number {
    return normalizeOutputPad(this.options.outputPad) ?? 0;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const pad = Math.min(this.outputPad(), Math.max(0, safeWidth - 1));
    const header = " ".repeat(pad) + this.options.header(Math.max(1, safeWidth - pad));
    this.titleStart = pad;
    this.titleWidth = visibleWidth(header);
    const body = this.options.body;
    if (!body || !this.options.expanded()) return [header];
    // Reserve the padding on both sides like Pi's native Markdown, plus the bar.
    const bodyWidth = safeWidth - pad * 2 - 2;
    const rows = body.render(Math.max(1, bodyWidth));
    if (rows.length === 0) return [header];
    // A terminal too narrow for padding + bar falls back to bare, clipped text.
    const decorated = bodyWidth >= 1
      ? decorateThinkingBody(rows, this.options.colors, " ".repeat(pad))
      : rows.map((line) => (stripTerminalSequences(line).trim().length > 0 ? line : ""));
    // The body starts on the row below the title and, when the layout asks for
    // it, ends with exactly one blank row before whatever follows.
    const lines = this.options.trailingBlank?.() ? [header, ...decorated, ""] : [header, ...decorated];
    return lines.map((line) => visibleWidth(line) <= safeWidth ? line : truncateToWidth(line, safeWidth, ""));
  }

  invalidate(): void {
    this.options.body?.invalidate?.();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "click" || event.button !== "left") return undefined;
    if (event.y !== 0 || event.x < this.titleStart || event.x >= this.titleWidth) return undefined;
    if (!this.options.toggleable()) return undefined;
    this.options.onToggle();
    return { handled: true, render: true };
  }
}

export interface ThinkingBlockOptions {
  readonly header: (width: number) => string;
  /** Pi's message output padding; titles and the quote bar align to it. */
  readonly outputPad?: number;
  /** Native-quality body; undefined keeps the block read-only (Hidden). */
  readonly body?: Component;
  readonly colors: ThinkingColors;
  readonly expanded: () => boolean;
  readonly toggleable: () => boolean;
  readonly onToggle: () => void;
  /**
   * Whether an expanded body needs one blank row after its last line. Called at
   * render time, because the surrounding layout can change while it is open.
   */
  readonly trailingBlank?: () => boolean;
}

/**
 * Render-only fallback for Pi builds where the component adapter is not
 * installed: Compact shows the collapsed title instead of a body preview.
 */
export function transformThinkingText(
  markdown: string,
  context: MarkdownTransformContext,
  mode: ToolViewMode,
  getStatus?: (markdown: string, streaming: boolean) => ThinkingStatus,
): string {
  if (context.messageType !== "assistant-thinking" || mode === "normal") return markdown;
  const status = getStatus?.(markdown, context.isStreaming) ?? {
    phase: context.isStreaming ? "streaming" : "complete",
  };
  return renderThinkingHeader({
    status,
    colors: defaultThinkingColors(),
    disclosure: mode === "compact",
    expanded: false,
    width: Math.max(1, context.availableWidth),
  });
}
