import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getSessionPage, openSessionManager, readSessionPins, sessionsEligibleForClear, sortedSessions, toggleSessionPin,
  type SessionManagerUI,
} from "./manager.ts";
import type { SessionListItem } from "./panel.ts";

function session(id: string, modified: number, title = `Session ${id}`, prompts = 1): SessionListItem {
  return { id, title, modified: new Date(modified), userPromptCount: prompts, current: id === "id-0" };
}

test("sorting, searching and pagination scale to hundreds of sessions with pinned first", () => {
  const many = Array.from({ length: 105 }, (_, index) => session(`id-${index}`, index * 1000, `Branch ${index}`, index));
  many[0] = { ...many[0]!, pinned: true };
  assert.equal(sortedSessions(many, "recent")[0]!.id, "id-0");
  assert.deepEqual(getSessionPage(many, "", "recent", 0).items.map((s) => s.id).slice(0, 3),
    ["id-0", "id-104", "id-103"]);
  assert.equal(getSessionPage(many, "", "recent", 0).pages, 14);
  assert.equal(getSessionPage(many, "", "recent", 100).page, 13);
  assert.equal(getSessionPage(many, "", "recent", -10).page, 0);
  assert.equal(getSessionPage(many, "BRANCH 1", "recent", 0).total, 16);
  assert.equal(getSessionPage(many, "id-60", "recent", 0).items[0]!.id, "id-60");
  assert.equal(getSessionPage(many, "not found", "title", 0).total, 0);
  assert.equal(sortedSessions(many, "prompts")[1]!.id, "id-104");
  assert.equal(sortedSessions([session("a", 0, "a", 0), { ...session("unknown", 0), userPromptCount: undefined }], "prompts")[0]!.id, "a");
  assert.equal(sortedSessions(many, "oldest")[1]!.id, "id-1");
  assert.equal(sortedSessions(many, "title")[1]!.id, "id-1");
  assert.deepEqual(sortedSessions([session("b", 0), session("a", 0)], "recent").map((s) => s.id), ["a", "b"]);
});

test("bulk clear excludes current and pinned sessions", () => {
  const sessions = [session("current", 0), session("pinned", 1), session("ordinary", 2)];
  assert.deepEqual(sessionsEligibleForClear(sessions, "current", new Set(["pinned"])).map((s) => s.id), ["ordinary"]);
});

test("pins persist atomically with private permissions and invalid contents are not overwritten", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-session-pin-"));
  const path = join(root, "preferences", "pins.json");
  try {
    assert.deepEqual([...readSessionPins(path)], []);
    assert.equal(toggleSessionPin(path, "some-id"), true);
    assert.equal(toggleSessionPin(path, "next-id"), true);
    assert.deepEqual([...readSessionPins(path)], ["some-id", "next-id"]);
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
    else assert.ok(statSync(path).mode & 0o200, "the pin file remains writable under Windows ACLs");
    assert.equal(toggleSessionPin(path, "some-id"), false);
    assert.deepEqual([...readSessionPins(path)], ["next-id"]);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), ["next-id"]);
    assert.deepEqual(readdirSync(join(root, "preferences")).filter((name) => name.endsWith(".tmp")), []);
    assert.throws(() => toggleSessionPin(path, "../../oops"), /Invalid session identifier/);
    writeFileSync(path, "{not-valid}");
    assert.throws(() => toggleSessionPin(path, "good-id"));
    assert.equal(readFileSync(path, "utf8"), "{not-valid}");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

type Choice = (title: string, choices: string[]) => string | undefined;
function scriptedUI(steps: Choice[]) {
  const viewed: Array<{ title: string; choices: string[] }> = [];
  const notices: string[] = [];
  const ui: SessionManagerUI = {
    async select(title, choices) {
      viewed.push({ title, choices });
      const choose = steps.shift();
      if (!choose) throw new Error(`Unexpected selector: ${title}`);
      const choice = choose(title, choices);
      if (choice !== undefined) assert.ok(choices.includes(choice), `missing option: ${choice}`);
      return choice;
    },
    async input() { return ""; },
    async confirm() { return true; },
    notify(message) { notices.push(message); },
  };
  return { ui, viewed, notices };
}

test("manager can navigate pages, pin and unpin, and switch using the selected session", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-session-modal-"));
  const path = join(root, "pins.json");
  let switched = "";
  let changes = 0;
  const all = Array.from({ length: 21 }, (_, index) => session(`id-${index}`, index * 1000));
  const { ui, viewed, notices } = scriptedUI([
    (_title, choices) => choices.find((item) => item === "Следующая страница →"),
    (_title, choices) => choices.find((item) => item === "Следующая страница →"),
    (_title, choices) => choices.find((item) => item.startsWith("1. ")),
    (_title, choices) => choices.find((item) => item === "Закрепить"),
    (_title, choices) => choices.find((item) => item.startsWith("1. ★")),
    (_title, choices) => choices.find((item) => item === "Открепить"),
    (_title, choices) => choices.find((item) => item.startsWith("1. ")),
    (_title, choices) => choices.find((item) => item === "Переключиться на сессию"),
  ]);
  try {
    await openSessionManager({
      ui,
      loadSessions: async () => all.map((item) => ({ ...item, pinned: readSessionPins(path).has(item.id) })),
      togglePin: (id) => toggleSessionPin(path, id),
      onPinChanged() { changes++; },
      onSwitch(item) { switched = item.id; },
      onRename() { throw new Error("unexpected rename"); },
      onDelete() { throw new Error("unexpected delete"); },
    });
    assert.equal(changes, 2);
    assert.ok(switched.length > 0);
    assert.deepEqual([...readSessionPins(path)], []);
    assert.match(viewed[2]!.title, /3\/3/);
    assert.match(viewed[4]!.choices[0]!, /★/);
    assert.match(viewed[4]!.choices[0]!, /вопрос/);
    assert.doesNotMatch(viewed[4]!.choices[0]!, /条消息/);
    assert.deepEqual(notices, ["Сессия закреплена.", "Закрепление снято."]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manager collapses children by default, expands groups, and offers child actions", async () => {
  const parent = session("parent", 10, "Parent");
  const child = { ...session("child", 20, "general-purpose#child"), parentId: "parent" };
  const grandchild = { ...session("grandchild", 30, "general-purpose#grandchild"), parentId: "child" };
  let switched = "";
  const { ui, viewed } = scriptedUI([
    (_title, choices) => { assert.ok(!choices.some(value => value.includes("general-purpose#child"))); return choices.find(value => value.includes("Подчинённые сессии")); },
    (_title, choices) => choices.find(value => value.includes("Подчинённые сессии") && value.includes("general-purpose#child")),
    (_title, choices) => choices.find(value => value.includes("general-purpose#grandchild")),
    (_title, choices) => choices.find(value => value === "Переключиться на сессию"),
  ]);
  await openSessionManager({
    ui, loadSessions: async () => [parent, child, grandchild], togglePin: () => false, onPinChanged() {},
    onSwitch(item) { switched = item.id; }, onRename() {}, onDelete() {},
  });
  assert.equal(switched, "grandchild");
  assert.ok(viewed[1]!.choices.some(value => value.includes("general-purpose#child")));
  assert.ok(viewed[2]!.choices.some(value => value.includes("general-purpose#grandchild")));
});

test("manager searches and sorts, then delegates session deletion to the central confirming command", async () => {
  const names = [session("a", 1, "alpha"), session("b", 2, "Beta"), session("c", 3, "gamma")];
  const { ui, viewed } = scriptedUI([
    (_title, choices) => choices.find((item) => item.startsWith("⌕ ")), // Search
    (_title, choices) => choices.find((item) => item.startsWith("↕ ")), // Sort
    (_title, choices) => choices.find((item) => item.includes("По названию")),
    (_title, choices) => choices.find((value) => value.startsWith("1. ")),
    (_title, choices) => choices.find((value) => value === "Переместить в корзину"),
  ]);
  let redundantConfirmation = false;
  let deleted = "";
  ui.input = async () => "BETA";
  ui.confirm = async () => { redundantConfirmation = true; return true; };
  await openSessionManager({
    ui, loadSessions: async () => names,
    togglePin: () => false, onPinChanged() {},
    onSwitch() {}, onRename() {},
    onDelete(item) { deleted = item.id; },
  });
  assert.equal(redundantConfirmation, false, "the central delete command must be the only confirmation point");
  assert.equal(deleted, "b");
  assert.match(viewed[3]!.title, /1\/3/);
  assert.ok(!viewed[3]!.choices.some((value) => value.includes("gamma")));
});

test("the pin entry limit rejects the write and keeps the file, while unpinning at the limit still works", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-session-pin-limit-"));
  const path = join(root, "pins.json");
  try {
    const ids = Array.from({ length: 2000 }, (_, index) => `id-${index}`);
    writeFileSync(path, JSON.stringify(ids));
    const before = readFileSync(path, "utf8");
    assert.throws(() => toggleSessionPin(path, "one-more"), /cannot exceed 2000 entries/);
    assert.equal(readFileSync(path, "utf8"), before, "a rejected write must not touch the file");
    assert.equal(toggleSessionPin(path, "id-1999"), false);
    assert.equal(readSessionPins(path).size, 1999);
    assert.equal(toggleSessionPin(path, "one-more"), true);
    assert.equal(readSessionPins(path).size, 2000);
    assert.deepEqual(readdirSync(root), ["pins.json"], "no lock or temporary file is left behind");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the serialized size limit rejects an over-long write while unpinning at the limit still works", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-session-pin-bytes-"));
  const path = join(root, "pins.json");
  // 977 ids of 128 valid characters serialize to exactly 127986 characters: inside 128000.
  const ids = Array.from({ length: 977 }, (_, index) => "a".repeat(124) + String(index).padStart(4, "0"));
  const fixture = JSON.stringify(ids);
  try {
    assert.ok(fixture.length <= 128_000, "the fixture sits inside the size limit");
    assert.ok(JSON.stringify([...ids, "b".repeat(128)]).length > 128_000, "one more id would exceed it");
    writeFileSync(path, fixture);
    assert.equal(readSessionPins(path).size, 977);
    const before = readFileSync(path, "utf8");
    assert.throws(() => toggleSessionPin(path, "b".repeat(128)), /cannot exceed 128000 characters/,
      "the serialized result, not only the entry count, is checked before writing");
    assert.equal(readFileSync(path, "utf8"), before, "a rejected write leaves the file untouched");
    assert.deepEqual(readdirSync(root), ["pins.json"], "a rejected write leaves no lock or temporary file");
    assert.equal(toggleSessionPin(path, ids[0]!), false, "unpinning stays possible at the limit");
    assert.equal(readFileSync(path, "utf8"), JSON.stringify(ids.slice(1)));
    assert.equal(toggleSessionPin(path, ids[0]!), true, "re-pinning the same id fits again");
    assert.equal(readSessionPins(path).size, 977);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable pins path releases the lock it took and writes nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-session-pin-readerror-"));
  const path = join(root, "pins.json");
  // A directory cannot be read as a file, so the read fails after the lock was taken.
  mkdirSync(path);
  try {
    assert.throws(() => toggleSessionPin(path, "some-id"), (error: NodeJS.ErrnoException) => error.code === "EISDIR");
    assert.equal(existsSync(`${path}.lock`), false, "the writer releases only the lock it created");
    assert.deepEqual(readdirSync(root), ["pins.json"], "no temporary file is left behind");
    assert.ok(statSync(path).isDirectory(), "the unreadable path is never overwritten");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a live pin lock makes the writer fail clearly instead of dropping an update", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-session-pin-lock-"));
  const path = join(root, "pins.json");
  const lock = `${path}.lock`;
  try {
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid }));
    assert.throws(() => toggleSessionPin(path, "some-id"), /locked by another process; retry shortly/);
    assert.deepEqual([...readSessionPins(path)], [], "a blocked writer writes nothing");
    // Even an aged lock is kept while its recorded owner is still running.
    const past = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, past, past);
    assert.throws(() => toggleSessionPin(path, "some-id"), /locked by another process/);
    assert.ok(existsSync(lock), "a lock with a live owner is never removed");
    assert.deepEqual(readdirSync(root).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("any existing pin lock blocks the write and is never removed by the writer", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-session-pin-stale-"));
  const path = join(root, "pins.json");
  const lock = `${path}.lock`;
  const past = new Date(Date.now() - 10 * 60_000);
  // Crash between mkdir and the owner file, a corrupt owner file, a dead pid, a live pid.
  const leftovers: ReadonlyArray<() => void> = [
    () => {},
    () => writeFileSync(join(lock, "owner.json"), "{broken"),
    () => writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 999_999 })),
    () => writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid })),
  ];
  writeFileSync(path, JSON.stringify(["kept"]));
  try {
    for (const prepare of leftovers) {
      rmSync(lock, { recursive: true, force: true });
      mkdirSync(lock, { mode: 0o700 });
      prepare();
      utimesSync(lock, past, past);
      assert.throws(() => toggleSessionPin(path, "some-id"), /locked by another process; retry shortly/,
        "an unverifiable lock is reported for a human to check, never reclaimed automatically");
      assert.ok(existsSync(lock), "another writer's lock directory is left untouched");
      assert.deepEqual([...readSessionPins(path)], ["kept"], "a blocked writer keeps the file as it was");
    }
    assert.deepEqual(readdirSync(root).sort(), ["pins.json", "pins.json.lock"], "no temporary file is left behind");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent writers in separate processes never lose a pin", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-session-pin-processes-"));
  const path = join(root, "pins.json");
  const moduleUrl = new URL("./manager.ts", import.meta.url).href;
  const script = `
const { toggleSessionPin } = await import(${JSON.stringify(moduleUrl)});
const [path, id] = process.argv.slice(-2);
for (let attempt = 0; attempt < 400; attempt++) {
  try { toggleSessionPin(path, id); process.exit(0); }
  catch (error) {
    if (!/locked by another process/.test(error.message)) { console.error(error.message); process.exit(2); }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
process.exit(1);
`;
  const run = (id: string) => new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script, path, id],
      { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) console.error(id, stderr);
      resolve(code);
    });
  });
  try {
    const ids = Array.from({ length: 6 }, (_, index) => `worker-${index}`);
    assert.deepEqual(await Promise.all(ids.map(run)), ids.map(() => 0));
    assert.deepEqual([...readSessionPins(path)].sort(), [...ids].sort(), "every concurrent pin survived");
    assert.deepEqual(readdirSync(root), ["pins.json"], "no lock or temporary file is left behind");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed initial load is reported with a retry entry and never looks like an empty list", async () => {
  const names = [session("a", 1, "alpha")];
  let attempts = 0;
  const { ui, viewed, notices } = scriptedUI([
    (_title, choices) => choices.find((item) => item === "↻ Обновить список"),
    (_title, choices) => choices.find((item) => item === "Закрыть"),
  ]);
  await openSessionManager({
    ui,
    loadSessions: async () => {
      attempts++;
      if (attempts === 1) throw new Error("directory unreadable");
      return names;
    },
    togglePin: () => false, onPinChanged() {}, onSwitch() {}, onRename() {}, onDelete() {},
  });
  assert.equal(attempts, 2);
  assert.match(notices[0]!, /Не удалось обновить список сессий: directory unreadable/);
  assert.match(viewed[0]!.title, /⚠ Ошибка загрузки: directory unreadable/);
  assert.equal(viewed[0]!.choices.filter((item) => /^\d+\. /.test(item)).length, 0);
  assert.deepEqual(viewed[1]!.choices.filter((item) => /^\d+\. /.test(item)), ["1. alpha · 1 вопрос"]);
  assert.doesNotMatch(viewed[1]!.title, /Ошибка загрузки/);
});

test("a failed reload inside the manager keeps the list, search, sort and page", async () => {
  const all = Array.from({ length: 21 }, (_, index) => session(`id-${index}`, index * 1000, `Branch ${index}`));
  const { ui, viewed, notices } = scriptedUI([
    (_title, choices) => choices.find((item) => item.startsWith("⌕ ")),
    (_title, choices) => choices.find((item) => item === "↻ Обновить список"),
    (_title, choices) => choices.find((item) => item === "Закрыть"),
  ]);
  ui.input = async () => "BRANCH";
  let loads = 0;
  await openSessionManager({
    ui,
    loadSessions: async () => {
      loads++;
      if (loads > 1) throw new Error("disk busy");
      return all;
    },
    togglePin: () => false, onPinChanged() {}, onSwitch() {}, onRename() {}, onDelete() {},
  });
  assert.equal(loads, 2);
  assert.match(notices[0]!, /Не удалось обновить список сессий: disk busy/);
  assert.match(viewed[2]!.title, /Поиск: BRANCH/);
  assert.match(viewed[2]!.title, /⚠ Ошибка загрузки: disk busy/);
  assert.equal(viewed[2]!.choices.filter((item) => /^\d+\. /.test(item)).length, 8, "retained rows stay clickable");
  assert.ok(viewed[2]!.choices.includes("Следующая страница →"), "paging survives a failed reload");
});

test("a failed reload keeps the real sort order and the page the user reached", async () => {
  const all = Array.from({ length: 21 }, (_, index) => session(`id-${index}`, index * 1000, `Branch ${index}`));
  let loads = 0;
  const { ui, viewed, notices } = scriptedUI([
    (_title, choices) => choices.find((item) => item.startsWith("↕ ")),
    (_title, choices) => choices.find((item) => item.includes("По названию")),
    (_title, choices) => choices.find((item) => item === "Следующая страница →"),
    (_title, choices) => choices.find((item) => item === "↻ Обновить список"),
    (_title, choices) => choices.find((item) => item === "Закрыть"),
  ]);
  await openSessionManager({
    ui,
    loadSessions: async () => {
      loads++;
      if (loads > 1) throw new Error("disk busy");
      return all;
    },
    togglePin: () => false, onPinChanged() {}, onSwitch() {}, onRename() {}, onDelete() {},
  });
  assert.equal(loads, 2);
  assert.match(notices[0]!, /Не удалось обновить список сессий: disk busy/);
  const rows = (index: number) => viewed[index]!.choices.filter((item) => /^\d+\. /.test(item));
  assert.deepEqual(rows(2).slice(0, 3).map((row) => row.replace(/^\d+\. /, "")),
    ["● Branch 0 · 1 вопрос", "Branch 1 · 1 вопрос", "Branch 10 · 1 вопрос"],
    "the list is title-sorted, not in the default recent order");
  assert.equal(viewed[2]!.choices.includes("↕ Сортировка: По названию"), true);
  assert.match(rows(3)[0]!, /Branch 16/, "the second page of the title sort is what the user reached");
  assert.deepEqual(rows(4), rows(3), "the rows the user reached survive the failed reload");
  assert.match(viewed[4]!.title, /2\/3/, "the page number survives the failed reload");
  assert.match(viewed[4]!.title, /⚠ Ошибка загрузки: disk busy/);
  assert.equal(viewed[4]!.choices.includes("↕ Сортировка: По названию"), true, "the non-default sort survives");
});

test("a pin saved before a failed reload reports success and stays visible", async () => {
  const names = [session("a", 1, "alpha"), session("b", 2, "beta")];
  let loads = 0;
  const { ui, viewed, notices } = scriptedUI([
    (_title, choices) => choices.find((item) => item.startsWith("1. ")),
    (_title, choices) => choices.find((item) => item === "Закрепить"),
    (_title, choices) => choices.find((item) => item === "Закрыть"),
  ]);
  await openSessionManager({
    ui,
    loadSessions: async () => {
      loads++;
      if (loads > 1) throw new Error("disk busy");
      return names;
    },
    togglePin: () => true, onPinChanged() {}, onSwitch() {}, onRename() {}, onDelete() {},
  });
  assert.deepEqual(notices, ["Не удалось обновить список сессий: disk busy", "Сессия закреплена."]);
  assert.match(viewed[2]!.choices[0]!, /^1\. ★ beta · 1 вопрос$/, "the saved pin is shown without a reload");
});

test("a failed pin write still reports an error and leaves the list untouched", async () => {
  const names = [session("a", 1, "alpha")];
  const { ui, viewed, notices } = scriptedUI([
    (_title, choices) => choices.find((item) => item.startsWith("1. ")),
    (_title, choices) => choices.find((item) => item === "Закрепить"),
    (_title, choices) => choices.find((item) => item === "Закрыть"),
  ]);
  await openSessionManager({
    ui,
    loadSessions: async () => names,
    togglePin: () => { throw new Error("locked by another process"); },
    onPinChanged() {}, onSwitch() {}, onRename() {}, onDelete() {},
  });
  assert.deepEqual(notices, ["Не удалось сохранить закрепление: locked by another process"]);
  assert.doesNotMatch(viewed[2]!.choices[0]!, /★/);
});


function runInjectedWriter(mode: string, path: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const moduleUrl = new URL("./manager.ts", import.meta.url).href;
  const script = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const [mode, path, moduleUrl] = process.argv.slice(-3);
const realOpen = fs.openSync;
const realWrite = fs.writeFileSync;
let foreign = null;
if (mode === "eexist") {
  fs.openSync = (target, flags, fileMode) => {
    if (flags === "wx") {
      realWrite(target, "foreign", { mode: 0o600 });
      foreign = target;
      const error = new Error("EEXIST: file already exists");
      error.code = "EEXIST";
      throw error;
    }
    return realOpen(target, flags, fileMode);
  };
} else if (mode === "partial-write") {
  fs.writeFileSync = (target, data, options) => {
    if (typeof target === "number") {
      realWrite(target, String(data).slice(0, 3));
      const error = new Error("EIO: partial write");
      error.code = "EIO";
      throw error;
    }
    return realWrite(target, data, options);
  };
} else if (mode === "rename") {
  fs.renameSync = () => {
    const error = new Error("EIO: rename failed");
    error.code = "EIO";
    throw error;
  };
}
syncBuiltinESMExports();
const { toggleSessionPin } = await import(moduleUrl);
try {
  toggleSessionPin(path, "some-id");
  console.log(JSON.stringify({ error: "", foreign }));
} catch (error) {
  console.log(JSON.stringify({ error: error.code ?? "", message: error.message, foreign }));
}
`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script, mode, path, moduleUrl],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("a temporary file already owned by another process is never deleted", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-session-pin-eexist-"));
  const path = join(root, "pins.json");
  try {
    writeFileSync(path, JSON.stringify(["kept"]));
    const result = await runInjectedWriter("eexist", path);
    assert.equal(result.code, 0, result.stderr);
    const out = JSON.parse(result.stdout.trim()) as { error: string; message: string; foreign: string | null };
    assert.equal(out.error, "EEXIST", out.message);
    assert.ok(out.foreign, "the injected writer claimed a temporary name first");
    assert.equal(readFileSync(out.foreign!, "utf8"), "foreign", "the other process's file is left alone");
    assert.equal(readFileSync(path, "utf8"), JSON.stringify(["kept"]), "the pins file stays untouched");
    assert.equal(readdirSync(root).filter((name) => name.endsWith(".tmp")).length, 1, "only the foreign file remains");
    assert.equal(existsSync(`${path}.lock`), false, "the lock is released");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a partial write or a failed rename cleans up its own temporary file and keeps the pins", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-session-pin-faults-"));
  const path = join(root, "pins.json");
  try {
    writeFileSync(path, JSON.stringify(["kept"]));
    for (const mode of ["partial-write", "rename"]) {
      const result = await runInjectedWriter(mode, path);
      assert.equal(result.code, 0, result.stderr);
      const out = JSON.parse(result.stdout.trim()) as { error: string };
      assert.equal(out.error, "EIO", mode + " surfaces the failure");
      assert.equal(readFileSync(path, "utf8"), JSON.stringify(["kept"]), mode + " keeps the pins file");
      assert.deepEqual(readdirSync(root), ["pins.json"], mode + " leaves no temporary file or lock behind");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a blank load failure message is still reported as a failure", async () => {
  const names = [session("a", 1, "alpha")];
  let attempts = 0;
  const { ui, viewed, notices } = scriptedUI([
    (_title, choices) => choices.find((item) => item === "↻ Обновить список"),
    (_title, choices) => choices.find((item) => item === "Закрыть"),
  ]);
  await openSessionManager({
    ui,
    loadSessions: async () => {
      attempts++;
      if (attempts === 1) throw new Error("");
      return names;
    },
    togglePin: () => false, onPinChanged() {}, onSwitch() {}, onRename() {}, onDelete() {},
  });
  assert.equal(attempts, 2);
  assert.match(notices[0]!, /Не удалось обновить список сессий: Unknown error/);
  assert.match(viewed[0]!.title, /⚠ Ошибка загрузки: Unknown error/);
  assert.equal(viewed[0]!.choices.filter((item) => /^\d+\. /.test(item)).length, 0,
    "an empty message never renders as an empty list");
});

test("a throwing pin-change callback never turns a saved pin into a save failure", async () => {
  const names = [session("a", 1, "alpha")];
  let loads = 0;
  const { ui, viewed, notices } = scriptedUI([
    (_title, choices) => choices.find((item) => item.startsWith("1. ")),
    (_title, choices) => choices.find((item) => item === "Закрепить"),
    (_title, choices) => choices.find((item) => item === "Закрыть"),
  ]);
  await openSessionManager({
    ui,
    loadSessions: async () => { loads++; return names; },
    togglePin: () => true,
    onPinChanged() { throw new Error("sidebar gone"); },
    onSwitch() {}, onRename() {}, onDelete() {},
  });
  assert.deepEqual(notices, ["Не удалось обновить боковую панель: sidebar gone", "Сессия закреплена."],
    "the callback failure is a refresh failure, the pin still reports success");
  assert.equal(loads, 2, "the manager keeps working and reloads after the callback failed");
  assert.equal(viewed.length, 3);
});
