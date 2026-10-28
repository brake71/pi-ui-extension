import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createSessionCatalog } from "./catalog.ts";

test("catalog shares unchanged summaries, reads only changed files and tracks discovery/removal", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-catalog-")), directory = join(root, "sessions");
  const makeSession = (cwd: string, title: string) => {
    const session = SessionManager.create(cwd, directory);
    session.appendMessage({ role: "user", content: title, timestamp: 1000 });
    session.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "1", content: [{ type: "text", text: "x".repeat(100000) }], isError: false, timestamp: 1001 });
    return session;
  };
  try {
    const a = makeSession(root, "A"), b = makeSession(root, "B");
    makeSession(tmpdir(), "Another project");
    const handle = await open(a.getSessionFile()!);
    const prototype = Object.getPrototypeOf(handle);
    const original = prototype.createReadStream;
    await handle.close();
    let reads = 0;
    t.mock.method(prototype, "createReadStream", function (this: FileHandle, ...args: any[]) {
      reads++;
      return Reflect.apply(original, this, args);
    });
    const catalog = createSessionCatalog();
    const first = await catalog(root, directory);
    assert.equal(first.length, 2);
    assert.equal(reads, 3);
    assert.ok(first.every(session => session.userPromptCount === 1));
    const [second, third] = await Promise.all([catalog(root, directory), catalog(root, directory)]);
    assert.equal(reads, 3, "overlapping UI refreshes must not read unchanged histories");
    assert.strictEqual(second.find(session => session.id === a.getSessionId()), first.find(session => session.id === a.getSessionId()));
    // Concurrent file reads may finish in either order; the UI sorts these summaries.
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    assert.deepEqual([...third].sort(byId), [...second].sort(byId));
    a.appendMessage({ role: "user", content: "Second question", timestamp: 2000 });
    a.appendSessionInfo("Renamed A");
    const updated = await catalog(root, directory);
    assert.equal(reads, 4);
    assert.equal(updated.find(session => session.id === a.getSessionId())?.name, "Renamed A");
    assert.equal(updated.find(session => session.id === a.getSessionId())?.userPromptCount, 2);
    const sdk = await SessionManager.list(root, directory);
    for (const summary of updated) {
      const expected = sdk.find(session => session.id === summary.id)!;
      assert.equal(summary.firstMessage, expected.firstMessage);
      assert.equal(summary.modified.getTime(), expected.modified.getTime());
      assert.equal(summary.name, expected.name);
    }
    rmSync(b.getSessionFile()!);
    assert.equal((await catalog(root, directory)).length, 1);
    assert.equal(reads, 4);
    const c = makeSession(root, "C");
    assert.ok((await catalog(root, directory)).some(session => session.id === c.getSessionId()));
    assert.equal(reads, 5);
    // Replacement at the same path must invalidate the cached identity.
    const replacement = `${c.getSessionFile()!}.replacement`;
    writeFileSync(replacement, [
      { type: "session", id: "replacement", cwd: root, timestamp: new Date(3000).toISOString() },
      { type: "message", message: { role: "user", content: "Replaced", timestamp: 3000 } },
    ].map(entry => JSON.stringify(entry)).join("\n"));
    renameSync(replacement, c.getSessionFile()!);
    assert.ok((await catalog(root, directory)).some(session => session.id === "replacement"));
    assert.equal(reads, 6);
    writeFileSync(c.getSessionFile()!, "invalid history\n");
    assert.equal((await catalog(root, directory)).length, 1);
    rmSync(directory, { recursive: true });
    assert.deepEqual(await catalog(root, directory), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("catalog resolves parent session paths to same-project parent IDs and ignores orphans", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-catalog-tree-")), directory = join(root, "sessions");
  try {
    const parent = SessionManager.create(root, directory);
    parent.appendMessage({ role: "user", content: "parent", timestamp: 1 });
    const child = SessionManager.create(root, directory);
    child.appendMessage({ role: "user", content: "child", timestamp: 2 });
    const childPath = child.getSessionFile()!;
    writeFileSync(childPath, readFileSync(childPath, "utf8").replace('"cwd":', `"parentSession":${JSON.stringify(parent.getSessionFile())},"cwd":`));
    const orphan = SessionManager.create(root, directory);
    orphan.appendMessage({ role: "user", content: "orphan", timestamp: 3 });
    const orphanPath = orphan.getSessionFile()!;
    writeFileSync(orphanPath, readFileSync(orphanPath, "utf8").replace('"cwd":', `"parentSession":${JSON.stringify(join(directory, "missing.jsonl"))},"cwd":`));
    const summaries = await createSessionCatalog()(root, directory);
    assert.equal(summaries.find(item => item.id === child.getSessionId())?.parentId, parent.getSessionId());
    assert.equal(summaries.find(item => item.id === child.getSessionId())?.parentSession, parent.getSessionFile());
    assert.equal(summaries.find(item => item.id === orphan.getSessionId())?.parentId, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("catalog does not cache a file changed during its read", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-catalog-race-"));
  try {
    const session = SessionManager.create(root, root);
    session.appendMessage({ role: "user", content: "Before", timestamp: 1 });
    const path = session.getSessionFile()!;
    const handle = await open(path), prototype = Object.getPrototypeOf(handle), original = prototype.createReadStream;
    await handle.close();
    let changed = false;
    t.mock.method(prototype, "createReadStream", function (this: FileHandle, ...args: any[]) {
      if (!changed) {
        changed = true;
        appendFileSync(path, JSON.stringify({ type: "message", message: { role: "user", content: "During", timestamp: 2 } }) + "\n");
      }
      return Reflect.apply(original, this, args);
    });
    const catalog = createSessionCatalog();
    assert.deepEqual(await catalog(root, root), []);
    const stable = await catalog(root, root);
    assert.equal(stable[0]?.userPromptCount, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
