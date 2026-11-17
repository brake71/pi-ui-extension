import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  HStack,
  ScrollView,
  VStack,
  truncateToWidth,
  isViewportTUI,
  type Component,
  type TUI,
  type ViewportTUI,
} from "@earendil-works/pi-tui";
import { createSidebarScrollView } from "./layout.ts";
import { createSidebarLayoutStore } from "./layout-store.ts";
import { createSidebarRenderCache, SidebarLayoutRoot } from "./render-cache.ts";
import { installMouseResize, installPriorityInputListener, isSidebarInputBlocked, parseSgrMouseEvent, SidebarDivider } from "./resize.ts";
import type {
  SidebarPanelDefinition,
  SidebarPanelInstance,
  SidebarPanelLayout,
} from "./registry.ts";

const SIDEBAR_RATIO = 0.20;
const MIN_SIDEBAR_WIDTH = 18;
const COLLAPSED_SIDEBAR_WIDTH = 4;
const MAX_SIDEBAR_WIDTH = 72;
const MIN_MAIN_WIDTH = 64;
const MIN_SPLIT_WIDTH = MIN_MAIN_WIDTH + MIN_SIDEBAR_WIDTH + 1;

type LayoutTui = ViewportTUI & { layoutRoot?: unknown };

function isComponent(value: unknown): value is Component {
  return value !== null && typeof value === "object" &&
    typeof (value as Component).render === "function" &&
    typeof (value as Component).invalidate === "function";
}
type MutableHStack = HStack & { entries: Array<{ basis?: number | "auto" }> };
type MutableVStack = VStack & { entries: Array<{ minSize?: number; maxSize?: number }> };
const RESET_STYLE = "\x1b[0m";
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type LayoutBox = {
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly clip: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly children?: readonly LayoutBox[];
};

function findComponentBox(box: LayoutBox, component: Component): LayoutBox | undefined {
  if ((box as LayoutBox & { component?: Component }).component === component) return box;
  for (const child of box.children ?? []) {
    const found = findComponentBox(child, component);
    if (found) return found;
  }
  return undefined;
}

type MountedPanel = {
  readonly definition: SidebarPanelDefinition<unknown>;
  readonly instance: SidebarPanelInstance<unknown>;
  readonly entry: MutableVStack["entries"][number] | undefined;
};

export type SidebarOptions = {
  /** Persisted layout file. Without it the sidebar keeps the width only in memory. */
  readonly layoutPath?: string;
  /** Test hook; production uses the store's default debounce. */
  readonly layoutSaveDelayMs?: number;
  readonly context?: {
    readonly getUsage: () => { readonly percent: number | null | undefined } | undefined;
    readonly getModel: () => string;
    readonly getThinkingLevel: () => string;
  };
};

export type SidebarController = {
  readonly mounted: boolean;
  updatePanel<State>(id: string, state: State): boolean;
  refresh(): void;
  dispose(): void;
};

function noopController(): SidebarController {
  return {
    mounted: false,
    updatePanel(): boolean { return false; },
    refresh(): void {},
    dispose(): void {},
  };
}

function resolveMaxSize(layout: SidebarPanelLayout | undefined, tui: TUI): number | undefined {
  const maxSize = layout?.maxSize;
  return typeof maxSize === "function"
    ? maxSize({ terminalRows: tui.terminal.rows, terminalColumns: tui.terminal.columns })
    : maxSize;
}

function createLayoutEntry(
  definition: SidebarPanelDefinition<unknown>,
  component: Component,
  tui: TUI,
): { component: Component; basis: number | "auto"; grow: number; shrink: number; minSize?: number; maxSize?: number } {
  const layout = definition.layout;
  const maxSize = resolveMaxSize(layout, tui);
  return {
    component,
    basis: layout?.basis ?? "auto",
    grow: layout?.grow ?? 0,
    shrink: layout?.shrink ?? 0,
    ...(layout?.minSize === undefined ? {} : {
      minSize: typeof layout.minSize === "function"
        ? layout.minSize({ terminalRows: tui.terminal.rows, terminalColumns: tui.terminal.columns })
        : layout.minSize,
    }),
    ...(maxSize === undefined ? {} : { maxSize }),
  };
}

export function installSidebar(
  tui: TUI,
  theme: Theme,
  definitions: readonly SidebarPanelDefinition[],
  options: SidebarOptions = {},
): SidebarController {
  if (!isViewportTUI(tui)) return noopController();

  // Pi currently exposes setLayoutRoot() but not getLayoutRoot() through the
  // Extension API. In fullscreen mode the active root is present on ViewportTUI;
  // fail closed if that implementation detail changes in a future Pi release.
  const layoutTui = tui as LayoutTui;
  const previousRoot = layoutTui.layoutRoot;
  // layoutRoot is an internal TUI field. If Pi changes its shape, do not mount
  // a split layout over an unknown root or disrupt the normal transcript.
  if (!isComponent(previousRoot)) return noopController();

  const clampSidebarWidth = (width: number): number => Math.min(
    MAX_SIDEBAR_WIDTH,
    Math.max(MIN_SIDEBAR_WIDTH, Math.min(Math.trunc(width), tui.terminal.columns - MIN_MAIN_WIDTH)),
  );
  // `preferredWidth` is the user's own width and the only persisted value;
  // `sidebarWidth` is what the current terminal can show. A terminal resize
  // narrows the latter only, so a temporarily small window never overwrites
  // the saved preference.
  let preferredWidth = clampSidebarWidth(Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.round(tui.terminal.columns * SIDEBAR_RATIO),
  ));
  const layoutStore = options.layoutPath === undefined
    ? undefined
    : createSidebarLayoutStore({
      path: options.layoutPath,
      min: MIN_SIDEBAR_WIDTH,
      max: MAX_SIDEBAR_WIDTH,
      ...(options.layoutSaveDelayMs === undefined ? {} : { saveDelayMs: options.layoutSaveDelayMs }),
    });
  const storedWidth = layoutStore?.readSidebarWidth();
  // The stored width is already validated to an integer inside the same range as
  // the clamp; keep it as the preference so a narrow start never shrinks it.
  if (storedWidth !== undefined) preferredWidth = storedWidth;
  let sidebarWidth = clampSidebarWidth(preferredWidth);
  let sidebarCollapsed = false;
  const getSidebarWidth = () => sidebarWidth;
  const mountedPanels = new Map<string, MountedPanel>();
  const createdInstances: SidebarPanelInstance<unknown>[] = [];
  const renderCache = createSidebarRenderCache();
  let layoutEntries: Array<{
    definition: SidebarPanelDefinition<unknown>;
    instance: SidebarPanelInstance<unknown>;
    layoutEntry: ReturnType<typeof createLayoutEntry>;
  }>;
  try {
    layoutEntries = definitions.map((definition) => {
      const instance = definition.create({ tui, theme, getDesiredWidth: getSidebarWidth, cacheRender: renderCache.cacheRender });
      createdInstances.push(instance);
      return { definition, instance, layoutEntry: createLayoutEntry(definition, instance.component, tui) };
    });
  } catch (error) {
    for (const instance of createdInstances.reverse()) {
      try { instance.dispose?.(); } catch { /* Preserve the original creation error. */ }
    }
    throw error;
  }
  const separators = layoutEntries.slice(1).map((): Component => ({
    render: (width) => [`${RESET_STYLE}${" ".repeat(Math.max(1, width))}`],
    invalidate(): void {},
  }));
  const sidebar = new VStack(
    layoutEntries.flatMap(({ layoutEntry }, index) => index === 0
      ? [layoutEntry]
      : [{ component: separators[index - 1]!, basis: 1, grow: 0, shrink: 0 }, layoutEntry]),
    { gap: 0, align: "stretch" },
  );
  const sidebarScroll = createSidebarScrollView(sidebar, theme, () => tui.terminal.rows - 1);
  const sidebarCompactStatus: Component = {
    render: (width) => {
      const percent = options.context?.getUsage()?.percent;
      const normalized = typeof percent === "number" && Number.isFinite(percent)
        ? Math.max(0, Math.min(100, percent)) : undefined;
      const color = normalized === undefined ? "dim" : normalized >= 85 ? "error" : normalized >= 60 ? "warning" : "success";
      const vertical = (text: string) => Array.from(GRAPHEMES.segment(text),
        ({ segment }) => theme.fg("accent", ` ${truncateToWidth(segment, Math.max(0, width - 1), "")}`));
      const filled = normalized === undefined ? 0 : Math.round(6 * normalized / 100);
      const lines = [
        ...vertical(options.context?.getModel() || "no-model"),
        "",
        ...vertical(options.context?.getThinkingLevel() || "off"),
        "",
        theme.fg(color, normalized === undefined ? "?%" : `${Math.round(normalized)}%`),
        ...Array.from({ length: 6 }, (_, row) => row < 6 - filled
          ? theme.fg("dim", " ░") : theme.fg(color, " █")),
      ];
      return [...lines, ...Array.from({ length: Math.max(0, tui.terminal.rows - 1 - lines.length) }, () => `${RESET_STYLE}${" ".repeat(width)}`)];
    },
    invalidate(): void {},
  };
  const compactScroll = new ScrollView(sidebarCompactStatus, { follow: "none", overscroll: "contain", scrollbar: "hidden" });
  const sidebarFooter: Component = {
    render: (width) => [theme.fg("accent", truncateToWidth(` ${sidebarCollapsed ? "<<" : ">>"}`, width, ""))],
    invalidate(): void {},
  };
  const sidebarSurface = new VStack([
    { component: sidebarScroll, basis: "auto", grow: 1, shrink: 1, minSize: 0, visible: () => !sidebarCollapsed },
    { component: compactScroll, basis: "auto", grow: 1, shrink: 1, minSize: 0, visible: () => sidebarCollapsed },
    { component: sidebarFooter, basis: 1, grow: 0, shrink: 0, minSize: 1 },
  ], { gap: 0, align: "stretch" });
  const sidebarEntries = (sidebar as unknown as { entries?: MutableVStack["entries"] }).entries;
  layoutEntries.forEach(({ definition, instance }, index) => {
    const entry = Array.isArray(sidebarEntries) ? sidebarEntries[index * 2] : undefined;
    mountedPanels.set(definition.id, {
      definition, instance,
      entry: entry?.component === instance.component ? entry : undefined,
    });
  });
  // Declared before the frame callback can run; assigned once the split root is built.
  let sidebarEntry: MutableHStack["entries"][number] | undefined;
  function setDisplayedWidth(width: number, requestRender: boolean): void {
    if (width === sidebarWidth || !sidebarEntry) return;
    sidebarWidth = width;
    if (!sidebarCollapsed) sidebarEntry.basis = width;
    if (requestRender) tui.requestRender();
  }
  let lastColumns = tui.terminal.columns;
  function syncWidthToTerminal(): void {
    if (tui.terminal.columns === lastColumns) return;
    lastColumns = tui.terminal.columns;
    // Runs at the start of a layout frame, before entries are measured.
    setDisplayedWidth(clampSidebarWidth(preferredWidth), false);
  }
  function syncPanelLayout(): void {
    for (const panel of mountedPanels.values()) {
      const maxSize = resolveMaxSize(panel.definition.layout, tui);
      const minSize = panel.definition.layout?.minSize;
      if (panel.entry && maxSize !== undefined) panel.entry.maxSize = maxSize;
      if (panel.entry && minSize !== undefined) {
        panel.entry.minSize = typeof minSize === "function"
          ? minSize({ terminalRows: tui.terminal.rows, terminalColumns: tui.terminal.columns })
          : minSize;
      }
    }
  }
  const divider = new SidebarDivider(
    (line) => theme.fg("dim", line),
    () => tui.terminal.rows,
  );
  const splitRoot = new SidebarLayoutRoot([
    { component: previousRoot, basis: 0, grow: 1, shrink: 1, minSize: MIN_MAIN_WIDTH },
    {
      component: divider,
      basis: 1,
      grow: 0,
      shrink: 0,
      minSize: 1,
      visible: ({ width }) => width >= (sidebarCollapsed ? MIN_MAIN_WIDTH + COLLAPSED_SIDEBAR_WIDTH + 1 : MIN_SPLIT_WIDTH),
    },
    {
      component: sidebarSurface,
      basis: sidebarWidth,
      grow: 0,
      shrink: 0,
      minSize: MIN_SIDEBAR_WIDTH,
      maxSize: MAX_SIDEBAR_WIDTH,
      visible: ({ width }) => width >= (sidebarCollapsed ? MIN_MAIN_WIDTH + COLLAPSED_SIDEBAR_WIDTH + 1 : MIN_SPLIT_WIDTH),
    },
  ], () => { renderCache.beginFrame(); syncWidthToTerminal(); syncPanelLayout(); });
  const splitEntries = (splitRoot as unknown as { entries?: MutableHStack["entries"] }).entries;
  sidebarEntry = Array.isArray(splitEntries) && splitEntries[2]?.component === sidebarSurface
    ? splitEntries[2] : undefined;
  let footerPressed = false;
  const installFooterInput = () => installPriorityInputListener(tui, (data) => {
    if (isSidebarInputBlocked(tui)) { footerPressed = false; return undefined; }
    const mouse = parseSgrMouseEvent(data);
    if (!mouse || (mouse.button & 64) !== 0) return undefined;
    const root = (tui as LayoutTui & { currentLayout?: { root?: LayoutBox } }).currentLayout?.root;
    const box = root && findComponentBox(root, sidebarFooter);
    const x = mouse.x - 1, y = mouse.y - 1;
    const target = (): boolean => !!box && x >= box.clip.x && x < box.clip.x + box.clip.width
      && y >= box.clip.y && y < box.clip.y + box.clip.height
      && x >= box.rect.x + 1 && x < box.rect.x + 3
      && y === box.rect.y + box.rect.height - 1;
    if (mouse.release) {
      const pressed = footerPressed;
      footerPressed = false;
      if (pressed && target() && sidebarEntry) {
        sidebarCollapsed = !sidebarCollapsed;
        const compactWidth = COLLAPSED_SIDEBAR_WIDTH;
        sidebarEntry.basis = sidebarCollapsed ? compactWidth : sidebarWidth;
        sidebarEntry.minSize = sidebarCollapsed ? compactWidth : MIN_SIDEBAR_WIDTH;
        sidebarEntry.maxSize = sidebarCollapsed ? compactWidth : MAX_SIDEBAR_WIDTH;
        tui.requestRender();
        return { consume: true };
      }
      return undefined;
    }
    if (mouse.motion) return footerPressed ? { consume: true } : undefined;
    if ((mouse.button & 3) !== 0 || !target()) return undefined;
    footerPressed = true;
    return { consume: true };
  }, { requirePriority: true });
  // Only a completed drag changes the preference; this is the single save path.
  const applySidebarWidth = (width: number): void => {
    const next = clampSidebarWidth(width);
    // An in-place press/release ends on the displayed width; saving it would turn
    // a terminal-limited width into the preference and undo the stored one.
    if (next === sidebarWidth || !sidebarEntry) return;
    preferredWidth = next;
    layoutStore?.saveSidebarWidth(next);
    setDisplayedWidth(next, true);
  };
  let uninstallMouseResize: () => void = () => {};
  let uninstallFooterInput: () => void = () => {};
  try {
    uninstallFooterInput = installFooterInput();
    layoutTui.setLayoutRoot(splitRoot);
    // Resize uses Pi's internal Stack.entries. If unavailable, retain the
    // sidebar with its initial width instead of mutating an unknown API.
    if (sidebarEntry) {
      const previewDivider = new SidebarDivider(
        (line) => theme.fg("accent", line),
        () => tui.terminal.rows,
      );
      uninstallMouseResize = installMouseResize({
        tui,
        preview: previewDivider,
        isVisible: () => !sidebarCollapsed && tui.terminal.columns >= MIN_SPLIT_WIDTH,
        getDividerX: () => tui.terminal.columns - sidebarWidth,
        clampSidebarWidth,
        commitSidebarWidth: applySidebarWidth,
      });
    }
  } catch {
    uninstallFooterInput();
    uninstallMouseResize();
    // An incompatible TUI must not leave the transcript wrapped in our root.
    try {
      if (layoutTui.layoutRoot === splitRoot) layoutTui.setLayoutRoot(previousRoot);
    } catch { /* Host layout setter failed during cleanup. */ }
    for (const instance of createdInstances.reverse()) {
      try { instance.dispose?.(); } catch { /* Continue cleaning up. */ }
    }
    layoutStore?.dispose();
    return noopController();
  }

  let disposed = false;
  return {
    mounted: true,
    updatePanel<State>(id: string, state: State): boolean {
      if (disposed) return false;
      const panel = mountedPanels.get(id.trim());
      if (!panel?.instance.update) return false;
      panel.instance.update(state);
      tui.requestRender();
      return true;
    },
    refresh(): void {
      if (disposed) return;
      syncPanelLayout();
      for (const panel of mountedPanels.values()) panel.instance.refresh?.();
      tui.requestRender();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      uninstallMouseResize();
      uninstallFooterInput();
      layoutStore?.dispose();
      for (const panel of mountedPanels.values()) {
        try { panel.instance.dispose?.(); } catch { /* Continue releasing the remaining panels. */ }
      }
      mountedPanels.clear();
      renderCache.beginFrame();
      if (layoutTui.layoutRoot === splitRoot) {
        layoutTui.setLayoutRoot(previousRoot);
      }
    },
  };
}
