import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deleteSessionFile } from "./mutations.ts";

test("trash failures never permanently delete the session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-trash-"));
  const path = join(directory, "session.jsonl");
  try {
    await writeFile(path, "session data\n");
    for (const failure of [new Error("spawn trash ENOENT"), new Error("timed out"), { code: 1, stderr: "permission denied\n" }, { code: 2, stderr: "" }]) {
      const pi = { async exec() { if (failure instanceof Error) throw failure; return failure; } } as any;
      const result = await deleteSessionFile(pi, path);
      assert.equal(result.ok, false);
      if (!result.ok) assert.ok(result.error.length > 0);
      assert.equal(await readFile(path, "utf8"), "session data\n");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows deletion moves a session file to the Recycle Bin", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-recycle-bin-"));
  const path = join(directory, "session.jsonl");
  try {
    await writeFile(path, "session data\n");
    const pi = {
      async exec(command: string, args: string[], options: { timeout: number }) {
        const result = spawnSync(command, args, { encoding: "utf8", timeout: options.timeout, windowsHide: true });
        return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr || result.error?.message || "" };
      },
    } as any;
    const result = await deleteSessionFile(pi, path);
    assert.equal(result.ok, true);
    if (result.ok) assert.ok(result.method === "trash" || result.method === "recycle");
    await assert.rejects(readFile(path), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("successful trash execution passes the session path to trash", async () => {
  const calls: unknown[][] = [];
  const pi = { async exec(...args: unknown[]) { calls.push(args); return { code: 0, stderr: "" }; } } as any;
  assert.deepEqual(await deleteSessionFile(pi, "/tmp/session.jsonl"), { ok: true, method: "trash" });
  assert.equal(calls[0]![2] instanceof Object && (calls[0]![2] as any).timeout, 10_000);
  assert.deepEqual(calls, [["trash", ["/tmp/session.jsonl"], { timeout: 10_000 }]]);
});

test("windows falls back to the recycle bin when trash is missing", { skip: process.platform !== "win32" }, async () => {
  const calls: unknown[][] = [];
  const pi = {
    async exec(...args: unknown[]) {
      calls.push(args);
      return args[0] === "trash" ? { code: 1, stderr: "" } : { code: 0, stderr: "" };
    },
  } as any;
  assert.deepEqual(await deleteSessionFile(pi, "C:\\sessions\\it's.jsonl"), { ok: true, method: "recycle" });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]![0], "powershell.exe");
  const script = (calls[1]![1] as string[]).join(" ");
  assert.match(script, /SendToRecycleBin/);
  assert.match(script, /it''s\.jsonl/);
});

test("windows reports both failures and never deletes permanently", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-recycle-"));
  const path = join(directory, "session.jsonl");
  try {
    await writeFile(path, "session data\n");
    const pi = { async exec() { return { code: 1, stderr: "denied\n" }; } } as any;
    const result = await deleteSessionFile(pi, path);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /trash: denied/);
      assert.match(result.error, /recycle bin: denied/);
    }
    assert.equal(await readFile(path, "utf8"), "session data\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
