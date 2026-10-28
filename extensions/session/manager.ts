import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import type { SessionListItem } from "./panel.ts";

export type SessionSort = "recent" | "oldest" | "prompts" | "title";
export const SESSION_PAGE_SIZE = 8;

/** Store only opaque session ids; session contents and titles never leave Pi. */
export function readSessionPins(path: string): ReadonlySet<string> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
  if (text.length > 128_000) throw new Error("Session pins file is too large");
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length > 2000 ||
      !parsed.every((id) => typeof id === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(id))) {
    throw new Error("Invalid session pins file");
  }
  return new Set(parsed as string[]);
}

/** Atomic, user-private persistence. Never write back a corrupt pins file. */
export function toggleSessionPin(path: string, id: string): boolean {
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(id)) throw new Error("Invalid session identifier");
  const pins = new Set(readSessionPins(path));
  const pinned = !pins.has(id);
  if (pinned) pins.add(id);
  else pins.delete(id);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify([...pins]), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return pinned;
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
  let sessions = await options.loadSessions();
  const expanded = new Set<string>();
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
      `Сессии · ${current.total}/${sessions.length} · ${page + 1}/${current.pages}${query ? ` · Поиск: ${safeLabel(query)}` : ""}`,
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
      sessions = await options.loadSessions();
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
        try {
          const pinned = options.togglePin(session.id);
          ui.notify(pinned ? "Сессия закреплена." : "Закрепление снято.", "info");
          options.onPinChanged();
          sessions = await options.loadSessions();
          page = 0;
        } catch (error) {
          ui.notify(`Не удалось сохранить закрепление: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
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
