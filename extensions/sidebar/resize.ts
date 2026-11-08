import type {
  Component,
  OverlayHandle,
  OverlayOptions,
  TUI,
  TuiInputListener,
} from "@earendil-works/pi-tui";

const SGR_MOUSE = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/;
const PREVIEW_FRAME_INTERVAL_MS = 16;

/** Capturing overlays own input; the non-capturing resize preview does not. */
export function isSidebarInputBlocked(tui: TUI): boolean {
  const overlays = tui as TUI & { isOverlayFocused?: () => boolean };
  return overlays.isOverlayFocused?.() ?? tui.hasOverlay?.() ?? false;
}

export type SgrMouseEvent = {
  readonly button: number;
  readonly x: number;
  readonly y: number;
  readonly release: boolean;
  readonly motion: boolean;
};

export function parseSgrMouseEvent(data: string): SgrMouseEvent | undefined {
  const match = data.match(SGR_MOUSE);
  if (!match) return undefined;
  const button = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  if (![button, x, y].every(Number.isFinite) || x < 1 || y < 1) return undefined;
  return { button, x, y, release: match[4] === "m", motion: (button & 32) !== 0 };
}

export class SidebarDivider implements Component {
  constructor(
    private readonly paint: (line: string) => string,
    private readonly getHeight: () => number,
  ) {}
  render(): string[] { return Array.from({ length: Math.max(1, this.getHeight()) }, () => this.paint("│")); }
  invalidate(): void {}
}

/**
 * Pi has no public input-listener priority API. Prefer its normal public
 * registration when internals differ, but disable gestures that strictly
 * require priority (divider dragging) to avoid conflicting with Pi.
 */
export function installPriorityInputListener(
  tui: TUI,
  listener: TuiInputListener,
  options: { requirePriority?: boolean } = {},
): () => void {
  const listeners = (tui as unknown as { inputListeners?: unknown }).inputListeners;
  if (!(listeners instanceof Set)) {
    return options.requirePriority ? () => {} : tui.addInputListener(listener);
  }
  const unsubscribe = tui.addInputListener(listener);
  if (!listeners.has(listener)) {
    if (options.requirePriority) {
      unsubscribe();
      return () => {};
    }
    return unsubscribe;
  }
  try {
    const existing = [...listeners].filter((item) => item !== listener);
    listeners.clear();
    listeners.add(listener);
    for (const item of existing) listeners.add(item);
  } catch {
    if (options.requirePriority) {
      unsubscribe();
      return () => {};
    }
  }
  return unsubscribe;
}

export type MouseResizeOptions = {
  readonly tui: TUI;
  readonly preview: Component;
  readonly isVisible: () => boolean;
  readonly getDividerX: () => number;
  readonly clampSidebarWidth: (width: number) => number;
  readonly commitSidebarWidth: (width: number) => void;
};

export function installMouseResize(options: MouseResizeOptions): () => void {
  let dragging = false;
  let dragColumns = 0;
  let dragRows = 0;
  let dragStartX = 0;
  let dragStartWidth = 0;
  let moved = false;
  let geometryTimer: ReturnType<typeof setInterval> | undefined;
  let previewHandle: OverlayHandle | undefined;
  let pendingX: number | undefined;
  let frameTimer: ReturnType<typeof setTimeout> | undefined;
  let lastFrameAt = 0;
  let disposed = false;
  const previewOptions: OverlayOptions = {
    width: 1,
    maxHeight: "100%",
    row: 0,
    col: Math.max(0, options.getDividerX() - 1),
    nonCapturing: true,
  };

  const clearFrameTimer = (): void => {
    if (frameTimer) clearTimeout(frameTimer);
    frameTimer = undefined;
  };
  const hidePreview = (): void => {
    previewHandle?.hide();
    previewHandle = undefined;
  };
  const cancelDrag = (): void => {
    dragging = false;
    pendingX = undefined;
    clearFrameTimer();
    if (geometryTimer) clearInterval(geometryTimer);
    geometryTimer = undefined;
    hidePreview();
  };
  const geometryValid = (): boolean => !isSidebarInputBlocked(options.tui) && options.isVisible()
    && (!dragging || (dragColumns === options.tui.terminal.columns && dragRows === options.tui.terminal.rows));
  const flushPreview = (): void => {
    clearFrameTimer();
    if (disposed || !geometryValid()) { cancelDrag(); return; }
    if (pendingX === undefined) return;
    previewOptions.col = Math.max(0, pendingX - 1);
    pendingX = undefined;
    lastFrameAt = performance.now();
    options.tui.requestRender();
  };
  const schedulePreview = (x: number): void => {
    pendingX = x;
    if (frameTimer) return;
    const elapsed = performance.now() - lastFrameAt;
    frameTimer = setTimeout(flushPreview, Math.max(0, PREVIEW_FRAME_INTERVAL_MS - elapsed));
    frameTimer.unref?.();
  };
  const sidebarWidthAt = (x: number): number => options.clampSidebarWidth(options.tui.terminal.columns - x);
  const previewXFor = (x: number): number => options.tui.terminal.columns - sidebarWidthAt(x);

  const listener: TuiInputListener = (data) => {
    if (disposed || !geometryValid()) { cancelDrag(); return undefined; }
    const mouse = parseSgrMouseEvent(data);
    if (!mouse) return undefined;

    if (mouse.release) {
      if (!dragging) return undefined;
      const startX = dragStartX;
      const startWidth = dragStartWidth;
      const didMove = moved;
      cancelDrag();
      // A press and release on the same column is a click, not a resize. Pi's
      // reported column can sit one column off getDividerX() when a clamped
      // layout is one column wider than the terminal, so the absolute release
      // column must never decide the width of a gesture that never moved.
      if (!didMove) return { consume: true };
      // Drag distance from the press position, not the release column: the same
      // offset cancels out, so a real one-column drag still resizes by one.
      options.commitSidebarWidth(startWidth + (startX - mouse.x));
      return { consume: true };
    }
    if (!mouse.motion && (mouse.button & 3) === 0 && (mouse.button & 64) === 0) {
      if (Math.abs(mouse.x - options.getDividerX()) > 1) return undefined;
      if (dragging) return { consume: true };
      dragging = true;
      dragStartX = mouse.x;
      dragStartWidth = options.tui.terminal.columns - options.getDividerX();
      moved = false;
      dragColumns = options.tui.terminal.columns;
      dragRows = options.tui.terminal.rows;
      // Only watch geometry during a drag, including resizes with no further mouse input.
      geometryTimer = setInterval(() => { if (!geometryValid()) cancelDrag(); }, PREVIEW_FRAME_INTERVAL_MS);
      geometryTimer.unref?.();
      previewOptions.col = Math.max(0, options.getDividerX() - 1);
      try {
        previewHandle = options.tui.showOverlay(options.preview, previewOptions);
      } catch {
        cancelDrag();
        return undefined;
      }
      return { consume: true };
    }
    if (mouse.motion && dragging) {
      if (mouse.x !== dragStartX) moved = true;
      schedulePreview(previewXFor(mouse.x));
      return { consume: true };
    }
    return dragging ? { consume: true } : undefined;
  };

  const unsubscribe = installPriorityInputListener(options.tui, listener, { requirePriority: true });

  return () => {
    disposed = true;
    cancelDrag();
    unsubscribe();
  };
}
