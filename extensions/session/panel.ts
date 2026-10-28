import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
  type TuiInputListener,
} from "@earendil-works/pi-tui";
import { panelBottom, panelContent } from "../sidebar/panel.ts";
import { installPriorityInputListener, isSidebarInputBlocked, parseSgrMouseEvent } from "../sidebar/resize.ts";

const SESSION_ACTION_WIDTH = 4;
const SESSION_PIN_ACTION_WIDTH = 2;
const MIN_SUMMARY_WIDTH_WITH_PIN = 12;
const SESSION_TITLE_CELLS = " СЕССИИ ↻ ".length;
const CLEAR_OTHERS_CELL = " ⊗ ";
const MANAGE_SESSIONS_CELL = " ≡ ";

export type SessionListItem = {
  readonly id: string;
  readonly parentId?: string;
  readonly isSubagent?: boolean;
  readonly title: string;
  readonly modified: Date;
  /** Top-level user messages (questions), not assistant/tool results. */
  readonly userPromptCount: number | undefined;
  readonly current: boolean;
  readonly pinned?: boolean;
};

export type SessionPanelOptions = {
  readonly tui: TUI;
  readonly getDesiredWidth: () => number;
  readonly loadSessions: () => Promise<readonly SessionListItem[]>;
  readonly onSelect: (session: SessionListItem) => void;
  readonly onRename: (session: SessionListItem) => void;
  readonly onDelete: (session: SessionListItem) => void;
  readonly onTogglePin?: (session: SessionListItem) => void;
  readonly onDeleteOthers: () => void;
  readonly onOpenManager?: () => void;
  readonly now?: () => number;
};

type SessionRowAction = "select" | "pin" | "rename" | "delete";
type SessionActionTarget = {
  readonly session: SessionListItem;
  readonly action: SessionRowAction;
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

function normalizeTitle(title: string): string {
  const plainText = stripTerminalSequences(title).replace(/[\u0000-\u001f\u007f]/g, " ");
  return plainText.replace(/\s+/g, " ").trim() || "(untitled session)";
}

function formatRelativeTime(modified: Date, now: number): string {
  const elapsedMs = Math.max(0, now - modified.getTime());
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "сейчас";
  if (minutes < 60) return `${minutes}м`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}ч`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}д` : `${Math.floor(days / 30)}мес`;
}

function padToWidth(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/**
 * Content-column span of the clear-others button on the title row, or undefined
 * when the panel is too narrow to render it.
 */
function clearOthersSpan(renderWidth: number): { readonly start: number; readonly end: number } | undefined {
  const innerWidth = Math.max(1, renderWidth - 2);
  if (innerWidth < SESSION_TITLE_CELLS + CLEAR_OTHERS_CELL.length + 2) return undefined;
  const glyphStart = innerWidth - CLEAR_OTHERS_CELL.length - 1;
  return { start: glyphStart - 1, end: glyphStart + CLEAR_OTHERS_CELL.length - 2 };
}

function manageSessionsSpan(renderWidth: number): { readonly start: number; readonly end: number } | undefined {
  const clear = clearOthersSpan(renderWidth);
  const innerWidth = Math.max(1, renderWidth - 2);
  if (!clear || innerWidth < SESSION_TITLE_CELLS + CLEAR_OTHERS_CELL.length + MANAGE_SESSIONS_CELL.length + 4) return undefined;
  return { start: clear.start - MANAGE_SESSIONS_CELL.length, end: clear.start - 1 };
}

/** Title row with a right-aligned manager (≡) and clear-others (⊗) buttons. */
function renderSessionTitleRow(theme: Theme, title: string, renderWidth: number, clearPressed: boolean, managePressed: boolean, showManager: boolean): string {
  const innerWidth = Math.max(1, renderWidth - 2);
  const span = clearOthersSpan(renderWidth);
  const manager = showManager ? manageSessionsSpan(renderWidth) : undefined;
  const reserved = span ? CLEAR_OTHERS_CELL.length + 1 + (manager ? MANAGE_SESSIONS_CELL.length : 0) : 0;
  const borderWidth = Math.max(0, innerWidth - SESSION_TITLE_CELLS - reserved);
  const left = Math.floor(borderWidth / 2);
  const right = borderWidth - left;
  const border = theme.fg("accent", `╭${"─".repeat(left)} ${title} ${"─".repeat(right)}`);
  if (!span) return `${border}${theme.fg("accent", "╮")}`;
  return border +
    (manager ? theme.fg(managePressed ? "warning" : "accent", MANAGE_SESSIONS_CELL) : "") +
    theme.fg(clearPressed ? "warning" : "accent", CLEAR_OTHERS_CELL) +
    theme.fg("accent", "─╮");
}

function formatSessionSummary(session: SessionListItem, width: number, now: number): string {
  // When the sidebar is narrow, title readability wins over secondary metadata.
  const marker = `${session.current ? "● " : "○ "}${session.pinned ? "★" : ""}`;
  const metadata = formatRelativeTime(session.modified, now);
  const metadataWidth = visibleWidth(metadata) + 1;
  const showMetadata = width - visibleWidth(marker) - metadataWidth >= 14;
  const fixedWidth = visibleWidth(marker) + (showMetadata ? metadataWidth : 0);
  const titleWidth = Math.max(1, width - fixedWidth);
  const title = truncateToWidth(normalizeTitle(session.title), titleWidth, "…");
  return showMetadata
    ? `${marker}${padToWidth(title, titleWidth)} ${metadata}`
    : `${marker}${title}`;
}

function showPinButton(contentWidth: number, enabled: boolean): boolean {
  return enabled && contentWidth >= SESSION_ACTION_WIDTH + SESSION_PIN_ACTION_WIDTH + MIN_SUMMARY_WIDTH_WITH_PIN;
}

function formatSessionRow(session: SessionListItem, contentWidth: number, now: number, enablePin: boolean): string {
  if (contentWidth <= SESSION_ACTION_WIDTH) {
    return formatSessionSummary(session, contentWidth, now);
  }
  const pinVisible = showPinButton(contentWidth, enablePin);
  const summaryWidth = contentWidth - SESSION_ACTION_WIDTH - (pinVisible ? SESSION_PIN_ACTION_WIDTH : 0);
  const summary = padToWidth(formatSessionSummary(session, summaryWidth, now), summaryWidth);
  return `${summary}${pinVisible ? ` ${session.pinned ? "★" : "☆"}` : ""} ✎ ${session.current ? "·" : "×"}`;
}

function sameTarget(left: SessionActionTarget | undefined, right: SessionActionTarget | undefined): boolean {
  return Boolean(left && right && left.session.id === right.session.id && left.action === right.action);
}

/** Recent sessions: click to switch, ☆/★ to pin, ✎ to rename, × to delete, or ⊗ to bulk trash. */
export class SessionPanel implements Component {
  private clearPressed = false;
  private managePressed = false;

  private sessions: readonly SessionListItem[] = [];
  private loading = true;
  private error: string | undefined;
  private disposed = false;
  private loadInFlight = false;
  private refreshPending = false;
  private refreshPressed = false;
  private pressedTarget: SessionActionTarget | undefined;
  private readonly uninstallInput: () => void;

  constructor(
    private readonly theme: Theme,
    private readonly options: SessionPanelOptions,
  ) {
    const listener: TuiInputListener = (data) => this.handleMouseInput(data);
    this.uninstallInput = installPriorityInputListener(options.tui, listener);
  }

  private getLayoutBox(): LayoutBox | undefined {
    const root = (this.options.tui as LayoutTui).currentLayout?.root;
    return root ? findLayoutBox(root, this) : undefined;
  }

  /** Rows actually drawn; the failure hint follows the rows and is never actionable. */
  private visibleSessions(): readonly SessionListItem[] {
    return this.sessions;
  }

  private sessionAt(box: LayoutBox, x: number, y: number): SessionListItem | undefined {
    if (!contains(box.clip, x, y) || !contains(box.rect, x, y)) return undefined;
    const row = y - box.rect.y - 1;
    const rows = this.visibleSessions();
    // A row with no session (the failure hint) must never select, pin, rename or delete.
    return row >= 0 && row < rows.length ? rows[row] : undefined;
  }

  private targetAt(x: number, y: number): SessionActionTarget | undefined {
    const box = this.getLayoutBox();
    if (!box) return undefined;
    const session = this.sessionAt(box, x, y);
    if (!session) return undefined;

    const renderWidth = Math.max(1, Math.min(box.rect.width, this.options.getDesiredWidth()));
    const contentWidth = Math.max(1, renderWidth - 4);
    const contentColumn = x - box.rect.x - 2;
    if (contentColumn < 0 || contentColumn >= contentWidth) return undefined;
    const pinVisible = showPinButton(contentWidth, Boolean(this.options.onTogglePin));
    if (contentWidth <= SESSION_ACTION_WIDTH ||
        contentColumn < contentWidth - SESSION_ACTION_WIDTH - (pinVisible ? SESSION_PIN_ACTION_WIDTH : 0)) {
      return { session, action: "select" };
    }
    if (pinVisible && contentColumn < contentWidth - SESSION_ACTION_WIDTH) {
      return { session, action: "pin" };
    }
    if (contentColumn < contentWidth - 2) return { session, action: "rename" };
    return session.current ? undefined : { session, action: "delete" };
  }

  private isInsidePanel(x: number, y: number): boolean {
    const box = this.getLayoutBox();
    return Boolean(box && contains(box.clip, x, y) && contains(box.rect, x, y));
  }

  private isRefreshTarget(x: number, y: number): boolean {
    const box = this.getLayoutBox();
    return Boolean(
      box &&
      contains(box.clip, x, y) &&
      contains(box.rect, x, y) &&
      y === box.rect.y &&
      !this.isClearOthersTarget(x, y) &&
      !this.isManageSessionsTarget(x, y),
    );
  }

  private isClearOthersTarget(x: number, y: number): boolean {
    const box = this.getLayoutBox();
    if (!box || !contains(box.clip, x, y) || !contains(box.rect, x, y)) return false;
    if (y !== box.rect.y) return false;
    const renderWidth = Math.max(1, Math.min(box.rect.width, this.options.getDesiredWidth()));
    const span = clearOthersSpan(renderWidth);
    if (!span) return false;
    const contentColumn = x - box.rect.x - 2;
    return contentColumn >= span.start && contentColumn <= span.end;
  }

  private isManageSessionsTarget(x: number, y: number): boolean {
    if (!this.options.onOpenManager) return false;
    const box = this.getLayoutBox();
    if (!box || !contains(box.clip, x, y) || !contains(box.rect, x, y) || y !== box.rect.y) return false;
    const span = manageSessionsSpan(Math.max(1, Math.min(box.rect.width, this.options.getDesiredWidth())));
    const column = x - box.rect.x - 2;
    return Boolean(span && column >= span.start && column <= span.end);
  }

  private invoke(target: SessionActionTarget): void {
    switch (target.action) {
      case "select":
        if (!target.session.current) this.options.onSelect(target.session);
        return;
      case "pin":
        this.options.onTogglePin?.(target.session);
        return;
      case "rename":
        this.options.onRename(target.session);
        return;
      case "delete":
        this.options.onDelete(target.session);
    }
  }

  private handleMouseInput(data: string): { consume: true } | undefined {
    if (isSidebarInputBlocked(this.options.tui)) {
      this.refreshPressed = this.clearPressed = this.managePressed = false;
      this.pressedTarget = undefined;
      return undefined;
    }
    const mouse = parseSgrMouseEvent(data);
    if (!mouse) return undefined;

    // SGR coordinates are one-based; Pi's layout frame uses zero-based coordinates.
    const x = mouse.x - 1;
    const y = mouse.y - 1;
    const inside = this.isInsidePanel(x, y);
    const isWheel = (mouse.button & 64) !== 0;
    const isLeft = (mouse.button & 3) === 0;

    if (mouse.release) {
      if (this.managePressed) {
        this.managePressed = false;
        if (this.isManageSessionsTarget(x, y)) {
          queueMicrotask(() => { if (!this.disposed && !isSidebarInputBlocked(this.options.tui)) this.options.onOpenManager?.(); });
        }
        this.options.tui.requestRender();
        return { consume: true };
      }
      if (this.clearPressed) {
        this.clearPressed = false;
        if (this.isClearOthersTarget(x, y)) {
          queueMicrotask(() => {
            if (!this.disposed && !isSidebarInputBlocked(this.options.tui)) this.options.onDeleteOthers();
          });
        }
        this.options.tui.requestRender();
        return { consume: true };
      }
      if (this.refreshPressed) {
        this.refreshPressed = false;
        if (this.isRefreshTarget(x, y)) {
          queueMicrotask(() => {
            if (!this.disposed && !isSidebarInputBlocked(this.options.tui)) this.refresh();
          });
        }
        this.options.tui.requestRender();
        return { consume: true };
      }

      const pressed = this.pressedTarget;
      if (!pressed) return undefined;
      this.pressedTarget = undefined;
      const released = this.targetAt(x, y);
      if (sameTarget(pressed, released) && released) {
        queueMicrotask(() => {
          if (!this.disposed && !isSidebarInputBlocked(this.options.tui)) this.invoke(released);
        });
      }
      this.options.tui.requestRender();
      return { consume: true };
    }

    if (mouse.motion) {
      if (this.managePressed) {
        if (!this.isManageSessionsTarget(x, y)) {
          this.managePressed = false;
          this.options.tui.requestRender();
        }
        return { consume: true };
      }
      if (this.refreshPressed) {
        if (!this.isRefreshTarget(x, y)) {
          this.refreshPressed = false;
          this.options.tui.requestRender();
        }
        return { consume: true };
      }
      if (this.clearPressed) {
        if (!this.isClearOthersTarget(x, y)) {
          this.clearPressed = false;
          this.options.tui.requestRender();
        }
        return { consume: true };
      }
      if (!this.pressedTarget) return undefined;
      if (!sameTarget(this.pressedTarget, this.targetAt(x, y))) {
        this.pressedTarget = undefined;
        this.options.tui.requestRender();
      }
      return { consume: true };
    }

    if (!inside) return undefined;
    // Do not let wheel events over the fixed session panel scroll the main transcript.
    if (isWheel) return { consume: true };
    if (!isLeft) return undefined;

    if (this.isManageSessionsTarget(x, y)) {
      this.managePressed = true;
      this.options.tui.requestRender();
      return { consume: true };
    }

    if (this.isClearOthersTarget(x, y)) {
      this.clearPressed = true;
      this.options.tui.requestRender();
      return { consume: true };
    }

    if (this.isRefreshTarget(x, y)) {
      this.refreshPressed = true;
      this.options.tui.requestRender();
      return { consume: true };
    }

    this.pressedTarget = this.targetAt(x, y);
    if (this.pressedTarget) this.options.tui.requestRender();
    return this.pressedTarget ? { consume: true } : undefined;
  }

  refresh(): void {
    if (this.disposed) return;
    if (this.loadInFlight) {
      this.refreshPending = true;
      return;
    }

    this.loadInFlight = true;
    if (this.sessions.length === 0) this.loading = true;
    this.options.tui.requestRender();
    // A synchronous throw from loadSessions must follow the same failed-refresh path.
    let loading: Promise<readonly SessionListItem[]>;
    try {
      loading = Promise.resolve(this.options.loadSessions());
    } catch (error) {
      loading = Promise.reject(error);
    }
    void loading
      .then((sessions) => {
        if (this.disposed) return;
        this.sessions = [...sessions];
        this.error = undefined;
        this.loading = false;
      })
      .catch((error) => {
        if (this.disposed) return;
        // Keep the last good list: a failed refresh must not look like "no sessions".
        // A blank message must still render as a failure, not as "No saved sessions".
        this.error = (error instanceof Error ? error.message : String(error)).trim() || "Unknown error";
        this.loading = false;
      })
      .finally(() => {
        this.loadInFlight = false;
        if (this.disposed) return;
        this.options.tui.requestRender();
        if (this.refreshPending) {
          this.refreshPending = false;
          this.refresh();
        }
      });
  }

  render(width: number): string[] {
    const renderWidth = Math.max(1, Math.min(width, this.options.getDesiredWidth()));
    const contentWidth = Math.max(1, renderWidth - 4);
    const now = this.options.now?.() ?? Date.now();
    const rows = this.visibleSessions();
    const body: string[] = rows.length > 0
      ? rows.map((session) => panelContent(
          this.theme,
          formatSessionRow(session, contentWidth, now, Boolean(this.options.onTogglePin)),
          this.pressedTarget?.session.id === session.id
            ? "warning"
            : session.current
              ? "accent"
              : "dim",
          contentWidth,
        ))
      : this.error ? [] : [panelContent(
          this.theme,
          this.loading ? "Загружаю…" : "Нет сохранённых сессий",
          "dim",
          contentWidth,
        )];
    // Sits under the retained rows, so row hit-testing keeps its index mapping.
    if (this.error) {
      body.push(panelContent(this.theme, `⚠ Ошибка: ${this.error} · повтор ↻`, "warning", contentWidth));
    }

    return [
      renderSessionTitleRow(this.theme, this.loading || this.loadInFlight ? "СЕССИИ …" : this.error ? "СЕССИИ ⚠" : "СЕССИИ ↻", renderWidth, this.clearPressed, this.managePressed, Boolean(this.options.onOpenManager)),
      ...body,
      panelBottom(this.theme, renderWidth),
    ].map((line) => truncateToWidth(line, renderWidth, ""));
  }

  invalidate(): void {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.refreshPressed = false;
    this.clearPressed = false;
    this.managePressed = false;
    this.pressedTarget = undefined;
    this.uninstallInput();
  }
}
