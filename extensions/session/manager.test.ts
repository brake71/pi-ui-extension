import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from "node:fs";
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
