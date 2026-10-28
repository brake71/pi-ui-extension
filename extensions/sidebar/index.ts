import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  HStack,
  VStack,
  isViewportTUI,
  type Component,
  type TUI,
  type ViewportTUI,
} from "@earendil-works/pi-tui";
import { createSidebarScrollView } from "./layout.ts";
import { createSidebarRenderCache, SidebarLayoutRoot } from "./render-cache.ts";
import { installMouseResize, SidebarDivider } from "./resize.ts";
import type {
  SidebarPanelDefinition,
  SidebarPanelInstance,
  SidebarPanelLayout,
} from "./registry.ts";

const SIDEBAR_RATIO = 0.20;
const MIN_SIDEBAR_WIDTH = 18;
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

type MountedPanel = {
  readonly definition: SidebarPanelDefinition<unknown>;
  readonly instance: SidebarPanelInstance<unknown>;
  readonly entry: MutableVStack["entries"][number] | undefined;
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

  let sidebarWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.round(tui.terminal.columns * SIDEBAR_RATIO));
  const clampSidebarWidth = (width: number): number => Math.min(
    MAX_SIDEBAR_WIDTH,
    Math.max(MIN_SIDEBAR_WIDTH, Math.min(Math.trunc(width), tui.terminal.columns - MIN_MAIN_WIDTH)),
  );
  sidebarWidth = clampSidebarWidth(sidebarWidth);
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
  const sidebarScroll = createSidebarScrollView(sidebar, theme, () => tui.terminal.rows);
  const sidebarEntries = (sidebar as unknown as { entries?: MutableVStack["entries"] }).entries;
  layoutEntries.forEach(({ definition, instance }, index) => {
    const entry = Array.isArray(sidebarEntries) ? sidebarEntries[index * 2] : undefined;
    mountedPanels.set(definition.id, {
      definition, instance,
      entry: entry?.component === instance.component ? entry : undefined,
    });
  });
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
      visible: ({ width }) => width >= MIN_SPLIT_WIDTH,
    },
    {
      component: sidebarScroll,
      basis: sidebarWidth,
      grow: 0,
      shrink: 0,
      minSize: MIN_SIDEBAR_WIDTH,
      maxSize: MAX_SIDEBAR_WIDTH,
      visible: ({ width }) => width >= MIN_SPLIT_WIDTH,
    },
  ], () => { renderCache.beginFrame(); syncPanelLayout(); });
  const splitEntries = (splitRoot as unknown as { entries?: MutableHStack["entries"] }).entries;
  const sidebarEntry = Array.isArray(splitEntries) && splitEntries[2]?.component === sidebarScroll
    ? splitEntries[2] : undefined;
  const applySidebarWidth = (width: number): void => {
    const next = clampSidebarWidth(width);
    if (next === sidebarWidth || !sidebarEntry) return;
    sidebarWidth = next;
    sidebarEntry.basis = next;
    tui.requestRender();
  };
  let uninstallMouseResize: () => void = () => {};
  try {
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
        isVisible: () => tui.terminal.columns >= MIN_SPLIT_WIDTH,
        getDividerX: () => tui.terminal.columns - sidebarWidth,
        clampSidebarWidth,
        commitSidebarWidth: applySidebarWidth,
      });
    }
  } catch {
    // An incompatible TUI must not leave the transcript wrapped in our root.
    try {
      if (layoutTui.layoutRoot === splitRoot) layoutTui.setLayoutRoot(previousRoot);
    } catch { /* Host layout setter failed during cleanup. */ }
    for (const instance of createdInstances.reverse()) {
      try { instance.dispose?.(); } catch { /* Continue cleaning up. */ }
    }
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
