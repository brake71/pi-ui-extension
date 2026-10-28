import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
  initTheme,
} from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { ThinkingTiming } from "./thinking-timing.ts";
import { transformThinkingText } from "./thinking.ts";

type ThinkingKind = "thinking_start" | "thinking_delta" | "thinking_end";

function thinkingEvent(
  kind: ThinkingKind,
  content: Array<{ type: string; thinking?: string; text?: string }>,
  index = 0,
): any {
  return { type: kind, contentIndex: index, partial: { role: "assistant", content } };
}

test("Thinking stopwatch uses the explicit provider start/end stream events, never the full response duration", () => {
  let now = 1000;
  const timing = new ThinkingTiming(() => now);
  const block = [{ type: "thinking", thinking: "Private reasoning" }];
  assert.equal(timing.duration("Private reasoning", false), undefined, "restored thinking has no timing");
  timing.observe(thinkingEvent("thinking_delta", block));
  assert.equal(timing.duration("Private reasoning", true), undefined, "a delta alone gives no start time");
  assert.deepEqual(timing.status("Private reasoning", true), { phase: "streaming" },
    "without a measured run a live message stays in progress");
  timing.observe(thinkingEvent("thinking_start", [{ type: "thinking", thinking: "" }]));
  now = 3100;
  timing.observe(thinkingEvent("thinking_delta", block));
  assert.deepEqual(timing.duration("Private reasoning", true), { ms: 2100, approximate: true });
  now = 6150;
  timing.observe(thinkingEvent("thinking_end", block));
  assert.deepEqual(timing.duration("Private reasoning", false), { ms: 5150, approximate: false });
  assert.deepEqual(timing.status("Private reasoning", true), {
    phase: "complete", duration: { ms: 5150, approximate: false },
  }, "an explicit thinking_end completes the run while the message still streams");
  initTheme("dark");
  assert.equal(stripTerminalSequences(transformThinkingText("Private reasoning", {
    messageType: "assistant-thinking", isStreaming: false, availableWidth: 40,
  }, "compact", (text, streaming) => timing.status(text, streaming))), "+ Размышление · 5.2s");
  timing.endMessage();
  assert.deepEqual(timing.duration("Private reasoning", false), { ms: 5150, approximate: false });
  timing.reset();
  assert.equal(timing.duration("Private reasoning", false), undefined, "session switching clears durations");
});

test("Thinking stopwatch handles separate blocks and rejects ambiguous identical content", () => {
  let now = 0;
  const timing = new ThinkingTiming(() => now);
  const one = [{ type: "thinking", thinking: "first" }];
  timing.observe(thinkingEvent("thinking_start", [{ type: "thinking", thinking: "" }]));
  now = 2000;
  timing.observe(thinkingEvent("thinking_end", one));
  const two = [...one, { type: "text" }, { type: "thinking", thinking: "second" }];
  now = 4000;
  timing.observe(thinkingEvent("thinking_start", [...one, { type: "text" }, { type: "thinking", thinking: "" }], 2));
  now = 9000;
  timing.observe(thinkingEvent("thinking_end", two, 2));
  assert.equal(timing.duration("first", false)?.ms, 2000);
  assert.equal(timing.duration("second", false)?.ms, 5000);

  timing.endMessage();
  now = 12000;
  timing.observe(thinkingEvent("thinking_start", [{ type: "thinking", thinking: "" }]));
  now = 14000;
  timing.observe(thinkingEvent("thinking_end", one));
  assert.equal(timing.duration("first", false), undefined, "identical content cannot be matched unambiguously");
  assert.equal(timing.duration("second", false)?.ms, 5000);
});

test("Thinking stopwatch handles adjacent thinking segments as a shared run", () => {
  let now = 0;
  const timing = new ThinkingTiming(() => now);
  const first = [{ type: "thinking", thinking: "part A" }];
  timing.observe(thinkingEvent("thinking_start", [{ type: "thinking", thinking: "" }]));
  now = 1500;
  timing.observe(thinkingEvent("thinking_end", first));
  now = 2000;
  timing.observe(thinkingEvent("thinking_start", [...first, { type: "thinking", thinking: "" }], 1));
  now = 4900;
  timing.observe(thinkingEvent("thinking_end", [...first, { type: "thinking", thinking: "part B" }], 1));
  assert.equal(timing.duration("part A\n\npart B", false)?.ms, 4900);
  timing.endMessage();
  now = 10000;
  timing.observe(thinkingEvent("thinking_end", first));
  assert.equal(timing.duration("part A", false)?.ms, 1500, "orphan end should not overwrite known timing");
});

test("a repeated identical Thinking round still completes at its own thinking_end", () => {
  let now = 0;
  const timing = new ThinkingTiming(() => now);
  const block = [{ type: "thinking", thinking: "identical" }];
  for (const round of [1, 2]) {
    // Observe the real event order: start, streaming delta, end, message end.
    timing.observe(thinkingEvent("thinking_start", [{ type: "thinking", thinking: "" }]));
    timing.observe(thinkingEvent("thinking_delta", block));
    assert.deepEqual(timing.status("identical", true), { phase: "streaming" },
      `round ${round} streams while its own run is live`);
    now += 1300;
    timing.observe(thinkingEvent("thinking_end", block));
    assert.equal(timing.status("identical", true).phase, "complete",
      `round ${round} settles on its own thinking_end`);
    timing.endMessage();
    now += 700;
  }
  assert.equal(timing.duration("identical", true), undefined,
    "identical content from two runs stays ambiguous, so no time is invented");
  assert.deepEqual(timing.status("identical", true), { phase: "complete" });
});

test("an empty Thinking run ends instead of spinning, and the next run still streams", () => {
  let now = 0;
  const timing = new ThinkingTiming(() => now);
  const empty = [{ type: "thinking", thinking: "" }];
  timing.observe(thinkingEvent("thinking_start", empty));
  assert.deepEqual(timing.status("", true), { phase: "streaming" }, "an empty live run keeps the indicator");

  now = 400;
  timing.observe(thinkingEvent("thinking_end", empty));
  assert.deepEqual(timing.status("", true), { phase: "complete" },
    "an empty run that ended must not keep spinning while the message streams");

  const text = [{ type: "thinking", thinking: "real reasoning" }];
  now = 900;
  timing.observe(thinkingEvent("thinking_start", empty));
  timing.observe(thinkingEvent("thinking_delta", text));
  assert.deepEqual(timing.status("real reasoning", true), { phase: "streaming" });
  now = 1900;
  timing.observe(thinkingEvent("thinking_end", text));
  assert.deepEqual(timing.status("real reasoning", true), {
    phase: "complete", duration: { ms: 1000, approximate: false },
  });
});

test("two Thinking runs in one streaming message keep independent phases", () => {
  let now = 0;
  const timing = new ThinkingTiming(() => now);
  const firstText = [{ type: "thinking", thinking: "first run" }];
  timing.observe(thinkingEvent("thinking_start", [{ type: "thinking", thinking: "" }]));
  now = 1200;
  timing.observe(thinkingEvent("thinking_end", firstText));
  const second = [...firstText, { type: "text", text: "answer" }, { type: "thinking", thinking: "" }];
  timing.observe(thinkingEvent("thinking_start", second, 2));
  now = 1800;
  timing.observe(thinkingEvent("thinking_delta",
    [...firstText, { type: "text", text: "answer" }, { type: "thinking", thinking: "second run" }], 2));
  assert.deepEqual(timing.status("first run", true), {
    phase: "complete", duration: { ms: 1200, approximate: false },
  }, "the finished run keeps its measured time while the message streams");
  assert.deepEqual(timing.status("second run", true), { phase: "streaming" },
    "the running sibling keeps its indicator");
});

test("a thinking_end without a matching start completes the run without inventing a time", () => {
  let now = 0;
  const timing = new ThinkingTiming(() => now);
  const orphan = [{ type: "thinking", thinking: "no start was observed" }];
  now = 900;
  timing.observe(thinkingEvent("thinking_end", orphan));
  assert.deepEqual(timing.status("no start was observed", true), { phase: "complete" },
    "the end event still ends the phase while the message streams");
  assert.equal(timing.duration("no start was observed", true), undefined, "no duration is invented");
});

test("Thinking phase never invents a duration for history, interruption, or ambiguity", () => {
  let now = 0;
  const timing = new ThinkingTiming(() => now);
  assert.deepEqual(timing.status("restored reasoning", false), { phase: "complete" },
    "restored history is complete without a measured time");

  const running = [{ type: "thinking", thinking: "interrupted" }];
  timing.observe(thinkingEvent("thinking_start", [{ type: "thinking", thinking: "" }]));
  now = 4000;
  timing.observe(thinkingEvent("thinking_delta", running));
  assert.deepEqual(timing.status("interrupted", true), { phase: "streaming" });
  assert.deepEqual(timing.status("interrupted", false), { phase: "complete" },
    "an interrupted run ends without a fabricated time");

  for (const text of ["twice", "twice"]) {
    timing.observe(thinkingEvent("thinking_start", [{ type: "thinking", thinking: "" }]));
    now += 1000;
    timing.observe(thinkingEvent("thinking_end", [{ type: "thinking", thinking: text }]));
  }
  assert.deepEqual(timing.status("twice", false), { phase: "complete" },
    "identical content cannot be matched to one run, so no time is shown");
});
