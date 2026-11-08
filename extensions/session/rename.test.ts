import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { renameSavedSession, sameSessionFile } from "./rename.ts";
import { snapshotClearableSession, type SessionFileSnapshot } from "./safety.ts";

/** Real session file plus a file identity captured before the rename dialog. */
async function setup(): Promise<{
  root: string;
  directory: string;
  path: string;
  id: string;
  before: SessionFileSnapshot;
  call: (overrides?: Partial<Parameters<typeof renameSavedSession>[0]>) => Promise<Awaited<ReturnType<typeof renameSavedSession>>>;
  name: () => Promise<string | undefined>;
}> {
  const root = mkdtempSync(join(tmpdir(), "pi-rename-"));
  const directory = join(root, "sessions");
  const session = SessionManager.create(root, directory);
  session.appendMessage({ role: "user", content: "Hello", timestamp: 1_000 });
  const path = session.getSessionFile()!;
  const id = session.getSessionId();
  const before = (await snapshotClearableSession(path))!;
  const base = {
    cwd: root,
    sessionDir: directory,
    sessionId: id,
    path,
    name: "New name",
    before,
    activePaths: () => new Set<string>(),
  };
  return {
    root, directory, path, id, before,
    call: (overrides = {}) => renameSavedSession({ ...base, ...overrides }),
    name: async () => (await SessionManager.list(root, directory)).find((s) => s.id === id)?.name,
  };
}

test("renames a saved session that is not the current one", async () => {
  const current = await setup();
  try {
    const result = await current.call();
    assert.deepEqual(result, { ok: true });
    assert.equal(await current.name(), "New name");
  } finally { rmSync(current.root, { recursive: true, force: true }); }
});

test("a session deleted while the dialog was open is never written", async () => {
  const current = await setup();
  try {
    rmSync(current.path);
    const result = await current.call();
    assert.equal(result.ok, false);
    assert.match((result as { message: string }).message, /changed or was removed/);
    assert.equal((await SessionManager.list(current.root, current.directory)).length, 0,
      "the rename must not recreate or touch the deleted file");
  } finally { rmSync(current.root, { recursive: true, force: true }); }
});

test("a session replaced or modified while the dialog was open keeps its file", async () => {
  const replaced = await setup();
  try {
    const replacement = `${replaced.path}.replacement`;
    writeFileSync(replacement, [
      { type: "session", id: "replacement", cwd: replaced.root, timestamp: new Date(2_000).toISOString() },
      { type: "message", message: { role: "user", content: "Replaced", timestamp: 2_000 } },
    ].map((entry) => JSON.stringify(entry)).join("\n"));
    renameSync(replacement, replaced.path);
    const result = await replaced.call();
    assert.equal(result.ok, false, "a replacement file is not the session the user picked");
    assert.equal((await SessionManager.list(replaced.root, replaced.directory)).find((s) => s.id === "replacement")?.name,
      undefined, "the replacement is never renamed");
  } finally { rmSync(replaced.root, { recursive: true, force: true }); }

  const modified = await setup();
  try {
    appendFileSync(modified.path, `${JSON.stringify({ type: "session_info", id: "x", parentId: null, timestamp: new Date(3_000).toISOString(), name: "Theirs" })}\n`);
    const result = await modified.call();
    assert.equal(result.ok, false, "a file that changed during the dialog is not rewritten");
    assert.match((result as { message: string }).message, /changed or disappeared/);
    assert.equal(await modified.name(), "Theirs", "the concurrent name survives");
  } finally { rmSync(modified.root, { recursive: true, force: true }); }
});

test("a session open in another Pi instance is not renamed", async () => {
  const current = await setup();
  try {
    const result = await current.call({ activePaths: () => new Set([resolve(current.path)]) });
    assert.equal(result.ok, false);
    assert.match((result as { message: string }).message, /another Pi instance/);
    assert.equal(await current.name(), undefined);
  } finally { rmSync(current.root, { recursive: true, force: true }); }
});

test("an unreadable active-session registry fails closed", async () => {
  const current = await setup();
  try {
    const result = await current.call({ activePaths: () => { throw new Error("Invalid active session record"); } });
    assert.equal(result.ok, false);
    assert.equal((result as { level: string }).level, "error");
    assert.match((result as { message: string }).message, /Cannot verify/);
    assert.equal(await current.name(), undefined);
  } finally { rmSync(current.root, { recursive: true, force: true }); }
});

test("a rename that Pi reports without persisting is reported as a failure", async () => {
  const current = await setup();
  try {
    // A write can report success and persist nothing, so the write must be verified.
    const result = await current.call({ write: () => {} });
    assert.equal(result.ok, false, "a silent no-op write is never reported as Session renamed");
    assert.match((result as { message: string }).message, /not saved/);
    assert.equal(await current.name(), undefined);
  } finally { rmSync(current.root, { recursive: true, force: true }); }
});

test("a file swapped during the write is reported as a failure", async () => {
  const current = await setup();
  try {
    const identical = `${current.path}.identical`;
    writeFileSync(identical, readFileSync(current.path, "utf8"));
    // The write lands on a replacement inode: the name never reached the verified file.
    const result = await current.call({ write: (path) => { renameSync(identical, path); } });
    assert.equal(result.ok, false, "a different inode is not the verified session file");
    assert.match((result as { message: string }).message, /replaced, truncated or never updated/);
    assert.equal(await current.name(), undefined);
  } finally { rmSync(current.root, { recursive: true, force: true }); }
});

test("the live session file may grow but must stay the same file", async () => {
  const current = await setup();
  try {
    appendFileSync(current.path, `${JSON.stringify({ type: "session_info", id: "y", parentId: null, timestamp: new Date(4_000).toISOString(), name: "Later" })}\n`);
    assert.equal(await sameSessionFile(current.path, current.before), true, "an appended live session can still be renamed");

    const swapped = await setup();
    try {
      const identical = `${swapped.path}.identical`;
      writeFileSync(identical, readFileSync(swapped.path, "utf8"));
      renameSync(identical, swapped.path);
      assert.equal(await sameSessionFile(swapped.path, swapped.before), false, "a replaced file is not the live session");
    } finally { rmSync(swapped.root, { recursive: true, force: true }); }

    const removed = await setup();
    try {
      rmSync(removed.path);
      assert.equal(await sameSessionFile(removed.path, removed.before), false, "a removed file is not the live session");
    } finally { rmSync(removed.root, { recursive: true, force: true }); }
  } finally { rmSync(current.root, { recursive: true, force: true }); }
});
