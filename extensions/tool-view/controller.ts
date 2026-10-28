import {
  AssistantMessageComponent,
  getAgentDir,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
  type ToolRenderers,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { readFile, rename, writeFile } from "node:fs/promises";
import { TOOL_VIEW_MODES, isToolViewMode, type ToolViewMode } from "./types.ts";
import { renderCodemodeCompactCall, renderCodemodeCompactResult, singleLine } from "./codemode-compact.ts";
import { transformThinkingText } from "./thinking.ts";
import { ThinkingTiming } from "./thinking-timing.ts";
import { installCompactThinkingAdapter } from "./thinking-adapter.ts";
import { createDialogUI } from "../dialogs/index.ts";
import { compactCallPrefix, withCompactResultBranch, withNativeChevron } from "./chevron.ts";
import { installCompactSpacingGuard, markCompactSpacingRenderer } from "./compact-spacing.ts";

const DEFAULT_MODE_FILE = resolve(getAgentDir(), "tool-view-mode.json");
const MODE_STATUS_ID = "pi-ui-extension:tool-view";
const MODE_COMMAND = "tool-view";
const MODE_SHORTCUT = "ctrl+shift+o";
const MODE_ORDER = TOOL_VIEW_MODES;

type AnyToolResult = AgentToolResult<any>;
type AnyRenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];

type RendererState = {
  nativeState?: any;
  nativeCallComponent?: ReturnType<NonNullable<ToolRenderers["renderCall"]>>;
  nativeResultComponent?: ReturnType<NonNullable<ToolRenderers["renderResult"]>>;
  nativeBox?: Box;
  compactStartedAt?: number;
  compactTicker?: ReturnType<typeof setInterval>;
  compactInvalidate?: () => void;
};

interface StoredMode {
  mode: ToolViewMode;
}

interface CompactToolSpec {
  call(args: any): { title: string; detail?: string };
  result(result: AnyToolResult, context: AnyRenderContext, options: ToolRenderResultOptions): string;
}

function modeLabel(mode: ToolViewMode): string {
  switch (mode) {
    case "normal": return "Полный";
    case "compact": return "Краткий";
    case "hidden": return "Скрытый";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compactText(value: unknown, maxLength = 96): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function textOutput(result: AnyToolResult): string {
  return result.content
    .filter((item): item is Extract<(typeof result.content)[number], { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function nonEmptyLineCount(text: string): number {
  if (!text.trim()) return 0;
  return text.split("\n").filter((line) => line.trim().length > 0).length;
}

function itemCount(text: string): number {
  return nonEmptyLineCount(text);
}

function formatCount(count: number, forms: readonly [string, string, string]): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  const form = mod100 >= 11 && mod100 <= 14 ? forms[2]
    : mod10 === 1 ? forms[0] : mod10 >= 2 && mod10 <= 4 ? forms[1] : forms[2];
  return `${count} ${form}`;
}

function diffStats(diff: string | undefined): string {
  if (!diff) return "Применено";
  let additions = 0;
  let removals = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }
  return `+${additions}/-${removals}`;
}

function isPathInside(filePath: string, root: string): boolean {
  const pathFromRoot = relative(root, filePath);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function resolveToolPath(cwd: string, value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return resolve(cwd, value);
}

function isLikelySkillPath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  return (
    normalized.includes("/.agents/skills/") ||
    normalized.includes("/.pi/agent/skills/") ||
    normalized.includes("/.pi/skills/")
  );
}

const COMPACT_SPECS: Record<string, CompactToolSpec> = {
  read: {
    call: (args) => ({ title: "read", detail: compactText(args.path) || "…" }),
    result: (result) => {
      const output = textOutput(result);
      const imageCount = result.content.filter((item) => item.type === "image").length;
      if (imageCount > 0 && !output.trim()) return formatCount(imageCount, ["изображение", "изображения", "изображений"]);
      return formatCount(output.split("\n").length, ["строка", "строки", "строк"]);
    },
  },
  bash: {
    call: (args) => ({ title: "bash", detail: compactText(args.command) || "…" }),
    result: (result) => {
      const lines = nonEmptyLineCount(textOutput(result));
      return lines > 0 ? formatCount(lines, ["строка", "строки", "строк"]) : "";
    },
  },
  edit: {
    call: (args) => ({ title: "edit", detail: compactText(args.path) || "…" }),
    result: (result) => diffStats(result.details?.diff),
  },
  write: {
    call: (args) => {
      const lines = typeof args.content === "string" ? args.content.split("\n").length : 0;
      return {
        title: "write",
        detail: `${compactText(args.path) || "…"}${lines > 0 ? ` · ${formatCount(lines, ["строка", "строки", "строк"])}` : ""}`,
      };
    },
    result: () => "Сохранено",
  },
  grep: {
    call: (args) => ({
      title: "grep",
      detail: `${compactText(args.pattern) || "…"} · ${compactText(args.path) || "."}`,
    }),
    result: (result) => formatCount(itemCount(textOutput(result)), ["совпадение", "совпадения", "совпадений"]),
  },
  find: {
    call: (args) => ({
      title: "find",
      detail: `${compactText(args.pattern) || "…"} · ${compactText(args.path) || "."}`,
    }),
    result: (result) => formatCount(itemCount(textOutput(result)), ["файл", "файла", "файлов"]),
  },
  ls: {
    call: (args) => ({ title: "ls", detail: compactText(args.path) || "." }),
    result: (result) => formatCount(itemCount(textOutput(result)), ["элемент", "элемента", "элементов"]),
  },
};

/** Tool names this extension renders itself, so Compact also trims their leading blank. */
function ownsCompactTool(toolName: string): boolean {
  return toolName === "codemode" || Object.hasOwn(COMPACT_SPECS, toolName);
}

export interface ToolViewController {
  getMode(): ToolViewMode;
  setMode(mode: ToolViewMode, ctx: ExtensionContext, notify?: boolean): Promise<void>;
  onModeChange(listener: (mode: ToolViewMode) => void): () => void;
}

export type ToolViewControllerOptions = {
  readonly modeFile?: string;
};

export async function installToolViewController(
  pi: ExtensionAPI,
  options: ToolViewControllerOptions = {},
): Promise<ToolViewController> {
  const modeFile = options.modeFile ?? DEFAULT_MODE_FILE;
  let mode = await loadMode();
  // Set once the spacing guard is active; the Thinking gap depends on it.
  let compactSpacingActive = false;
  let skillRoots = new Set<string>();
  let activeSessionId: string | undefined;
  let sessionGeneration = 0;
  let modeChangeQueue = Promise.resolve();
  const modeListeners = new Set<(mode: ToolViewMode) => void>();
  const supportsThinking = typeof pi.registerMarkdownTransformer === "function";
  const thinkingTiming = new ThinkingTiming();
  // Undo the v1.2.8 in-memory click adapter when upgrading with Pi's /reload.
  // The current adapter owns only the Thinking region child of components built
  // with this extension's transformer; every other component, including Pi's
  // own Thinking click handler, keeps its native behavior.
  const legacyKey = Symbol.for("pi-ui-extension:thinking-click-adapter");
  const componentPrototype = AssistantMessageComponent.prototype as unknown as
    Record<symbol | "updateContent", any>;
  const legacy = componentPrototype[legacyKey] as
    { original?: unknown; patched?: unknown } | undefined;
  if (legacy && typeof legacy.original === "function" &&
      componentPrototype.updateContent === legacy.patched) {
    componentPrototype.updateContent = legacy.original;
    delete componentPrototype[legacyKey];
  }
  const thinkingStatus = (text: string, streaming: boolean) => thinkingTiming.status(text, streaming);
  const thinkingTransformer: Parameters<ExtensionAPI["registerMarkdownTransformer"]>[0] =
    (markdown, context) => transformThinkingText(markdown, context, mode, thinkingStatus);
  if (supportsThinking) {
    pi.registerMarkdownTransformer(thinkingTransformer);
    installCompactThinkingAdapter(() => mode, thinkingTransformer, {
      status: thinkingStatus,
      // Pi's own tool row keeps its leading blank row unless the spacing guard
      // below trims it, so only then does an expanded body supply that row.
      needsToolGap: (toolName) => compactSpacingActive && ownsCompactTool(toolName),
    });
  }
  let nativeThinkingWarningShown = false;
  const warnNativeThinkingHidden = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui" || nativeThinkingWarningShown || mode === "hidden" ||
        pi.getSettings?.().hideThinkingBlock !== true) return;
    nativeThinkingWarningShown = true;
    ctx.ui.notify(
      "Pi скрывает блоки рассуждений. Установите hideThinkingBlock: false (или нажмите Ctrl+T), чтобы режим отображения влиял на них.",
      "warning",
    );
  };
  const tickingRows = new Set<RendererState>();
  const stopTicker = (state: RendererState): void => {
    if (state.compactTicker) clearInterval(state.compactTicker);
    state.compactTicker = undefined;
    state.compactStartedAt = undefined;
    state.compactInvalidate = undefined;
    tickingRows.delete(state);
  };
  const stopAllTickers = (): void => {
    for (const state of tickingRows) stopTicker(state);
  };
  const syncTicker = (context: AnyRenderContext, isPartial: boolean): number | undefined => {
    const state = context.state as RendererState;
    if (!isPartial || mode !== "compact") {
      stopTicker(state);
      return undefined;
    }
    state.compactStartedAt ??= Date.now();
    state.compactInvalidate = context.invalidate;
    if (!state.compactTicker && typeof context.invalidate === "function") {
      state.compactTicker = setInterval(() => state.compactInvalidate?.(), 1_000);
      state.compactTicker.unref?.();
      tickingRows.add(state);
    }
    return state.compactStartedAt;
  };

  async function loadMode(): Promise<ToolViewMode> {
    try {
      const stored = JSON.parse(await readFile(modeFile, "utf8")) as Partial<StoredMode>;
      return typeof stored.mode === "string" && isToolViewMode(stored.mode) ? stored.mode : "compact";
    } catch {
      return "compact";
    }
  }

  async function persistMode(nextMode: ToolViewMode): Promise<void> {
    const tempFile = `${modeFile}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`; 
    const stored: StoredMode = { mode: nextMode };
    await writeFile(tempFile, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    await rename(tempFile, modeFile);
  }

  function notifyModeChange(): void {
    for (const listener of modeListeners) listener(mode);
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    ctx.ui.setStatus(MODE_STATUS_ID, `Отображение инструментов: ${modeLabel(mode)}`);
  }

  function requestTranscriptRerender(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    // Pi has no dedicated transcript-invalidate API. Toggling the public
    // expanded state forces every historical tool row to rebuild, then
    // restores the user's original expansion preference.
    const expanded = ctx.ui.getToolsExpanded();
    ctx.ui.setToolsExpanded(!expanded);
    ctx.ui.setToolsExpanded(expanded);
  }

  function setMode(nextMode: ToolViewMode, ctx: ExtensionContext, notify = true): Promise<void> {
    const generation = sessionGeneration;
    const sessionId = ctx.sessionManager.getSessionId();
    modeChangeQueue = modeChangeQueue.then(async () => {
      mode = nextMode;
      if (mode !== "compact") stopAllTickers();
      let persistError: unknown;
      try {
        await persistMode(mode);
      } catch (error) {
        persistError = error;
      }

      // Event callbacks can receive different context wrapper objects for the
      // same session. Guard by stable session identity plus generation rather
      // than object identity, while still rejecting contexts invalidated by a
      // session replacement or reload during the disk write.
      if (generation !== sessionGeneration || activeSessionId !== sessionId) return;
      if (persistError) {
        ctx.ui.notify(`Режим отображения изменён, но не удалось сохранить настройку: ${errorMessage(persistError)}`, "warning");
      }
      updateStatus(ctx);
      notifyModeChange();
      requestTranscriptRerender(ctx);
      // Refresh Pi's existing assistant-message Markdown components (including
      // the active stream) through the official UI API, without patching internals.
      ctx.ui.setHiddenThinkingLabel?.();
      if (!supportsThinking) ctx.ui.notify("Эта версия Pi не поддерживает изменение отображения рассуждений.", "warning");
      warnNativeThinkingHidden(ctx);
      if (notify) ctx.ui.notify(`Отображение инструментов: ${modeLabel(mode)}`, "info");
    });
    return modeChangeQueue;
  }

  function cycleMode(ctx: ExtensionContext): Promise<void> {
    const index = MODE_ORDER.indexOf(mode);
    return setMode(MODE_ORDER[(index + 1) % MODE_ORDER.length]!, ctx);
  }

  function updateSkillRootsFromPromptOptions(skills: Array<{ baseDir?: string; filePath?: string }> | undefined): void {
    const roots = new Set<string>();
    for (const skill of skills ?? []) {
      if (skill.baseDir) roots.add(resolve(skill.baseDir));
      else if (skill.filePath) roots.add(dirname(resolve(skill.filePath)));
    }
    skillRoots = roots;
  }

  function shouldPreserveReadRenderer(args: any, context: AnyRenderContext): boolean {
    const absolutePath = resolveToolPath(context.cwd, args.path);
    if (!absolutePath) return false;
    if (isLikelySkillPath(absolutePath)) return true;
    for (const root of skillRoots) {
      if (isPathInside(absolutePath, root)) return true;
    }
    return false;
  }

  function nativeContext(
    context: AnyRenderContext,
    nativeState: any,
    lastComponent: RendererState["nativeCallComponent"] | RendererState["nativeResultComponent"],
  ): AnyRenderContext {
    return { ...context, state: nativeState, lastComponent };
  }

  function callNativeRenderer(
    definition: ToolRenderers,
    toolName: string,
    args: any,
    theme: Theme,
    context: AnyRenderContext,
  ) {
    const state = context.state as RendererState;
    state.nativeState ??= {};
    try {
      const component = definition.renderCall?.(
        args,
        theme,
        nativeContext(context, state.nativeState, state.nativeCallComponent),
      ) ?? new Container();
      state.nativeCallComponent = component;
      return component;
    } catch {
      state.nativeCallComponent = undefined;
      return new Text(theme.fg("toolTitle", theme.bold(toolName)), 0, 0);
    }
  }

  function resultNativeRenderer(
    definition: ToolRenderers,
    result: AnyToolResult,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: AnyRenderContext,
  ) {
    const state = context.state as RendererState;
    state.nativeState ??= {};
    try {
      const component = definition.renderResult?.(
        result,
        options,
        theme,
        nativeContext(context, state.nativeState, state.nativeResultComponent),
      ) ?? new Container();
      state.nativeResultComponent = component;
      return component;
    } catch {
      state.nativeResultComponent = undefined;
      const output = textOutput(result);
      return output ? new Text(theme.fg("toolOutput", output), 0, 0) : new Container();
    }
  }

  function compactCall(toolName: string, args: any, theme: Theme) {
    if (toolName === "codemode") return renderCodemodeCompactCall(args, theme);
    const summary = COMPACT_SPECS[toolName]!.call(args);
    const title = theme.fg("toolTitle", theme.bold(summary.title));
    const detail = summary.detail ? `  ${theme.fg("dim", summary.detail)}` : "";
    return singleLine(compactCallPrefix(theme, false) + title + detail);
  }

  function compactResult(
    toolName: string,
    result: AnyToolResult,
    theme: Theme,
    context: AnyRenderContext,
    options: ToolRenderResultOptions,
  ) {
    if (toolName === "codemode") return withCompactResultBranch(
      renderCodemodeCompactResult(result, theme, context, options, syncTicker(context, options.isPartial)),
      theme,
    );
    // A failed tool must not imply that its mutation was saved/applied.
    const summary = context.isError || options.isPartial ? "" : COMPACT_SPECS[toolName]!.result(result, context, options);
    const statusColor = context.isError ? "error" : options.isPartial ? "warning" : "success";
    const icon = context.isError ? "✗ Failed" : options.isPartial ? "… Running" : "";
    const duration = typeof context.durationMs === "number" && Number.isFinite(context.durationMs) &&
      context.durationMs >= 0 && !options.isPartial
      ? context.durationMs < 1_000 ? `${Math.round(context.durationMs)}ms` : `${(context.durationMs / 1_000).toFixed(1)}s`
      : "";
    const resultLine = {
      render(width: number) {
        if (width <= 0) return [];
        const heading = theme.fg(statusColor, icon);
        const shortSummary = summary.replace(/^(\d+) (?:строка|строки|строк)$/, "$1 выв.");
        const compose = (label: string, withDuration: boolean) =>
          heading + (label ? `${icon ? "  " : ""}${theme.fg("muted", label)}` : "") +
          (withDuration && duration
            ? `${label ? theme.fg("dim", " · ") : icon ? "  " : ""}${theme.fg("dim", duration)}` : "");
        const optionsToFit = [
          compose(summary, true), compose(shortSummary, true),
          compose(summary, false), compose(shortSummary, false),
        ];
        const line = optionsToFit.find((candidate) => visibleWidth(candidate) <= width) ??
          truncateToWidth(optionsToFit[optionsToFit.length - 1]!, width, "…");
        return [line];
      },
      invalidate() {},
    };
    return withCompactResultBranch(resultLine, theme);
  }

  // Resolve renderers only. Pi retains its registered tools, execution pipeline,
  // arguments, permissions, project trust behavior, and native tool definitions.
  // A fixed self shell lets mode changes re-render historical rows and lets the
  // hidden mode remove all visual content without replacing tool execution.
  if (typeof pi.registerToolRenderer !== "function") {
    throw new Error("Tool View requires Pi with registerToolRenderer(). Update Pi to use this extension.");
  }
  pi.registerToolRenderer((toolName, next) => {
    if (!ownsCompactTool(toolName)) return next();
    const nativeDefinition = next();
    // Keep compact summaries when collapsed; allow the host's native Codemode
    // script/nested-call/output details when the user expands that tool.
    const isCodemode = toolName === "codemode";
    const preserveCall = (args: any, context: AnyRenderContext): boolean =>
      toolName === "read" && shouldPreserveReadRenderer(args, context);
    const useNativeCall = (args: any, context: AnyRenderContext): boolean =>
      preserveCall(args, context) || mode === "normal" ||
      (mode === "compact" && (context.expanded || (!isCodemode && context.isError)));
    const useNativeResult = (context: AnyRenderContext, options: ToolRenderResultOptions): boolean =>
      preserveCall(context.args, context) || mode === "normal" ||
      (mode === "compact" && (options.expanded || (!isCodemode && context.isError)));

    return markCompactSpacingRenderer({
      renderShell: "self",
      renderCall(args, theme, context) {
        if (useNativeCall(args, context) && nativeDefinition) {
          const component = callNativeRenderer(nativeDefinition, toolName, args, theme, context);
          const decorate = (native: ReturnType<NonNullable<ToolRenderers["renderCall"]>>) =>
            mode === "compact" && !preserveCall(args, context)
              ? withNativeChevron(native, theme, context.expanded) : native;
          if (nativeDefinition.renderShell === "self") return decorate(component);
          const state = context.state as RendererState;
          const box = state.nativeBox ?? new Box(1, 1);
          state.nativeBox = box;
          box.clear();
          box.setBgFn((text) => theme.bg(
            context.isError ? "toolErrorBg" : context.isPartial ? "toolPendingBg" : "toolSuccessBg",
            text,
          ));
          box.addChild(component);
          return decorate(box);
        }
        if (mode === "hidden") return new Container();
        return compactCall(toolName, args, theme);
      },

      renderResult(result, options, theme, context) {
        if (useNativeResult(context, options) && nativeDefinition) {
          if (isCodemode) stopTicker(context.state as RendererState);
          const component = resultNativeRenderer(nativeDefinition, result, options, theme, context);
          if (nativeDefinition.renderShell === "self") return component;
          const state = context.state as RendererState;
          // renderCall runs immediately before renderResult and rebuilds this
          // shared box with the native call component.
          state.nativeBox?.addChild(component);
          return new Container();
        }
        if (mode === "hidden") {
          const state = context.state as RendererState;
          if (isCodemode) stopTicker(state);
          // If this row previously used a native streaming renderer (notably
          // bash), let its final render run once so timers/resources settle,
          // then discard the visual component.
          if (!options.isPartial && state.nativeResultComponent && nativeDefinition) {
            resultNativeRenderer(nativeDefinition, result, options, theme, context);
          }
          return new Container();
        }
        if (options.isPartial && !isCodemode) return compactResult(toolName, result, theme, context, options);
        const state = context.state as RendererState;
        if (state.nativeResultComponent && nativeDefinition) {
          resultNativeRenderer(nativeDefinition, result, options, theme, context);
        }
        return compactResult(toolName, result, theme, context, options);
      },
    });
  });
  compactSpacingActive = installCompactSpacingGuard(() => mode);

  pi.registerCommand(MODE_COMMAND, {
    description: "Изменить режим отображения: normal, compact, hidden или status",
    getArgumentCompletions: (prefix) => {
      const values = [...MODE_ORDER, "status"];
      const matches = values.filter((value) => value.startsWith(prefix.trim()));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const requested = args.trim().toLowerCase();
      if (!requested || requested === "status") {
        if (!requested && ctx.mode === "tui") {
          const choices = MODE_ORDER.map(
            (value) => `${modeLabel(value)}${value === mode ? " · выбран" : ""}`,
          );
          const selected = await createDialogUI(ctx.ui).select("Режим отображения", choices);
          const selectedIndex = selected ? choices.indexOf(selected) : -1;
          if (selectedIndex >= 0) await setMode(MODE_ORDER[selectedIndex]!, ctx);
          return;
        }
        ctx.ui.notify(`Отображение инструментов: ${modeLabel(mode)}`, "info");
        return;
      }
      if (!isToolViewMode(requested)) {
        ctx.ui.notify("Использование: /tool-view normal|compact|hidden|status", "warning");
        return;
      }
      await setMode(requested, ctx);
    },
  });

  pi.registerShortcut(MODE_SHORTCUT, {
    description: "Переключить режим отображения инструментов",
    handler: cycleMode,
  });

  pi.on("before_agent_start", (event) => {
    updateSkillRootsFromPromptOptions(event.systemPromptOptions.skills);
  });

  pi.on("message_start", (event) => {
    if (event.message.role === "assistant") thinkingTiming.endMessage();
  });
  pi.on("message_update", (event) => {
    thinkingTiming.observe(event.assistantMessageEvent);
  });
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") thinkingTiming.endMessage();
  });

  pi.on("session_start", (_event, ctx) => {
    stopAllTickers();
    thinkingTiming.reset();
    sessionGeneration++;
    activeSessionId = ctx.sessionManager.getSessionId();
    updateSkillRootsFromPromptOptions(
      pi.getCommands()
        .filter((command) => command.source === "skill")
        .map((command) => ({ filePath: command.sourceInfo.path })),
    );
    updateStatus(ctx);
    notifyModeChange();
    warnNativeThinkingHidden(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopAllTickers();
    thinkingTiming.reset();
    sessionGeneration++;
    activeSessionId = undefined;
    if (ctx.mode === "tui") ctx.ui.setStatus(MODE_STATUS_ID, undefined);
  });

  return {
    getMode: () => mode,
    setMode,
    onModeChange(listener) {
      modeListeners.add(listener);
      listener(mode);
      return () => modeListeners.delete(listener);
    },
  };
}
