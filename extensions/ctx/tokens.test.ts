import assert from "node:assert/strict";
import test from "node:test";
import { createTokenUsageTracker } from "./tokens.ts";

test("restores provider totals from assistant messages in the active branch", () => {
  const tracker = createTokenUsageTracker();
  tracker.reset([
    { type: "message", message: { role: "assistant", usage: { input: 10, output: 3, cacheRead: 4, cacheWrite: 2 } } },
    { type: "message", message: { role: "user", usage: { input: 100, output: 100 } } },
    { type: "custom", message: { role: "assistant", usage: { input: 100 } } },
    { type: "message", message: { role: "assistant", usage: { input: 5, output: 7, cacheRead: 1 } } },
  ]);
  assert.deepEqual(tracker.getTotals(), { input: 15, output: 10, cache: 7 });
});

test("adds live provider usage and ignores invalid values", () => {
  const tracker = createTokenUsageTracker();
  tracker.reset([{ type: "message", message: { role: "assistant", usage: { input: 8 } } }]);
  tracker.add({ input: 2, output: 4, cacheRead: 3, cacheWrite: 1 });
  tracker.add({ input: -1, output: Number.NaN, cacheRead: "5", cacheWrite: Infinity });
  tracker.add(undefined);
  assert.deepEqual(tracker.getTotals(), { input: 10, output: 4, cache: 4 });
});
