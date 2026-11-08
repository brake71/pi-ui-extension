import { resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { sessionFileUnchanged, snapshotClearableSession, type SessionFileSnapshot } from "./safety.ts";

/**
 * The live session keeps writing its own file, so only identity is compared: a file that
 * grew is still the same session, while a deleted or replaced one is not.
 */
export async function sameSessionFile(path: string, before: SessionFileSnapshot): Promise<boolean> {
  const now = await snapshotClearableSession(path);
  return now !== undefined && now.dev === before.dev && now.ino === before.ino;
}

export type RenameOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly level: "warning" | "error"; readonly message: string };

export type RenameSavedSessionArgs = {
  readonly cwd: string;
  readonly sessionDir: string;
  readonly sessionId: string;
  readonly path: string;
  readonly name: string;
  /** File identity captured while the rename dialog was open. */
  readonly before: SessionFileSnapshot;
  readonly activePaths: () => ReadonlySet<string>;
  /** Test seam: a no-op writer reproduces Pi opening a missing path and persisting nothing. */
  readonly write?: (path: string, name: string) => void;
};

/**
 * Rename a saved session that is not the current one. Every guard runs after the user
 * closed the dialog, so a session trimmed, replaced or opened elsewhere in the meantime
 * is never written; a resumed session keeps working normally.
 */
export async function renameSavedSession(args: RenameSavedSessionArgs): Promise<RenameOutcome> {
  const listed = (await SessionManager.list(args.cwd, args.sessionDir))
    .find((session) => session.id === args.sessionId);
  if (listed?.path !== args.path) {
    return { ok: false, level: "warning", message: "Session changed or was removed during rename; nothing was saved" };
  }
  if (!(await sessionFileUnchanged(args.path, args.before))) {
    return { ok: false, level: "warning", message: "Session file changed or disappeared during rename; nothing was saved" };
  }
  let active: ReadonlySet<string>;
  try {
    active = args.activePaths();
  } catch {
    // Unreadable registry data is not proof that no other Pi instance has this session open.
    return { ok: false, level: "error", message: "Cannot verify that no other Pi instance is using this session; rename cancelled" };
  }
  if (active.has(resolve(args.path))) {
    return { ok: false, level: "warning", message: "Session is in use by another Pi instance; rename cancelled" };
  }
  (args.write ?? defaultWrite)(args.path, args.name);
  // A write can return without persisting anything, so a rename is only reported
  // once the same file grew; a replaced or truncated file failed too.
  const after = await snapshotClearableSession(args.path);
  const written = after !== undefined && after.dev === args.before.dev && after.ino === args.before.ino &&
    after.size >= args.before.size &&
    (after.size !== args.before.size || after.mtimeMs !== args.before.mtimeMs);
  if (!written) {
    return { ok: false, level: "error", message: "Session name was not saved; the file was replaced, truncated or never updated" };
  }
  return { ok: true };
}

function defaultWrite(path: string, name: string): void {
  SessionManager.open(path).appendSessionInfo(name);
}
