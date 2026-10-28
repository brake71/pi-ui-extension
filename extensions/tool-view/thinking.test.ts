import assert from "node:assert/strict";
import test from "node:test";
import type { MarkdownTransformContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { initTheme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import {
  decorateThinkingBody,
  formatThinkingDuration,
  renderThinkingHeader,
  thinkingIndicatorFrame,
  thinkingRuns,
  ThinkingBlockView,
  transformThinkingText,
  type ThinkingColors,
  type ThinkingStatus,
} from "./thinking.ts";

/** Identity styling keeps these expectations about text, not ANSI codes. */
const PLAIN: ThinkingColors = {
  accent: (text) => text,
  indicator: (text) => text,
  label: (text) => text,
  bold: (text) => text,
  bar: (text) => text,
};

const THINKING: MarkdownTransformContext = { messageType: "assistant-thinking", isStreaming: false, availableWidth: 48 };
const LIVE: MarkdownTransformContext = { ...THINKING, isStreaming: true };
const LIVE_TITLE = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Думает$/;
const STREAMING: ThinkingStatus = { phase: "streaming" };
const measured = (ms: number): ThinkingStatus => ({ phase: "complete", duration: { ms, approximate: false } });

test("consecutive Thinking blocks form one run and non-thinking blocks split runs", () => {
  const runs = thinkingRuns([
    { type: "thinking", thinking: "  first  " },
    { type: "thinking", thinking: "second" },
    { type: "text", text: "answer" },
    { type: "thinking", thinking: "third" },
    { type: "thinking", thinking: "   " },
  ]);
  assert.deepEqual(runs, [
    { startIndex: 0, text: "first\n\nsecond" },
    { startIndex: 3, text: "third" },
  ]);
  assert.deepEqual(thinkingRuns(undefined), []);
  assert.deepEqual(thinkingRuns([{ type: "thinking", thinking: "" }]), []);
});

test("Thinking time keeps one decimal under a minute and switches to m:ss above it", () => {
  assert.equal(formatThinkingDuration({ ms: 1300, approximate: false }), "1.3s");
  assert.equal(formatThinkingDuration({ ms: 540, approximate: false }), "0.5s");
  assert.equal(formatThinkingDuration({ ms: 40, approximate: false }), "0.1s");
  assert.equal(formatThinkingDuration({ ms: 9990, approximate: false }), "10.0s");
  assert.equal(formatThinkingDuration({ ms: 59900, approximate: false }), "59.9s",
    "the last full sub-minute value stays a decimal second");
  assert.equal(formatThinkingDuration({ ms: 65000, approximate: false }), "1m05s");
  assert.equal(formatThinkingDuration({ ms: 60000, approximate: false }), "1m00s");
  assert.equal(formatThinkingDuration({ ms: Number.NaN, approximate: false }), "");
  assert.equal(formatThinkingDuration({ ms: -1, approximate: false }), "");
  assert.equal(formatThinkingDuration(undefined), "");
});

test("Thinking titles cover the live and completed states", () => {
  assert.equal(renderThinkingHeader({ status: STREAMING, colors: PLAIN, disclosure: true, now: 0 }), "⠋ Думает");
  assert.equal(renderThinkingHeader({ status: STREAMING, colors: PLAIN, disclosure: true, expanded: true, now: 0 }),
    "⠋ Думает", "an expanded live run keeps the indicator");
  assert.notEqual(thinkingIndicatorFrame(0), thinkingIndicatorFrame(150), "the indicator follows the clock");
  assert.equal(renderThinkingHeader({ status: measured(1300), colors: PLAIN, disclosure: true }), "+ Размышление · 1.3s");
  assert.equal(renderThinkingHeader({ status: measured(1300), colors: PLAIN, disclosure: true, expanded: true }),
    "− Размышление · 1.3s");
  assert.equal(renderThinkingHeader({ status: measured(1300), colors: PLAIN }), "Размышление · 1.3s",
    "Hidden has no disclosure glyph");
  assert.equal(renderThinkingHeader({ status: { phase: "complete" }, colors: PLAIN, disclosure: true }), "+ Размышление",
    "unmeasured history shows the label without a fabricated time");
  const narrow = renderThinkingHeader({ status: measured(1300), colors: PLAIN, disclosure: true, width: 6 });
  assert.ok(visibleWidth(narrow) <= 6);
});

test("every expanded body row carries the quote bar, paragraph breaks included", () => {
  const rows = decorateThinkingBody(["first row", "", "\u001b[31mthird row\u001b[0m", "   "], PLAIN);
  assert.deepEqual(rows, ["│ first row", "│", "│ \u001b[31mthird row\u001b[0m", "│"],
    "a paragraph break keeps its row height and still draws the bar");
  assert.deepEqual(decorateThinkingBody([""], PLAIN, "  "), ["  │"],
    "the bar follows the native output padding like every other row");
  const colored = decorateThinkingBody(["", "text"], { ...PLAIN, bar: (text) => `<${text}>` });
  assert.deepEqual(colored, ["<│>", "<│ >text"], "the bar never keeps trailing whitespace");
});

function fakeBody(rows: string[]): Component & { widths: number[] } {
  const widths: number[] = [];
  return {
    widths,
    render(width: number) {
      widths.push(width);
      return rows;
    },
    invalidate() {},
  };
}

function click(y: number, x = 0, extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
  return {
    type: "click", button: "left", x, y, screenX: x, screenY: y, width: 40, height: 5,
    shift: false, alt: false, ctrl: false, ...extra,
  };
}

test("Thinking block renders the title alone until it is expanded", () => {
  const body = fakeBody(["body one", "", "body two"]);
  let expanded = false;
  const toggles: number[] = [];
  const view = new ThinkingBlockView({
    header: () => "+ Размышление · 1.3s",
    body,
    colors: PLAIN,
    expanded: () => expanded,
    toggleable: () => true,
    onToggle: () => {
      toggles.push(1);
      expanded = !expanded;
    },
  });
  assert.deepEqual(view.render(40).map(stripTerminalSequences), ["+ Размышление · 1.3s"]);
  assert.deepEqual(body.widths, [], "a collapsed block never renders its body");

  assert.deepEqual(view.handleMouse(click(0, 3)), { handled: true, render: true });
  assert.equal(toggles.length, 1);
  const open = view.render(40).map(stripTerminalSequences);
  assert.deepEqual(open, ["+ Размышление · 1.3s", "│ body one", "│", "│ body two"],
    "the body starts on the row below the title and keeps paragraph height");
  assert.deepEqual(body.widths, [38], "the body is rendered two columns narrower for the bar");

  view.handleMouse(click(0, 3));
  assert.equal(toggles.length, 2, "the title toggles both ways");
});

test("only the title row toggles a Thinking block", () => {
  const body = fakeBody(["body one", "body two"]);
  let toggles = 0;
  const view = new ThinkingBlockView({
    header: () => "+ Размышление · 1.3s",
    body,
    colors: PLAIN,
    expanded: () => false,
    toggleable: () => true,
    onToggle: () => toggles++,
  });
  view.render(40);
  assert.equal(view.handleMouse(click(1, 3)), undefined, "a body click is not a toggle");
  assert.equal(view.handleMouse(click(2, 0)), undefined, "a paragraph bar row is not a toggle");
  assert.equal(view.handleMouse(click(0, 30)), undefined, "a click past the title text is not a toggle");
  assert.equal(view.handleMouse(click(0, 3, { type: "wheel", wheelDelta: 2 })), undefined, "wheel scrolls");
  assert.equal(view.handleMouse(click(0, 3, { button: "right" })), undefined, "other buttons are untouched");
  assert.equal(toggles, 0);
  const readOnly = new ThinkingBlockView({
    header: () => "+ Thought",
    body,
    colors: PLAIN,
    expanded: () => false,
    toggleable: () => false,
    onToggle: () => toggles++,
  });
  readOnly.render(40);
  assert.equal(readOnly.handleMouse(click(0, 1)), undefined);
  assert.equal(toggles, 0);
});

test("Thinking block keeps Pi's output padding for the title, the bar and its click target", () => {
  const body = fakeBody(["first body row", "", "second body row"]);
  let toggles = 0;
  const view = new ThinkingBlockView({
    header: () => "+ Размышление · 1.3s",
    outputPad: 3,
    body,
    colors: PLAIN,
    expanded: () => true,
    toggleable: () => true,
    onToggle: () => toggles++,
  });
  const rows = view.render(40).map(stripTerminalSequences);
  assert.equal(rows[0], "   + Размышление · 1.3s", "the title starts on Pi's output padding");
  assert.deepEqual(rows.slice(1), ["   │ first body row", "   │", "   │ second body row"],
    "the quote bar sits on the padding column and body text clears it");
  assert.deepEqual(body.widths, [40 - 3 * 2 - 2], "padding is reserved on both sides like native Markdown");

  assert.equal(view.handleMouse(click(0, 0)), undefined, "left padding is not a click target");
  assert.equal(view.handleMouse(click(0, 2)), undefined, "left padding is not a click target");
  assert.equal(view.handleMouse(click(0, 3))?.handled, true, "the title glyph column toggles");
  assert.equal(toggles, 1);
});

test("an expanded body ends with one blank row only when the layout asks for it", () => {
  const build = (trailingBlank?: () => boolean, expanded = true) => new ThinkingBlockView({
    header: () => "+ Размышление · 1.3s",
    body: fakeBody(["body one", "", "body two"]),
    colors: PLAIN,
    expanded: () => expanded,
    toggleable: () => true,
    onToggle: () => {},
    trailingBlank,
  });
  assert.deepEqual(build(() => true).render(40), ["+ Размышление · 1.3s", "│ body one", "│", "│ body two", ""]);
  assert.deepEqual(build().render(40), ["+ Размышление · 1.3s", "│ body one", "│", "│ body two"],
    "without a request the body keeps no trailing blank");
  assert.deepEqual(build(() => true, false).render(40), ["+ Размышление · 1.3s"],
    "a collapsed block never adds the trailing gap");
  assert.deepEqual(build(() => false).render(40), ["+ Размышление · 1.3s", "│ body one", "│", "│ body two"]);

  let asks = false;
  let toggles = 0;
  const view = new ThinkingBlockView({
    header: () => "+ Размышление · 1.3s",
    body: fakeBody(["body one"]),
    colors: PLAIN,
    expanded: () => true,
    toggleable: () => true,
    onToggle: () => toggles++,
    trailingBlank: () => asks,
  });
  assert.deepEqual(view.render(40).length, 2);
  asks = true;
  assert.deepEqual(view.render(40), ["+ Размышление · 1.3s", "│ body one", ""],
    "the trailing gap follows the live layout on every render");
  assert.equal(view.handleMouse(click(2, 0)), undefined, "the trailing blank row is not a click target");
  assert.equal(toggles, 0);
});

test("Thinking rows are clipped to the terminal at every narrow width", () => {
  const source = ["😀😀😀😀😀😀", "用户想知道 pi-ui-extension 的版本 🚀", "", "```ts", "const a = 1;", "```"];
  for (const pad of [0, 1, 3]) {
    const view = new ThinkingBlockView({
      header: () => "+ Размышление · 1.3s",
      outputPad: pad,
      body: fakeBody(source),
      colors: PLAIN,
      expanded: () => true,
      toggleable: () => true,
      onToggle: () => {},
      trailingBlank: () => true,
    });
    for (let width = 1; width <= 20; width++) {
      for (const line of view.render(width)) {
        assert.ok(visibleWidth(line) <= width, `pad ${pad} width ${width} overflowed: ${JSON.stringify(line)}`);
      }
    }
  }
});

test("the fallback transformer keeps Compact collapsed to the title in every state", () => {
  initTheme("dark");
  const source = ["old one", "old two", "recent one", "recent two"].join("\n");
  const status = () => measured(1300);
  const transform = (markdown: string, context: MarkdownTransformContext, mode: "normal" | "compact" | "hidden",
    getStatus?: () => ThinkingStatus) => stripTerminalSequences(transformThinkingText(markdown, context, mode, getStatus));
  assert.equal(transform(source, THINKING, "normal", status), source);
  assert.equal(transform(source, THINKING, "compact", status), "+ Размышление · 1.3s");
  assert.match(transform(source, LIVE, "compact", () => STREAMING), LIVE_TITLE);
  assert.equal(transform(source, THINKING, "hidden", status), "Размышление · 1.3s");
  assert.equal(transform(source, THINKING, "hidden"), "Размышление", "complete without a measured time");
  assert.match(transform(source, LIVE, "hidden"), LIVE_TITLE);
  assert.equal(transform(source, LIVE, "compact", () => STREAMING).includes("old one"), false,
    "Compact never shows body rows");
  assert.equal(transform(source, { ...THINKING, messageType: "assistant" }, "compact", status), source);
  assert.equal(transform(source, { ...THINKING, messageType: "user" }, "hidden", status), source);
  for (const width of [1, 3, 6, 9, 14, 22, 48]) {
    for (const mode of ["compact", "hidden"] as const) {
      const line = transformThinkingText("思考".repeat(40), { ...THINKING, availableWidth: width }, mode, status);
      assert.ok(visibleWidth(line) <= width, `${mode} overflow at width ${width}`);
    }
  }
});
