import assert from "node:assert/strict";
import test from "node:test";
import { createActivityTracker, createStreamingTokenSampler } from "./activity.ts";

test("streaming token sampling throttles expensive estimates without delaying first output", () => {
  let now = 1_000;
  let estimates = 0;
  const samples: Array<[number, number]> = [];
  const sampler = createStreamingTokenSampler(
    (message: { tokens: number }) => { estimates++; return message.tokens; },
    (tokens, observedAt) => samples.push([tokens, observedAt]),
    150,
    () => now,
  );

  sampler.observe({ tokens: 0 });
  sampler.observe({ tokens: 1 });
  assert.deepEqual(samples, [[1, 1_000]], "first real output is sampled immediately");
  now = 1_050;
  sampler.observe({ tokens: 2 });
  assert.equal(estimates, 2, "throttled updates do not run the estimator");
  now = 1_150;
  sampler.observe({ tokens: 1 });
  assert.equal(samples.length, 1, "unchanged token counts do not trigger refreshes");
  now = 1_200;
  sampler.observe({ tokens: 2 });
  assert.deepEqual(samples, [[1, 1_000]], "unchanged estimates also advance the throttle window");
  for (let i = 0; i < 1000; i++) sampler.observe({ tokens: 1 });
  assert.equal(estimates, 3, "a burst of unchanged events must not repeatedly estimate");
  now = 1_300;
  sampler.observe({ tokens: 2 });
  assert.deepEqual(samples, [[1, 1_000], [2, 1_300]]);

  now = 1_350;
  sampler.reset();
  sampler.observe({ tokens: 1 });
  assert.deepEqual(samples.at(-1), [1, 1_350], "new provider request is sampled immediately");
});

test("aborted run keeps completed tools but marks interrupted tools as cancelled", () => {
  const tracker = createActivityTracker(process.cwd(), () => {});
  tracker.startRun(1_000);
  tracker.startTurn(0, 1_000);
  tracker.startTool({ toolCallId: "finished", toolName: "read", args: { path: "readme" } }, 1_100);
  tracker.finishTool({ toolCallId: "finished", isError: false }, 1_200);
  tracker.startTool({ toolCallId: "cancelled", toolName: "bash", args: { command: "sleep 5" } }, 1_300);
  tracker.settle(1_500, true);

  const snapshot = tracker.getSnapshot();
  assert.equal(snapshot.phase, "settled");
  assert.equal(snapshot.aborted, true);
  assert.equal(snapshot.completedCount, 1);
  assert.equal(snapshot.failedCount, 0);
  assert.equal(snapshot.cancelledCount, 1);
  assert.equal(snapshot.activeTools.length, 0);
  assert.deepEqual(snapshot.turns[0]?.tools.map((tool) => tool.status), ["done", "cancelled"]);
  tracker.settle(1_600, false);
  assert.equal(tracker.getSnapshot().aborted, true, "duplicate settle must not rewrite the run outcome");


  tracker.startRun(2_000);
  assert.equal(tracker.getSnapshot().aborted, undefined);
  assert.equal(tracker.getSnapshot().cancelledCount, 0);
});

test("a non-aborted run still identifies orphaned tools as failed", () => {
  const tracker = createActivityTracker(process.cwd(), () => {});
  tracker.startRun(1_000);
  tracker.startTurn(0, 1_000);
  tracker.startTool({ toolCallId: "orphan", toolName: "bash", args: {} }, 1_010);
  tracker.settle(1_200, false);
  assert.equal(tracker.getSnapshot().aborted, undefined);
  assert.equal(tracker.getSnapshot().failedCount, 1);
  assert.equal(tracker.getSnapshot().cancelledCount, 0);
  assert.equal(tracker.getSnapshot().recentTools[0]?.status, "failed");
});
