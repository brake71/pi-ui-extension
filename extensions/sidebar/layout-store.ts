import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** A layout file is a few bytes; anything larger is not ours and is ignored. */
const MAX_LAYOUT_BYTES = 4096;
const DEFAULT_SAVE_DELAY_MS = 400;

export type SidebarLayoutStore = {
  /** Stored user width, or undefined when missing, unreadable, corrupt or out of range. */
  readSidebarWidth(): number | undefined;
  /** Queue a width for persistence. Out-of-range values are ignored, never written. */
  saveSidebarWidth(width: number): void;
  /** Write a queued width immediately. Safe to call more than once. */
  dispose(): void;
};

export type SidebarLayoutStoreOptions = {
  readonly path: string;
  readonly min: number;
  readonly max: number;
  /** Test hook; production uses the default debounce. */
  readonly saveDelayMs?: number;
};

function isWidthInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** Read-only, never throws: a damaged layout file must not disturb the UI. */
export function readStoredSidebarWidth(path: string, min: number, max: number): number | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  if (text.length > MAX_LAYOUT_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const width = (parsed as { sidebarWidth?: unknown }).sidebarWidth;
  return isWidthInRange(width, min, max) ? width : undefined;
}

/**
 * Same persistence shape as the session pins: an exclusively claimed temporary
 * file next to the target, then a rename, so a crash never leaves half a file.
 */
export function writeStoredSidebarWidth(path: string, width: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  let opened = true;
  try {
    writeFileSync(fd, `${JSON.stringify({ version: 1, sidebarWidth: width })}\n`, { encoding: "utf8" });
    closeSync(fd);
    opened = false;
    renameSync(temporary, path);
  } finally {
    if (opened) { try { closeSync(fd); } catch { /* keep the original failure */ } }
    rmSync(temporary, { force: true });
  }
}

/**
 * Width persistence for the sidebar. Writes are debounced because drag and
 * resize gestures report many intermediate widths, while only the last one matters.
 */
export function createSidebarLayoutStore(options: SidebarLayoutStoreOptions): SidebarLayoutStore {
  const delay = options.saveDelayMs ?? DEFAULT_SAVE_DELAY_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: number | undefined;
  let stored: number | undefined;
  let disposed = false;

  const flush = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const width = pending;
    pending = undefined;
    if (width === undefined || width === stored) return;
    try {
      writeStoredSidebarWidth(options.path, width);
      stored = width;
    } catch { /* An unwritable layout file must not fail the sidebar. */ }
  };

  return {
    readSidebarWidth(): number | undefined {
      const width = readStoredSidebarWidth(options.path, options.min, options.max);
      if (width !== undefined) stored = width;
      return width;
    },
    saveSidebarWidth(width: number): void {
      if (disposed || !isWidthInRange(width, options.min, options.max)) return;
      pending = width;
      if (timer) return;
      timer = setTimeout(flush, delay);
      timer.unref?.();
    },
    dispose(): void {
      flush();
      disposed = true;
    },
  };
}
