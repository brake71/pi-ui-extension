import {
  AssistantMessageComponent,
  type MarkdownTransformContext,
  type MarkdownTransformer,
} from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  type Component,
  type DefaultTextStyle,
  type MarkdownTheme,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
  ASSUMED_OUTPUT_PAD,
  defaultThinkingColors,
  markdownThinkingColors,
  normalizeOutputPad,
  renderThinkingHeader,
  thinkingRuns,
  ThinkingBlockView,
  type ThinkingColors,
  type ThinkingRun,
  type ThinkingStatus,
} from "./thinking.ts";
import type { ToolViewMode } from "./types.ts";

const ADAPTER_KEY = Symbol.for("pi-ui-extension:compact-thinking-adapter");
/** A /reload must also unwrap the earlier click-guard generation. */
const PREVIOUS_ADAPTER_KEYS = [Symbol.for("pi-ui-extension:thinking-click-guard")];

type AdapterRecord = {
  original: AssistantMessageComponent["updateContent"];
  patched: AssistantMessageComponent["updateContent"];
};
type AdapterPrototype = typeof AssistantMessageComponent.prototype & Record<symbol, AdapterRecord | undefined>;
type ComponentInternals = {
  contentContainer?: { children?: unknown[]; addChild?: (child: Component) => void };
  markdownTransformers?: readonly MarkdownTransformer[];
  isStreaming?: boolean;
  /** Pi 1.5 session entry identity for this message; absent on live messages. */
  messageId?: string;
  timestamp?: string;
  /** Pi's own Thinking visibility state; both must be honored, never bypassed. */
  hideThinkingBlock?: boolean;
  thinkingVisibilityOverrides?: Map<number, boolean>;
  outputPad?: number;
};
type ThinkingRegion = {
  child: unknown;
  onMouse: (event: TuiMouseEvent) => TuiMouseEventResult | undefined;
};
type MarkdownShape = {
  theme: MarkdownTheme;
  defaultTextStyle?: DefaultTextStyle;
  /** Pi's native horizontal padding for this message, when readable. */
  paddingX?: number;
};
type ThinkingBlockLike = { type: string; thinking?: string; text?: string; name?: string };
/** Pi 1.5 adds the persisted session entry id and ISO timestamp; live messages may carry neither. */
type MessageHistory = { messageId?: string; timestamp?: string };

export interface CompactThinkingOptions {
  /** Explicit thinking_end phase plus measured time for one Thinking run. */
  status: (text: string, streaming: boolean) => ThinkingStatus;
  /**
   * Whether a following tool call gets its native leading blank row trimmed, so
   * an expanded body has to supply that row itself. The caller knows its own
   * tools; anything else keeps Pi's own gap. Defaults to false.
   */
  needsToolGap?: (toolName: string) => boolean;
}

/**
 * Per AssistantMessageComponent and Thinking run index. A WeakMap keeps
 * expansion out of the message content and lets discarded components go.
 */
const expansion = new WeakMap<AssistantMessageComponent, Map<number, boolean>>();

function isExpanded(component: AssistantMessageComponent, index: number, mode: ToolViewMode): boolean {
  return expansion.get(component)?.get(index) ?? (mode === "focus");
}

function toggleExpanded(component: AssistantMessageComponent, index: number, mode: ToolViewMode): void {
  const runs = expansion.get(component) ?? new Map<number, boolean>();
  expansion.set(component, runs);
  runs.set(index, !isExpanded(component, index, mode));
}

function isThinkingRegion(child: unknown): child is ThinkingRegion {
  // Bundled Pi CLI and the extension's SDK can load distinct TUI classes.
  // Native MouseRegion identity is not stable across that boundary.
  return !!child && typeof child === "object" && "child" in child &&
    typeof (child as { onMouse?: unknown }).onMouse === "function";
}

function readMarkdownShape(child: unknown): MarkdownShape | undefined {
  const internals = child as unknown as {
    theme?: MarkdownTheme;
    defaultTextStyle?: DefaultTextStyle;
    paddingX?: unknown;
  };
  const theme = internals.theme;
  if (!theme || typeof theme.quoteBorder !== "function" || typeof theme.heading !== "function" ||
      typeof theme.bold !== "function") return undefined;
  const style = internals.defaultTextStyle;
  return {
    theme,
    defaultTextStyle: style && typeof style === "object" ? style : undefined,
    paddingX: normalizeOutputPad(internals.paddingX),
  };
}

/** Pi's message output padding, read from the component when present. */
function readOutputPad(component: AssistantMessageComponent | ComponentInternals): number | undefined {
  return normalizeOutputPad((component as ComponentInternals).outputPad);
}

function applyTransformers(
  markdown: string,
  context: MarkdownTransformContext & MessageHistory,
  transformers: readonly MarkdownTransformer[],
): string {
  let transformed = markdown;
  for (const transformer of transformers) {
    try {
      const next = transformer(transformed, context);
      if (typeof next === "string") transformed = next;
    } catch {
      // Keep the current Markdown and continue, exactly like Pi's own pipeline.
    }
  }
  return transformed;
}

/**
 * Rebuild the native Thinking body without this extension's transformer, so an
 * expanded block keeps Pi's Markdown styling and every other transformer.
 */
function createBody(
  text: string,
  shape: MarkdownShape,
  transformers: readonly MarkdownTransformer[],
  streaming: boolean,
  // Pi hands these to its own Markdown; a rebuilt body must pass them on unchanged.
  history: MessageHistory,
): Markdown {
  const style = shape.defaultTextStyle ?? { color: shape.theme.quote, italic: true };
  const transform = transformers.length === 0
    ? undefined
    : (markdown: string, availableWidth: number) =>
      applyTransformers(markdown, {
        messageType: "assistant-thinking", isStreaming: streaming, availableWidth, ...history,
      }, transformers);
  // Padding is applied by ThinkingBlockView so the quote bar can sit inside it.
  return new Markdown(text, 0, 0, shape.theme, style, transform ? { transform } : undefined);
}

/** Index of the last block of the Thinking run that starts at `startIndex`. */
function runEndIndex(content: readonly ThinkingBlockLike[], startIndex: number): number {
  let end = startIndex;
  while (content[end + 1]?.type === "thinking") end++;
  return end;
}

/**
 * Pi inserts its own Spacer after a Thinking run as soon as another visible
 * text/Thinking block follows, and a tool row supplies its own leading gap
 * unless this extension's spacing guard trims it. So an expanded body supplies
 * that single gap itself only before a tool call it knows the guard trims: an
 * existing native spacer, a third-party tool row and the truncation notice
 * already have one.
 */
function needsTrailingBlank(
  content: readonly ThinkingBlockLike[],
  startIndex: number,
  stopReason: string | undefined,
  options: CompactThinkingOptions,
): boolean {
  // Pi adds a Spacer before the truncation notice after the content loop.
  if (stopReason === "length") return false;
  const after = content.slice(runEndIndex(content, startIndex) + 1);
  const visibleAfter = after.some((block) =>
    (block.type === "text" && (block.text ?? "").trim()) ||
    (block.type === "thinking" && (block.thinking ?? "").trim()));
  if (visibleAfter) return false;
  // Only the first following tool decides: a third-party tool keeps its own gap.
  const firstTool = after.find((block) => block.type === "toolCall");
  return firstTool !== undefined && (options.needsToolGap?.(firstTool.name ?? "") ?? false);
}

function decorateRegion(
  component: AssistantMessageComponent,
  region: ThinkingRegion,
  index: number,
  run: ThinkingRun,
  mode: Exclude<ToolViewMode, "normal">,
  streaming: boolean,
  transformer: MarkdownTransformer,
  options: CompactThinkingOptions,
  content: readonly ThinkingBlockLike[],
  stopReason: string | undefined,
): void {
  const child = region.child;
  // A native Text region means Pi already hides Thinking (hideThinkingBlock or
  // a per-run override); it keeps its native read-only behavior.
  const shape = readMarkdownShape(child);
  if (!shape) return;
  const colors: ThinkingColors = markdownThinkingColors(shape.theme, shape.defaultTextStyle?.color);
  const status = options.status(run.text, streaming);
  // Everything except this extension's transformer still applies to the body.
  const internals = component as unknown as ComponentInternals;
  const others = (internals.markdownTransformers ?? [])
    .filter((candidate) => candidate !== transformer);
  const body = mode !== "hidden"
    ? createBody(run.text, shape, others, streaming, { messageId: internals.messageId, timestamp: internals.timestamp })
    : undefined;
  const nativeOnMouse = region.onMouse;
  region.child = new ThinkingBlockView({
    header: (width) => renderThinkingHeader({
      status,
      colors,
      width,
      disclosure: mode !== "hidden",
      expanded: isExpanded(component, index, mode),
    }),
    // Keep Pi's own message padding so the title, the quote bar and the
    // surrounding assistant text all start on the same column.
    outputPad: shape.paddingX ?? readOutputPad(component) ?? ASSUMED_OUTPUT_PAD,
    body,
    colors,
    expanded: () => isExpanded(component, index, mode),
    toggleable: () => mode !== "hidden",
    onToggle: () => toggleExpanded(component, index, mode),
    trailingBlank: () => needsTrailingBlank(content, run.startIndex, stopReason, options),
  });
  // The view handles title clicks itself; everything else must stay a no-op so
  // Pi's global Thinking override never replaces the Compact/Hidden title.
  region.onMouse = (event) => {
    if (event.type === "click" && event.button === "left") return { handled: true };
    return nativeOnMouse(event);
  };
}

/**
 * Start index of the trailing Thinking run when that whole contiguous run is
 * still empty, i.e. Pi skipped it and would show nothing.
 */
function emptyTrailingRunStart(content: readonly ThinkingBlockLike[]): number | undefined {
  const last = content.at(-1);
  if (!last || last.type !== "thinking") return undefined;
  let start = content.length - 1;
  while (start > 0 && content[start - 1]?.type === "thinking") start--;
  const hasText = content.slice(start).some((block) => (block.thinking ?? "").trim().length > 0);
  return hasText ? undefined : start;
}

/**
 * Pi skips a Thinking block while its text is still empty, so a run that has
 * only emitted thinking_start would show nothing. Append the live title until
 * the first delta arrives. It reuses the run index the real region will get, so
 * a user who expands the empty title keeps it expanded once text arrives, and
 * it never duplicates an adjacent run that Pi already rendered.
 */
function decoratePendingRun(
  component: AssistantMessageComponent,
  content: readonly ThinkingBlockLike[],
  runs: readonly ThinkingRun[],
  mode: Exclude<ToolViewMode, "normal">,
  streaming: boolean,
  options: CompactThinkingOptions,
): void {
  if (!streaming) return;
  const start = emptyTrailingRunStart(content);
  if (start === undefined) return;
  // An adjacent run with content owns this index; never add a second title.
  if (runs.some((run) => run.startIndex === start)) return;
  const internals = component as unknown as ComponentInternals;
  // Respect Pi's global hide switch and its per-run click override.
  const index = runs.length;
  if (internals.hideThinkingBlock === true ||
      internals.thinkingVisibilityOverrides?.get(index) === true) return;
  // Only a run that is genuinely still thinking gets a title; an empty run that
  // already ended, or a message that moved on to text, stays invisible.
  if (options.status("", true).phase !== "streaming") return;
  const container = internals.contentContainer;
  if (typeof container?.addChild !== "function") return;
  const colors = defaultThinkingColors();
  container.addChild(new ThinkingBlockView({
    header: (width) => renderThinkingHeader({
      status: { phase: "streaming" },
      colors,
      width,
      disclosure: mode !== "hidden",
      expanded: isExpanded(component, index, mode),
    }),
    outputPad: readOutputPad(component) ?? ASSUMED_OUTPUT_PAD,
    colors,
    expanded: () => isExpanded(component, index, mode),
    toggleable: () => mode !== "hidden",
    onToggle: () => toggleExpanded(component, index, mode),
  }));
}

function decorate(
  component: AssistantMessageComponent,
  message: { content?: readonly ThinkingBlockLike[]; stopReason?: string },
  transformer: MarkdownTransformer,
  getMode: () => ToolViewMode,
  options: CompactThinkingOptions,
): void {
  const internals = component as unknown as ComponentInternals;
  // Only touch components that were built with this extension's transformer.
  if (!internals.markdownTransformers?.includes(transformer)) return;
  const mode = getMode();
  if (mode === "normal") return;
  const content = message.content ?? [];
  const children = internals.contentContainer?.children;
  if (!Array.isArray(children)) return;
  const runs = thinkingRuns(content);
  const regions = children.filter(isThinkingRegion);
  // An unexpected shape means another Pi version or another extension changed
  // the message layout: keep Pi's native rendering instead of guessing.
  if (regions.length !== runs.length) return;
  const streaming = internals.isStreaming === true;
  for (let index = 0; index < regions.length; index++) {
    decorateRegion(
      component, regions[index]!, index, runs[index]!, mode, streaming, transformer, options,
      content, message.stopReason,
    );
  }
  decoratePendingRun(component, content, runs, mode, streaming, options);
}

/**
 * Undo an earlier install, including the previous click-guard generation used
 * before /reload. Fails closed: when a marker is present but our patch is no
 * longer the active `updateContent`, another patch sits on top of ours. We then
 * leave everything untouched and refuse to install, so we never stack onto or
 * break someone else's patch.
 */
function unwrapPreviousAdapters(prototype: AdapterPrototype): boolean {
  const pending: Array<{ key: symbol; record: AdapterRecord }> = [];
  for (const key of [ADAPTER_KEY, ...PREVIOUS_ADAPTER_KEYS]) {
    const record = prototype[key] as AdapterRecord | undefined;
    if (record === undefined) continue;
    if (!record || typeof record.original !== "function" || typeof record.patched !== "function") return false;
    if (prototype.updateContent !== record.patched) return false;
    pending.push({ key, record });
  }
  for (const { key, record } of pending) {
    prototype.updateContent = record.original;
    delete prototype[key];
  }
  return true;
}

/**
 * Shape-gated adapter: it replaces the native Thinking region child of
 * components that use this extension's transformer with a title-only block
 * that expands on a title click. `decorate()` re-checks Pi's layout on every
 * render (region count, Markdown shape, transformer identity) and keeps native
 * behavior on an unknown shape, so no exact-version whitelist is needed. A
 * version list would only mean that a Pi version update silently disables
 * Thinking clicks instead of failing shut on a real layout change.
 */
export function installCompactThinkingAdapter(
  getMode: () => ToolViewMode,
  transformer: MarkdownTransformer,
  options: CompactThinkingOptions,
  hostPrototype: typeof AssistantMessageComponent.prototype = AssistantMessageComponent.prototype,
): boolean {
  const prototype = hostPrototype as AdapterPrototype;
  if (typeof prototype.updateContent !== "function" ||
      typeof prototype.setHiddenThinkingLabel !== "function") return false;

  if (!unwrapPreviousAdapters(prototype)) return false;
  const original = prototype.updateContent;
  const patched: typeof original = function (this: AssistantMessageComponent, ...args) {
    original.apply(this, args);
    try {
      decorate(this, args[0] as { content?: readonly ThinkingBlockLike[]; stopReason?: string },
        transformer, getMode, options);
    } catch {
      // Display must never break the transcript.
    }
  };
  prototype.updateContent = patched;
  prototype[ADAPTER_KEY] = { original, patched };
  return true;
}
