import type { ContextUsage, Theme } from "@earendil-works/pi-coding-agent";
import { ScrollView, VStack, type Component, type TUI } from "@earendil-works/pi-tui";
import type { RunActivitySnapshot } from "../ctx/activity.ts";
import type { ContextEstimate } from "../ctx/data.ts";
import { ContextPanel } from "../ctx/panel.ts";
import type { ResourceButtonId } from "../session/panel.ts";
import { SessionPanel, type SessionListItem } from "../session/panel.ts";
import { ToolViewPanel } from "../tool-view/panel.ts";
import { panelBottom, panelTop } from "./panel.ts";
import { installPriorityInputListener, isSidebarInputBlocked, parseSgrMouseEvent } from "./resize.ts";
import type { ToolViewMode } from "../tool-view/types.ts";
import type { ToolUsageSnapshot } from "../tool-view/usage.ts";
import type { SidebarPanelDefinition } from "./registry.ts";

export const SESSION_PANEL_ID = "sessions";
export const CONTEXT_PANEL_ID = "context";
export const TOOL_VIEW_PANEL_ID = "tool-view";

class ToolViewScrollView extends VStack {
  readonly scrollView: ScrollView;

  constructor(panel: ToolViewPanel, theme: Theme) {
    const scrollView = new ScrollView(panel, {
      follow: "none",
      overscroll: "chain",
      scrollbar: "hidden",
      scrollbarTrackStyle: (text: string) => theme.fg("accent", text),
      scrollbarThumbStyle: (text: string) => theme.fg("accent", text),
    });
    const bottomBorder: Component = {
      render: (width) => [panelBottom(theme, width)],
      invalidate(): void {},
    };
    super([
      { component: scrollView, grow: 1, shrink: 1, minSize: 0 },
      { component: bottomBorder, basis: 1, grow: 0, shrink: 0, minSize: 1 },
    ], { gap: 0, align: "stretch" });
    this.scrollView = scrollView;
  }

  get scrollTop(): number { return this.scrollView.scrollTop; }
  get isFollowingEnd(): boolean { return this.scrollView.isFollowingEnd; }
  get viewportHeight(): number { return this.scrollView.viewportHeight; }
  get scrollbar(): "hidden" | "auto" | "always" { return this.scrollView.scrollbar; }
  updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
    this.scrollView.updateLayout(contentHeight, viewportHeight, requestRender);
    this.scrollView.setScrollbar(contentHeight > viewportHeight ? "always" : "hidden");
  }
}

export function createToolViewScrollView(panel: ToolViewPanel, theme: Theme): ToolViewScrollView {
  // Keep the panel identity and mode selector visible by default. Following
  // the end makes a long usage list look like the Tool View disappeared,
  // because its title and selector are scrolled out of the viewport.
  return new ToolViewScrollView(panel, theme);
}

const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");

type LayoutBox = {
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly clip: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly children?: readonly LayoutBox[];
};

type LayoutTui = TUI & { currentLayout?: { root?: LayoutBox } };

function findLayoutBox(box: LayoutBox, component: Component): LayoutBox | undefined {
  if ((box as LayoutBox & { component?: Component }).component === component) return box;
  for (const child of box.children ?? []) {
    const found = findLayoutBox(child, component);
    if (found) return found;
  }
  return undefined;
}

function contains(rect: LayoutBox["rect"], x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

class CollapsiblePanel implements Component {
  private pressed = false;
  private readonly uninstallInput: () => void;
  private readonly collapsedHeader: Component;

  constructor(
    private readonly child: Component,
    private readonly title: string,
    private readonly theme: Theme,
    private readonly tui: TUI,
    private readonly isCollapsed: () => boolean,
    private readonly toggle: () => void,
    private readonly toggleText?: string,
    private readonly titleSource?: Component,
  ) {
    this.collapsedHeader = {
      render: (width) => [panelTop(this.theme, `▸ ${this.title}`, width), panelBottom(this.theme, width)],
      invalidate(): void {},
    };
    this.uninstallInput = typeof (tui as TUI & { addInputListener?: unknown }).addInputListener === "function"
      ? installPriorityInputListener(tui, (data) => {
      if (isSidebarInputBlocked(tui)) { this.pressed = false; return undefined; }
      const mouse = parseSgrMouseEvent(data);
      if (!mouse || (mouse.button & 64) !== 0) return undefined;
      const box = (tui as LayoutTui).currentLayout?.root;
      const ownBox = box && findLayoutBox(box, this);
      const x = mouse.x - 1;
      const y = mouse.y - 1;
      const isToggleTarget = (): boolean => {
        if (!ownBox || !contains(ownBox.clip, x, y) || !contains(ownBox.rect, x, y) || y !== ownBox.rect.y) return false;
        if (!this.toggleText) return true;
        const source = this.isCollapsed() ? this.collapsedHeader : this.titleSource ?? this.child;
        const header = source.render(Math.max(1, ownBox.rect.width))[0] ?? "";
        const plainHeader = header.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
        const start = plainHeader.indexOf(this.toggleText);
        return start >= 0 && x - ownBox.rect.x >= start && x - ownBox.rect.x < start + this.toggleText.length;
      };
      if (mouse.release) {
        const pressed = this.pressed;
        this.pressed = false;
        if (pressed && isToggleTarget()) {
          this.toggle();
          tui.requestRender();
          return { consume: true };
        }
        return undefined;
      }
      if (mouse.motion) return this.pressed ? { consume: true } : undefined;
      if ((mouse.button & 3) !== 0 || !isToggleTarget()) return undefined;
      this.pressed = true;
      return { consume: true };
    })
      : () => {};
  }

  render(width: number): string[] {
    const renderWidth = Math.max(1, width);
    if (!this.isCollapsed()) return this.child.render(renderWidth);
    return this.collapsedHeader.render(renderWidth);
  }

  [LAYOUT_NODE]() {
    return {
      type: "vstack" as const,
      entries: [{ component: this.isCollapsed() ? this.collapsedHeader : this.child, basis: "auto" as const, grow: 0, shrink: 0 }],
      gap: 0,
      align: "stretch" as const,
    };
  }

  invalidate(): void { this.child.invalidate(); this.collapsedHeader.invalidate(); }
  dispose(): void { this.uninstallInput(); }
}

export type DefaultSidebarPanelOptions = {
  readonly getContextEstimate?: () => ContextEstimate;
  readonly getContextDelta?: () => number | undefined;
  readonly getActivity?: () => RunActivitySnapshot | undefined;
  readonly getCacheHitRate?: () => number | undefined;
  readonly getCacheTokens?: () => number | undefined;
  readonly getContextUsage: () => ContextUsage | undefined;
  readonly getModel: () => string;
  readonly getThinkingLevel: () => string;
  readonly getToolViewMode: () => ToolViewMode | undefined;
  readonly getToolUsage: () => ToolUsageSnapshot | undefined;
  readonly onSelectToolViewMode: (mode: ToolViewMode) => void;
  readonly loadSessions: () => Promise<readonly SessionListItem[]>;
  readonly onSelectSession: (session: SessionListItem) => void;
  readonly onRenameSession: (session: SessionListItem) => void;
  readonly onDeleteSession: (session: SessionListItem) => void;
  readonly onTogglePinSession?: (session: SessionListItem) => void;
  readonly onDeleteOthers: () => void;
  readonly onOpenSessionManager?: () => void;
  readonly onOpenResources: (button: ResourceButtonId) => void;
};

class AdaptiveScrollView extends ScrollView {
  override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
    super.updateLayout(contentHeight, viewportHeight, requestRender);
    this.setScrollbar(contentHeight > viewportHeight ? "always" : "hidden");
  }
}

export function createDefaultSidebarPanels(
  options: DefaultSidebarPanelOptions,
): readonly SidebarPanelDefinition[] {
  const collapsed = new Map<string, boolean>([[SESSION_PANEL_ID, true], [CONTEXT_PANEL_ID, false], [TOOL_VIEW_PANEL_ID, true]]);
  const minimumSize: Record<string, number> = { [SESSION_PANEL_ID]: 4, [CONTEXT_PANEL_ID]: 10, [TOOL_VIEW_PANEL_ID]: 3 };
  const maxAvailableSize = (id: string, terminalRows: number): number => {
    const reserved = 2 + [...collapsed.keys()]
      .filter((otherId) => otherId !== id)
      .reduce((total, otherId) => total + (collapsed.get(otherId) ? 2 : minimumSize[otherId]!), 0);
    return Math.max(minimumSize[id]!, terminalRows - reserved);
  };
  const createCollapsible = (
    id: string, title: string, child: Component, tui: TUI, theme: Theme,
    toggleText?: string, titleSource?: Component,
  ): CollapsiblePanel => new CollapsiblePanel(
    child, title, theme, tui,
    () => collapsed.get(id) ?? false,
    () => collapsed.set(id, !(collapsed.get(id) ?? false)),
    toggleText, titleSource,
  );

  return [{
    id: SESSION_PANEL_ID,
    layout: {
      minSize: () => collapsed.get(SESSION_PANEL_ID) ? 2 : 4,
      maxSize: ({ terminalRows }) => collapsed.get(SESSION_PANEL_ID) ? 2 : maxAvailableSize(SESSION_PANEL_ID, terminalRows),
    },
    create({ tui, theme, getDesiredWidth, cacheRender }) {
      const panel = new SessionPanel(theme, {
        tui,
        getDesiredWidth,
        loadSessions: options.loadSessions,
        onSelect: options.onSelectSession,
        onRename: options.onRenameSession,
        onDelete: options.onDeleteSession,
        onTogglePin: options.onTogglePinSession,
        onDeleteOthers: options.onDeleteOthers,
        onOpenManager: options.onOpenSessionManager,
        onOpenResources: options.onOpenResources,
      });
      cacheRender?.(panel);
      panel.refresh();
      const scroll = new AdaptiveScrollView(panel, { follow: "none", overscroll: "chain", scrollbar: "hidden" });
      const collapsible = createCollapsible(SESSION_PANEL_ID, "СЕССИИ", scroll, tui, theme, "СЕССИИ", panel);
      return {
        component: collapsible,
        update(): void { panel.refresh(); },
        dispose(): void { collapsible.dispose(); panel.dispose(); },
      };
    },
  }, {
    id: CONTEXT_PANEL_ID,
    layout: {
      minSize: () => collapsed.get(CONTEXT_PANEL_ID) ? 2 : 10,
      maxSize: ({ terminalRows }) => collapsed.get(CONTEXT_PANEL_ID) ? 2 : maxAvailableSize(CONTEXT_PANEL_ID, terminalRows),
    },
    create({ tui, theme, getDesiredWidth, cacheRender }) {
      const panel = new ContextPanel(theme, {
          getEstimate: options.getContextEstimate,
          getDelta: options.getContextDelta,
          getActivity: options.getActivity,
          now: () => Date.now(),
          getCacheHitRate: options.getCacheHitRate,
          getCacheTokens: options.getCacheTokens,
          getUsage: options.getContextUsage,
          getModel: options.getModel,
          getThinkingLevel: options.getThinkingLevel,
          getDesiredWidth,
      });
      cacheRender?.(panel);
      // Keep elapsed time current during a run, but avoid waking an idle TUI.
      // Activity transitions call sidebar.refresh(), which starts/stops this ticker.
      let renderTimer: ReturnType<typeof setInterval> | undefined;
      const syncTicker = (): void => {
        if (options.getActivity?.()?.phase === "running") {
          if (!renderTimer) {
            renderTimer = setInterval(() => tui.requestRender(), 1_000);
            renderTimer.unref?.();
          }
        } else if (renderTimer) {
          clearInterval(renderTimer);
          renderTimer = undefined;
        }
      };
      syncTicker();
      const collapsible = createCollapsible(CONTEXT_PANEL_ID, "КОНТЕКСТ", new AdaptiveScrollView(panel, { follow: "none", overscroll: "chain", scrollbar: "hidden" }), tui, theme);
      return {
        component: collapsible,
        refresh(): void { syncTicker(); },
        dispose(): void {
          collapsible.dispose();
          if (renderTimer) clearInterval(renderTimer);
          renderTimer = undefined;
        },
      };
    },
  }, {
    id: TOOL_VIEW_PANEL_ID,
    layout: {
      minSize: () => collapsed.get(TOOL_VIEW_PANEL_ID) ? 2 : 3,
      maxSize: ({ terminalRows }) => collapsed.get(TOOL_VIEW_PANEL_ID) ? 2 : maxAvailableSize(TOOL_VIEW_PANEL_ID, terminalRows),
    },
    create({ tui, theme, getDesiredWidth, cacheRender }) {
      const panel = new ToolViewPanel(theme, {
        tui,
        getDesiredWidth,
        getMode: options.getToolViewMode,
        getUsage: options.getToolUsage,
        onSelect: options.onSelectToolViewMode,
        showBottomBorder: false,
      });
      cacheRender?.(panel);
      const scroll = createToolViewScrollView(panel, theme);
      const collapsible = createCollapsible(TOOL_VIEW_PANEL_ID, "ОТОБРАЖЕНИЕ", scroll, tui, theme);
      return {
        component: collapsible,
        dispose(): void { collapsible.dispose(); panel.dispose(); }
      };
    },
  }];
}
