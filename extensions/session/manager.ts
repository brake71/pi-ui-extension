import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import type { SessionListItem } from "./panel.ts";

export type SessionSort = "recent" | "oldest" | "prompts" | "title";
export const SESSION_PAGE_SIZE = 8;

const MAX_PINS = 2000;
const MAX_PINS_BYTES = 128_000;
const PIN_ID = /^[a-zA-Z0-9._-]{1,128}$/;

/** Store only opaque session ids; session contents and titles never leave Pi. */
export function readSessionPins(path: string): ReadonlySet<string> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
  if (text.length > MAX_PINS_BYTES) throw new Error("Session pins file is too large");
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length > MAX_PINS ||
      !parsed.every((id) => typeof id === "string" && PIN_ID.test(id))) {
    throw new Error("Invalid session pins file");
  }
  return new Set(parsed as string[]);
}

/** The reader and the writer share one count and size limit, checked before anything is written. */
function serializeSessionPins(pins: ReadonlySet<string>): string {
  const ids = [...pins];
  if (ids.length > MAX_PINS) throw new Error(`Session pins cannot exceed ${MAX_PINS} entries`);
  const text = JSON.stringify(ids);
  if (text.length > MAX_PINS_BYTES) throw new Error(`Session pins cannot exceed ${MAX_PINS_BYTES} characters`);
  return text;
}

/** Atomic, user-private persistence. Never write back a corrupt pins file. */
function writeSessionPins(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  // "wx" claims the temporary name exclusively. Ownership starts at open, so a partial
  // write that throws still cleans up its own file, while EEXIST never touches a foreign one.
  const fd = openSync(temporary, "wx", 0o600);
  let opened = true;
  try {
    writeFileSync(fd, text, { encoding: "utf8" });
    closeSync(fd);
    opened = false;
    renameSync(temporary, path);
  } finally {
    if (opened) { try { closeSync(fd); } catch { /* keep the original failure */ } }
    rmSync(temporary, { force: true });
  }
}

function lockOwnerFile(lock: string): string {
  return `${lock}/owner.json`;
}

/**
 * An existing lock always fails the write: two processes can both judge an old lock dead,
 * and the later one would delete the lock its peer just took. Only a human removes leftovers.
 */
function acquirePinsLock(lock: string): void {
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Session pins are locked by another process; retry shortly (leftover lock: ${lockOwnerFile(lock)})`,
      );
    }
    throw error;
  }
  try {
    writeFileSync(lockOwnerFile(lock), JSON.stringify({ pid: process.pid }), { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    rmSync(lock, { recursive: true, force: true });
    throw error;
  }
}

/** Pins are read-modify-written under a per-file lock so concurrent processes never drop an update. */
export function toggleSessionPin(path: string, id: string): boolean {
  if (!PIN_ID.test(id)) throw new Error("Invalid session identifier");
  const lock = `${path}.lock`;
  acquirePinsLock(lock);
  try {
    const pins = new Set(readSessionPins(path));
    const pinned = !pins.has(id);
    if (pinned) pins.add(id);
    else pins.delete(id);
    writeSessionPins(path, serializeSessionPins(pins));
    return pinned;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export function sortedSessions(sessions: readonly SessionListItem[], sort: SessionSort): SessionListItem[] {
  return [...sessions].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    const diff = sort === "recent" ? b.modified.getTime() - a.modified.getTime()
      : sort === "oldest" ? a.modified.getTime() - b.modified.getTime()
        : sort === "prompts" ? (b.userPromptCount ?? -1) - (a.userPromptCount ?? -1)
          : a.title.localeCompare(b.title);
    return (Number.isFinite(diff) ? diff : 0) || a.id.localeCompare(b.id);
  });
}

/** Pinned and active sessions are protected from the bulk-clear operation. */
export function sessionsEligibleForClear<T extends { readonly id: string }>(
  sessions: readonly T[], activeId: string, pins: ReadonlySet<string>,
): T[] {
  return sessions.filter((session) => session.id !== activeId && !pins.has(session.id));
}

export function getSessionPage(
  sessions: readonly SessionListItem[], query: string, sort: SessionSort, requestedPage: number,
  pageSize = SESSION_PAGE_SIZE,
): { readonly items: readonly SessionListItem[]; readonly total: number; readonly page: number; readonly pages: number } {
  const q = query.trim().toLocaleLowerCase();
  const filtered = sortedSessions(sessions.filter((session) =>
    !q || session.title.toLocaleLowerCase().includes(q) || session.id.toLocaleLowerCase().includes(q),
  ), sort);
  const pages = Math.max(1, Math.ceil(filtered.length / Math.max(1, pageSize)));
  const page = Math.max(0, Math.min(Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 0, pages - 1));
  return {
    items: filtered.slice(page * pageSize, (page + 1) * pageSize),
    total: filtered.length, page, pages,
  };
}

export type SessionManagerUI = {
  select(title: string, choices: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  notify(message: string, level: "info" | "warning" | "error"): void;
};

export type SessionManagerOptions = {
  readonly ui: SessionManagerUI;
  readonly loadSessions: () => Promise<readonly SessionListItem[]>;
  readonly togglePin: (id: string) => boolean;
  readonly onPinChanged: () => void;
  readonly onSwitch: (session: SessionListItem) => void;
  readonly onRename: (session: SessionListItem) => void;
  readonly onDelete: (session: SessionListItem) => void;
};

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim() || "Unknown error";
}

const SORT_CHOICES: ReadonlyArray<{ sort: SessionSort; label: string }> = [
  { sort: "recent", label: "Сначала новые" },
  { sort: "oldest", label: "Сначала старые" },
  { sort: "prompts", label: "По числу вопросов" },
  { sort: "title", label: "По названию" },
];

function pluralize(count: number, forms: readonly [string, string, string]): string {
  const mod100 = count % 100;
  if (mod100 >= 11 && mod100 <= 14) return forms[2];
  const mod10 = count % 10;
  return mod10 === 1 ? forms[0] : mod10 >= 2 && mod10 <= 4 ? forms[1] : forms[2];
}

function safeLabel(title: string): string {
  const cleaned = stripTerminalSequences(title).replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ").trim() || "(без названия)";
  return truncateToWidth(cleaned, 65, "…");
}

/** Modal, bounded page of sessions; never executes destructive operations without confirmation. */
export async function openSessionManager(options: SessionManagerOptions): Promise<void> {
  const { ui } = options;
  let query = "";
  let sort: SessionSort = "recent";
  let page = 0;
  let sessions: readonly SessionListItem[] = [];
  let loadError: string | undefined;
  const expanded = new Set<string>();
  /** Keeps the last good list, sort, filter and page when a load fails. */
  const reload = async (): Promise<void> => {
    try {
      sessions = await options.loadSessions();
      loadError = undefined;
    } catch (error) {
      // A blank message must still read as a failure, never as an empty list.
      loadError = errorText(error);
      ui.notify(`Не удалось обновить список сессий: ${loadError}`, "warning");
    }
  };
  await reload();
  for (;;) {
    const children = new Map<string, SessionListItem[]>();
    for (const session of sessions) if (session.parentId) {
      const list = children.get(session.parentId) ?? [];
      list.push(session);
      children.set(session.parentId, list);
    }
    const roots = sessions.filter(session => !session.parentId);
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const matchesSession = (session: SessionListItem): boolean => !normalizedQuery ||
      session.title.toLocaleLowerCase().includes(normalizedQuery) || session.id.toLocaleLowerCase().includes(normalizedQuery);
    const matchesTree = (session: SessionListItem, ancestors = new Set<string>()): boolean => {
      if (matchesSession(session)) return true;
      if (ancestors.has(session.id)) return false;
      const nextAncestors = new Set(ancestors).add(session.id);
      return (children.get(session.id) ?? []).some(child => matchesTree(child, nextAncestors));
    };
    const candidates = normalizedQuery ? roots.filter(root => matchesTree(root)) : roots;
    const current = getSessionPage(candidates, "", sort, page);
    page = current.page;
    const labelFor = (session: SessionListItem, index: number, indent = "") =>
      `${indent}${index + 1}. ${session.pinned ? "★ " : ""}${session.current ? "● " : ""}${safeLabel(session.title)} · ${session.userPromptCount ?? "?"} ${pluralize(session.userPromptCount ?? 0, ["вопрос", "вопроса", "вопросов"])}`;
    const rows: Array<{ label: string; session?: SessionListItem; groupId?: string }> = [];
    const append = (session: SessionListItem, index: number, indent = "") => {
      rows.push({ label: labelFor(session, index, indent), session });
      const nested = (children.get(session.id) ?? []).sort((a, b) => b.modified.getTime() - a.modified.getTime());
      if (!nested.length) return;
      const searchExpand = normalizedQuery && !matchesSession(session) && nested.some(child => matchesTree(child));
      const isExpanded = expanded.has(session.id) || Boolean(searchExpand);
      rows.push({ label: `${indent}${isExpanded ? "▾" : "▸"} Подчинённые сессии (${nested.length}) · ${safeLabel(session.title)}`, groupId: session.id });
      if (isExpanded) {
        const visibleChildren = normalizedQuery ? nested.filter(child => matchesTree(child)) : nested;
        visibleChildren.forEach((child, childIndex) => append(child, childIndex, `${indent}  `));
      }
    };
    current.items.forEach((session, index) => append(session, index));
    const labels = rows.map(row => row.label);
    const actions = [
      "⌕ Найти / сбросить поиск",
      `↕ Сортировка: ${SORT_CHOICES.find((choice) => choice.sort === sort)!.label}`,
      ...(page > 0 ? ["← Предыдущая страница"] : []),
      ...(page + 1 < current.pages ? ["Следующая страница →"] : []),
      "↻ Обновить список",
      "Закрыть",
    ];
    const choice = await ui.select(
      `Сессии · ${current.total}/${sessions.length} · ${page + 1}/${current.pages}${query ? ` · Поиск: ${safeLabel(query)}` : ""}` +
        (loadError ? ` · ⚠ Ошибка загрузки: ${safeLabel(loadError)}` : ""),
      [...labels, ...actions],
    );
    if (!choice || choice === "Закрыть") return;
    if (choice === actions[0]) {
      const next = await ui.input("Название сессии или ID (пусто — сбросить поиск)", query);
      if (next !== undefined) { query = next.trim(); page = 0; }
    } else if (choice === actions[1]) {
      const names = SORT_CHOICES.map(({ label, sort: key }) => `${key === sort ? "● " : "○ "}${label}`);
      const selection = await ui.select("Сортировка (закреплённые сессии всегда выше)", names);
      const index = names.indexOf(selection ?? "");
      if (index >= 0) { sort = SORT_CHOICES[index]!.sort; page = 0; }
    } else if (choice === "← Предыдущая страница") {
      page--;
    } else if (choice === "Следующая страница →") {
      page++;
    } else if (choice === "↻ Обновить список") {
      await reload();
    } else {
      const row = rows.find(item => item.label === choice);
      if (row?.groupId) {
        if (expanded.has(row.groupId)) expanded.delete(row.groupId);
        else expanded.add(row.groupId);
        continue;
      }
      const session = row?.session;
      if (!session) continue;
      const menu = [
        ...(session.current ? [] : ["Переключиться на сессию"]),
        "Переименовать",
        session.pinned ? "Открепить" : "Закрепить",
        ...(session.current ? [] : ["Переместить в корзину"]),
        "Назад к списку",
      ];
      const action = await ui.select(`${safeLabel(session.title)} · Управление`, menu);
      if (action === "Закрепить" || action === "Открепить") {
        let pinned: boolean;
        try {
          pinned = options.togglePin(session.id);
        } catch (error) {
          ui.notify(`Не удалось сохранить закрепление: ${error instanceof Error ? error.message : String(error)}`, "error");
          continue;
        }
        // Already persisted: show it even if the reload below fails.
        sessions = sessions.map((item) => (item.id === session.id ? { ...item, pinned } : item));
        try {
          options.onPinChanged();
        } catch (error) {
          // The pin is already saved: a sidebar refresh failure is not a save failure.
          ui.notify(`Не удалось обновить боковую панель: ${errorText(error)}`, "warning");
        }
        page = 0;
        await reload();
        ui.notify(pinned ? "Сессия закреплена." : "Закрепление снято.", "info");
      } else if (action === "Переместить в корзину") {
        // The central delete command owns the final confirmation for both
        // the sidebar and this manager. Never present two successive prompts.
        options.onDelete(session);
        return;
      } else if (action === "Переключиться на сессию") {
        options.onSwitch(session);
        return;
      } else if (action === "Переименовать") {
        options.onRename(session);
        return;
      }
    }
  }
}
