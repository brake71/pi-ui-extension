import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSidebarLayoutStore,
  readStoredSidebarWidth,
  writeStoredSidebarWidth,
} from "./layout-store.ts";

const MIN = 18;
const MAX = 72;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-ui-layout-"));
}

test("a written width is readable and leaves no temporary file behind", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "nested", "ui-layout.json");
    writeStoredSidebarWidth(path, 30);
    assert.equal(readStoredSidebarWidth(path, MIN, MAX), 30);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { version: 1, sidebarWidth: 30 });
    assert.deepEqual(readdirSync(join(dir, "nested")), ["ui-layout.json"]);
    if (process.platform !== "win32") {
      assert.equal(statSync(path).mode & 0o777, 0o600, "layout file stays user-private");
    } // Windows reports synthesized POSIX mode bits; file ACLs are not checked here.
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("missing, corrupt and out-of-range layout values fall back instead of throwing", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "ui-layout.json");
    assert.equal(readStoredSidebarWidth(path, MIN, MAX), undefined, "missing file");
    for (const text of [
      "", "{", "not json", "null", "[]", "12", '"30"', "{}",
      '{"sidebarWidth":"30"}', '{"sidebarWidth":30.5}', '{"sidebarWidth":null}',
      '{"sidebarWidth":17}', '{"sidebarWidth":73}', '{"sidebarWidth":-5}',
      '{"sidebarWidth":1e9}', `{"sidebarWidth":30,"pad":"${"x".repeat(5000)}"}`,
    ]) {
      writeFileSync(path, text);
      assert.equal(readStoredSidebarWidth(path, MIN, MAX), undefined, `rejected: ${text.slice(0, 40)}`);
    }
    writeFileSync(path, '{"sidebarWidth":30}');
    assert.equal(readStoredSidebarWidth(path, MIN, MAX), 30);
    assert.equal(readStoredSidebarWidth(dir, MIN, MAX), undefined, "a directory path is not a width");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("store writes the last saved width once and skips redundant rewrites", async () => {
  const dir = tempDir();
  try {
    const path = join(dir, "ui-layout.json");
    const store = createSidebarLayoutStore({ path, min: MIN, max: MAX, saveDelayMs: 20 });
    assert.equal(store.readSidebarWidth(), undefined);
    store.saveSidebarWidth(24);
    store.saveSidebarWidth(30);
    store.saveSidebarWidth(35);
    await delay(80);
    assert.equal(readStoredSidebarWidth(path, MIN, MAX), 35, "debounce keeps the last width");
    const first = statSync(path);

    store.saveSidebarWidth(35);
    store.dispose();
    const second = statSync(path);
    assert.equal(second.ino, first.ino, "an unchanged width is not rewritten");
    assert.equal(second.mtimeMs, first.mtimeMs);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("dispose flushes a pending width without waiting for the debounce", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "ui-layout.json");
    const store = createSidebarLayoutStore({ path, min: MIN, max: MAX, saveDelayMs: 60_000 });
    store.saveSidebarWidth(41);
    store.dispose();
    assert.equal(readStoredSidebarWidth(path, MIN, MAX), 41);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("out-of-range widths are never saved and unwritable paths never throw", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "ui-layout.json");
    const store = createSidebarLayoutStore({ path, min: MIN, max: MAX, saveDelayMs: 1 });
    for (const width of [17, 73, 30.5, Number.NaN, Number.POSITIVE_INFINITY]) store.saveSidebarWidth(width);
    store.dispose();
    assert.equal(readStoredSidebarWidth(path, MIN, MAX), undefined, "invalid widths are not written");

    // A regular file where a directory is expected makes mkdirSync and the
    // temporary write fail; the sidebar must keep working with memory state.
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "");
    const blockedStore = createSidebarLayoutStore({ path: join(blocked, "ui-layout.json"), min: MIN, max: MAX });
    blockedStore.saveSidebarWidth(30);
    assert.doesNotThrow(() => blockedStore.dispose());
    assert.doesNotThrow(() => blockedStore.saveSidebarWidth(40), '"disposed" store ignores later saves');

    const afterDispose = createSidebarLayoutStore({ path, min: MIN, max: MAX });
    afterDispose.dispose();
    assert.equal(readStoredSidebarWidth(path, MIN, MAX), undefined, "dispose without a pending width writes nothing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
