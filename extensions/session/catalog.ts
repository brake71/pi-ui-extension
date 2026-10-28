import { open, readdir, stat, type FileHandle } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { SessionFileSnapshot } from "./safety.ts";

export type SessionSummary = {
  readonly id: string;
  readonly path: string;
  readonly cwd: string;
  readonly parentSession?: string;
  readonly parentId?: string;
  readonly name?: string;
  readonly firstMessage: string;
  readonly modified: Date;
  readonly userPromptCount: number;
};
type CachedSummary = { readonly snapshot: SessionFileSnapshot; readonly summary: SessionSummary };
const sameFile = (a: SessionFileSnapshot, b: SessionFileSnapshot): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const expandPath = (path: string): string => resolve(path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** A sidebar needs summaries, not the SDK list's concatenation of every message body. */
async function readSummary(path: string, expected: SessionFileSnapshot): Promise<SessionSummary | undefined> {
  let file: FileHandle | undefined;
  try {
    file = await open(path, "r");
    if (!sameFile(await file.stat(), expected)) return undefined;
    const input = file.createReadStream({ autoClose: false });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let header: Record<string, unknown> | undefined;
    let name: string | undefined;
    let parentSession: string | undefined;
    let firstMessage = "";
    let userPromptCount = 0;
    let lastActivity: number | undefined;
    try {
      for await (const line of lines) {
        let entry: Record<string, unknown> | undefined;
        try { entry = record(JSON.parse(line)); } catch { continue; }
        if (!entry) continue;
        if (!header) {
          if (entry.type !== "session" || typeof entry.id !== "string") return undefined;
          header = entry;
          parentSession = typeof entry.parentSession === "string" ? entry.parentSession : undefined;
          continue;
        }
        if (entry.type === "session_info") name = typeof entry.name === "string" ? entry.name.trim() || undefined : undefined;
        if (entry.type !== "message") continue;
        const message = record(entry.message);
        if (message?.role === "user") userPromptCount++;
        if (!message || (message.role !== "user" && message.role !== "assistant") || !("content" in message)) continue;
        const timestamp = typeof message.timestamp === "number" ? message.timestamp
          : typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
        if (Number.isFinite(timestamp)) lastActivity = Math.max(lastActivity ?? 0, timestamp);
        if (!firstMessage && message.role === "user") {
          firstMessage = typeof message.content === "string" ? message.content
            : Array.isArray(message.content) ? message.content.flatMap(block => {
              const value = record(block);
              return value?.type === "text" && typeof value.text === "string" ? [value.text] : [];
            }).join(" ") : "";
        }
      }
      // Destroying a FileHandle stream also closes its descriptor, even with
      // autoClose:false. Validate both identities before releasing the stream.
      if (!header || !sameFile(await file.stat(), expected) || !sameFile(await stat(path), expected)) return undefined;
      const created = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : NaN;
      return {
        id: header.id as string, path, cwd: typeof header.cwd === "string" ? header.cwd : "",
        ...(parentSession === undefined ? {} : { parentSession }),
        ...(name === undefined ? {} : { name }), firstMessage: firstMessage || "(no messages)", userPromptCount,
        modified: new Date(lastActivity !== undefined && lastActivity > 0 ? lastActivity : Number.isFinite(created) ? created : expected.mtimeMs),
      };
    } finally {
      lines.close();
      input.destroy();
    }
  } catch {
    return undefined;
  } finally {
    await file?.close();
  }
}

/** Re-stat on every refresh; only changed files are read. Shared by both session UIs. */
export function createSessionCatalog() {
  const cache = new Map<string, CachedSummary>();
  let queue = Promise.resolve<readonly SessionSummary[]>([]);
  return (cwd: string, sessionDir: string): Promise<readonly SessionSummary[]> => {
    const load = async (): Promise<readonly SessionSummary[]> => {
      const directory = expandPath(sessionDir);
      let names: string[];
      try { names = await readdir(directory); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") { cache.clear(); return []; }
        throw error;
      }
      const paths = names.filter(name => name.endsWith(".jsonl")).map(name => join(directory, name));
      const currentPaths = new Set(paths);
      for (const path of cache.keys()) if (!currentPaths.has(path)) cache.delete(path);
      const summaries: SessionSummary[] = [];
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(8, paths.length) }, async () => {
        while (next < paths.length) {
          const path = paths[next++]!;
          try {
            const info = await stat(path);
            if (!info.isFile()) { cache.delete(path); continue; }
            const cached = cache.get(path);
            const summary = cached && sameFile(cached.snapshot, info) ? cached.summary : await readSummary(path, info);
            if (summary) {
              cache.set(path, { snapshot: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }, summary });
              // Custom/shared directories must not expose another project's sessions.
              if (summary.cwd && expandPath(summary.cwd) === expandPath(cwd)) summaries.push(summary);
            } else cache.delete(path);
          } catch { cache.delete(path); }
        }
      }));
      const byPath = new Map(summaries.map(summary => [resolve(summary.path), summary.id]));
      return summaries.map(summary => {
        const parentId = summary.parentSession ? byPath.get(resolve(summary.parentSession)) : undefined;
        if (!parentId) return summary;
        return { ...summary, parentId };
      });
    };
    queue = queue.then(load, load);
    return queue;
  };
}
