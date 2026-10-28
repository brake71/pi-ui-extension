import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { AssistantMessageComponent, ToolExecutionComponent, VERSION, type MarkdownTransformer } from "@earendil-works/pi-coding-agent";
import { Container, Text, stripTerminalSequences, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import {
  getMarkdownTheme,
  initTheme,
} from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { installCompactSpacingGuard, markCompactSpacingRenderer } from "./compact-spacing.ts";
import { installCompactThinkingAdapter } from "./thinking-adapter.ts";
import { ThinkingTiming } from "./thinking-timing.ts";
import { transformThinkingText, type ThinkingStatus } from "./thinking.ts";
import type { ToolViewMode } from "./types.ts";

const WIDTH = 64;
const ADAPTER_KEY = Symbol.for("pi-ui-extension:compact-thinking-adapter");
const PREVIOUS_KEY = Symbol.for("pi-ui-extension:thinking-click-guard");
const INDICATOR = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
/** Pi's message output padding, then the Thinking quote bar; a paragraph row keeps the bar alone. */
const BAR_ROW = /^ *│ ?/;
const stripBar = (line: string) => line.replace(BAR_ROW, "");
type StatusFn = (text: string, streaming: boolean) => ThinkingStatus;

function mouse(y: number, x: number, extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
  return {
    type: "click", button: "left", x, y, screenX: x, screenY: y, width: WIDTH, height: 64,
    shift: false, alt: false, ctrl: false, ...extra,
  };
}

function lines(component: AssistantMessageComponent, width = WIDTH): string[] {
  return component.render(width).map(stripTerminalSequences);
}

function plain(component: AssistantMessageComponent, width = WIDTH): string {
  return lines(component, width).join("\n");
}

function lineIndex(component: AssistantMessageComponent, needle: RegExp | string, last = false): number {
  const matches = lines(component)
    .map((line, index) => (typeof needle === "string" ? line.includes(needle) : needle.test(line)) ? index : -1)
    .filter((index) => index >= 0);
  const index = last ? matches.at(-1) : matches[0];
  assert.ok(index !== undefined, `no rendered line matches ${needle}`);
  return index;
}

function lastIndex(rows: string[], needle: RegExp | string): number {
  for (let index = rows.length - 1; index >= 0; index--) {
    const line = rows[index]!;
    if (typeof needle === "string" ? line.includes(needle) : needle.test(line)) return index;
  }
  return -1;
}

function clickLine(
  component: AssistantMessageComponent,
  needle: RegExp | string,
  extra: Partial<TuiMouseEvent> = {},
  x = 1,
  last = false,
): ReturnType<NonNullable<AssistantMessageComponent["handleMouse"]>> {
  const y = lineIndex(component, needle, last);
  return component.handleMouse?.(mouse(y, x, extra));
}

/** Tool names this extension renders itself, so the spacing guard trims their gap. */
const OWNED_TOOLS = new Set(["codemode", "bash", "read"]);
const needsToolGap = (toolName: string) => OWNED_TOOLS.has(toolName);

function harness(t: TestContext, providedStatus?: StatusFn, toolGap?: (toolName: string) => boolean) {
  initTheme("dark");
  const prototype = AssistantMessageComponent.prototype as unknown as Record<symbol | "updateContent", any>;
  const initial = prototype.updateContent;
  const state: { mode: ToolViewMode; status?: ThinkingStatus } = { mode: "compact" };
  const status: StatusFn = providedStatus ??
    ((_text, streaming) => state.status ?? { phase: streaming ? "streaming" : "complete" });
  const transformer: MarkdownTransformer = (text, context) => transformThinkingText(text, context, state.mode, status);
  const installed = installCompactThinkingAdapter(
    () => state.mode, transformer, { status, needsToolGap: toolGap },
  );
  t.after(() => {
    prototype.updateContent = initial;
    delete prototype[ADAPTER_KEY];
    delete prototype[PREVIOUS_KEY];
  });
  const make = (
    content: unknown[],
    streaming: boolean,
    options: { hideThinking?: boolean; transformers?: MarkdownTransformer[]; outputPad?: number } = {},
  ) => {
    const component = new AssistantMessageComponent(
      undefined,
      options.hideThinking ?? false,
      getMarkdownTheme(),
      "Thinking...",
      options.outputPad ?? 1,
      options.transformers ?? [transformer],
    );
    component.updateContent({ role: "assistant", content, stopReason: "stop" } as any, streaming);
    return component;
  };
  const setMode = (mode: ToolViewMode) => {
    state.mode = mode;
  };
  return { state, status, transformer, installed, make, setMode, prototype, initial };
}

test("Compact Thinking streams a live title, expands to the full body, and settles on Размышление", (t) => {
  assert.equal(typeof AssistantMessageComponent.prototype.setHiddenThinkingLabel, "function",
    `Pi ${VERSION} must keep the Thinking component shape this adapter decorates`);
  const { state, make, installed } = harness(t);
  assert.equal(installed, true);
  const first = "The user asks about the plugin version and where it is published.";
  const second = "Then it checks the package manifest and the release notes.";
  const component = make([{ type: "thinking", thinking: `${first}\n\n${second}` }], true);

  const live = lines(component);
  assert.equal(live.length, 2, "a spacer plus the single title row");
  assert.match(live.join("\n"), INDICATOR);
  assert.match(live[1]!, /Думает$/);
  assert.doesNotMatch(live.join("\n"), /plugin version/, "a collapsed live run hides its body");

  const toggled = clickLine(component, /Думает$/);
  assert.equal(toggled?.handled, true);
  const expanded = lines(component);
  assert.match(expanded[1]!, /Думает$/, "the live title keeps its indicator when expanded");
  const body = expanded.slice(2);
  assert.ok(body.length > 1);
  assert.match(body[0]!, BAR_ROW, "the body starts on the row right below the title");
  assert.ok(body.every((line) => BAR_ROW.test(line)),
    "every body row carries the grey bar, paragraph breaks included");
  assert.ok(body.every((line) => visibleWidth(line) <= WIDTH));
  assert.deepEqual(
    body.filter((line) => line.trim()).map(stripBar).join(" ").replace(/\s+/g, " ").trim(),
    `${first} ${second}`,
    "the whole Thinking text is wrapped at terminal width",
  );

  // Streaming growth keeps the expansion and the earlier text.
  component.updateContent({
    role: "assistant", stopReason: "stop",
    content: [{ type: "thinking", thinking: `${first}\n\n${second}\n\nA third paragraph arrives.` }],
  } as any, true);
  const grown = lines(component);
  assert.ok(grown.slice(2).every((line) => BAR_ROW.test(line)),
    "a growing body stays one continuous bar column");
  assert.match(grown.join(" "), /plugin version/);
  assert.match(grown.join(" "), /A third paragraph arrives\./);

  // thinking_end settles the title while the message is still streaming.
  state.status = { phase: "complete", duration: { ms: 1300, approximate: false } };
  component.updateContent({
    role: "assistant", stopReason: "stop",
    content: [{ type: "thinking", thinking: `${first}\n\n${second}` }],
  } as any, true);
  const settled = lines(component);
  assert.equal(settled[1]!.trim(), "− Размышление · 1.3s", "an expanded completed run shows the minus disclosure");
  assert.match(settled.join(" "), /plugin version/, "completion keeps the block expanded");

  clickLine(component, /Размышление/);
  const collapsed = lines(component);
  assert.equal(collapsed.length, 2);
  assert.equal(collapsed[1]!.trim(), "+ Размышление · 1.3s");
  assert.doesNotMatch(collapsed.join("\n"), /plugin version/);
});

test("only the Thinking title toggles it; body clicks, wheel, and other buttons do not", (t) => {
  const { make } = harness(t);
  const component = make([
    { type: "thinking", thinking: "Private reasoning about the next step." },
    { type: "text", text: "Public answer" },
  ], false);
  clickLine(component, /Размышление/);
  assert.match(plain(component), /Private reasoning/);

  const bodyLine = lineIndex(component, /Private reasoning/);
  component.handleMouse?.(mouse(bodyLine, 2));
  assert.match(plain(component), /Private reasoning/, "a body click must not collapse the block");

  clickLine(component, /Размышление/, { type: "wheel", button: "none", wheelDelta: 3 });
  assert.match(plain(component), /Private reasoning/, "the wheel must not toggle");

  clickLine(component, /Размышление/, { button: "right" });
  assert.match(plain(component), /Private reasoning/, "other buttons must not toggle");

  clickLine(component, /Public answer/);
  assert.match(plain(component), /Private reasoning/, "the surrounding message text must not toggle");

  clickLine(component, /Размышление/);
  assert.doesNotMatch(plain(component), /Private reasoning/);
});

test("Hidden keeps the title and measured time without ever leaking the body", (t) => {
  const { state, make, setMode } = harness(t);
  state.status = { phase: "complete", duration: { ms: 1300, approximate: false } };
  setMode("hidden");
  const component = make([
    { type: "thinking", thinking: "PRIVATE_THINKING_BODY" },
    { type: "text", text: "Public answer" },
  ], false);
  assert.equal(lines(component)[1]!.trim(), "Размышление · 1.3s", "Hidden has no disclosure glyph");
  assert.doesNotMatch(plain(component), /PRIVATE_THINKING_BODY/);
  clickLine(component, /Размышление/);
  assert.doesNotMatch(plain(component), /PRIVATE_THINKING_BODY|Thinking\.\.\./,
    "a Hidden click must not reveal the body or Pi's fallback label");
  assert.equal(lines(component)[1]!.trim(), "Размышление · 1.3s");
});

test("Normal keeps Pi's full Thinking body and native click behavior", (t) => {
  const { make, setMode } = harness(t);
  setMode("normal");
  const component = make([{ type: "thinking", thinking: "NORMAL_MODE_BODY_TEXT" }], false);
  assert.match(plain(component), /NORMAL_MODE_BODY_TEXT/);
  clickLine(component, /NORMAL_MODE_BODY_TEXT/);
  assert.match(plain(component), /Thinking\.\.\./, "Pi's native click still collapses the block");
  assert.doesNotMatch(plain(component), /NORMAL_MODE_BODY_TEXT/);
  clickLine(component, /Thinking\.\.\./);
  assert.match(plain(component), /NORMAL_MODE_BODY_TEXT/, "Pi's native click still restores the block");
});

test("Pi's own hideThinkingBlock keeps its native read-only label", (t) => {
  const { make } = harness(t);
  const component = make([{ type: "thinking", thinking: "HIDDEN_BY_PI_BODY" }], false, { hideThinking: true });
  assert.match(plain(component), /Thinking\.\.\./);
  assert.doesNotMatch(plain(component), /HIDDEN_BY_PI_BODY|Размышление/);
  clickLine(component, /Thinking\.\.\./);
  assert.doesNotMatch(plain(component), /HIDDEN_BY_PI_BODY/, "the native override must not expose raw Thinking");
});

test("expansion is independent per message instance and per Thinking run", (t) => {
  const { make } = harness(t);
  const content = [
    { type: "thinking", thinking: "FIRST_RUN_BODY" },
    { type: "text", text: "Middle answer" },
    { type: "thinking", thinking: "SECOND_RUN_BODY" },
  ];
  const component = make(content, false);
  clickLine(component, /Размышление/);
  assert.match(plain(component), /FIRST_RUN_BODY/);
  assert.doesNotMatch(plain(component), /SECOND_RUN_BODY/, "a sibling run stays collapsed");
  clickLine(component, /Размышление/, {}, 1, true);
  const both = plain(component);
  assert.match(both, /FIRST_RUN_BODY/);
  assert.match(both, /SECOND_RUN_BODY/, "the second run toggles on its own title");

  const sibling = make(content, false);
  assert.doesNotMatch(plain(sibling), /FIRST_RUN_BODY|SECOND_RUN_BODY/, "another instance starts collapsed");
  assert.equal(lines(component).filter((line) => line.includes("− Размышление")).length, 2);
});

test("resize and invalidate keep the expansion of an open Thinking block", (t) => {
  const { make } = harness(t);
  const component = make([{ type: "thinking", thinking: "RESIZE_BODY_TEXT that is long enough to wrap at a narrow width" }], false);
  clickLine(component, /Размышление/);
  const wide = lines(component, 72);
  const narrow = lines(component, 24);
  assert.ok(narrow.every((line) => visibleWidth(line) <= 24));
  assert.ok(narrow.filter((line) => BAR_ROW.test(line)).length > wide.filter((line) => BAR_ROW.test(line)).length);
  component.invalidate();
  assert.match(plain(component, 72), /RESIZE_BODY_TEXT/, "invalidate rebuilds children without collapsing");
  assert.equal(lines(component, 72).filter((line) => line.includes("− Размышление")).length, 1);
});

test("reinstalling the adapter never stacks and other components keep native clicks", (t) => {
  const { make, prototype, initial, transformer } = harness(t);
  assert.equal(installCompactThinkingAdapter(() => "compact", transformer, { status: () => ({ phase: "complete" }) }), true);
  assert.equal(prototype[ADAPTER_KEY].original, initial, "reinstall must not stack prototype wrappers");

  const component = make([{ type: "thinking", thinking: "OWNED_BODY" }], false);
  clickLine(component, /Размышление/);
  assert.match(plain(component), /OWNED_BODY/);

  const foreign = make(
    [{ type: "thinking", thinking: "FOREIGN_BODY" }],
    false,
    { transformers: [(text, context) => transformThinkingText(text, context, "compact", () => ({ phase: "complete" }))] },
  );
  assert.match(plain(foreign), /\+ Размышление/, "the fallback title still applies");
  clickLine(foreign, /Размышление/);
  assert.match(plain(foreign), /Thinking\.\.\./, "a different transformer keeps Pi's native click");

  const bare = make([{ type: "thinking", thinking: "NATIVE_BODY" }], false, { transformers: [] });
  clickLine(bare, /NATIVE_BODY/);
  assert.match(plain(bare), /Thinking\.\.\./);
});

test("decorating never mutates the assistant message", (t) => {
  const { state, make } = harness(t);
  const content = [
    { type: "thinking", thinking: "immutable body" },
    { type: "text", text: "reply" },
  ];
  const snapshot = structuredClone(content);
  const component = make(content, true);
  clickLine(component, /Думает$/);
  state.status = { phase: "complete", duration: { ms: 2400, approximate: false } };
  component.updateContent({ role: "assistant", stopReason: "stop", content } as any, false);
  clickLine(component, /Размышление/);
  assert.deepEqual(content, snapshot);
});

test("narrow terminals wrap CJK and emoji Thinking text inside one bar", (t) => {
  const { make } = harness(t);
  const body = "用户想知道 pi-ui-extension 的最新版本，并核对 package.json 的版本号 🚀 与发布说明。".repeat(2);
  const component = make([{ type: "thinking", thinking: body }], false);
  clickLine(component, /Размышление/);
  const narrow = lines(component, 20);
  assert.ok(narrow.every((line) => visibleWidth(line) <= 20), "no row may overflow the terminal");
  const rows = narrow.filter((line) => BAR_ROW.test(line));
  assert.ok(rows.length > 1);
  assert.match(rows.join(""), /package\.json/);
  assert.match(rows.join(""), /🚀/);
});

test("thinking_end settles the title before the assistant message ends", (t) => {
  let now = 1000;
  const timing = new ThinkingTiming(() => now);
  const start = [{ type: "thinking", thinking: "" }];
  const done = [{ type: "thinking", thinking: "finished reasoning" }];
  timing.observe({ type: "thinking_start", contentIndex: 0, partial: { role: "assistant", content: start } } as any);
  now = 2300;
  timing.observe({ type: "thinking_end", contentIndex: 0, partial: { role: "assistant", content: done } } as any);
  const { make } = harness(t, (text, streaming) => timing.status(text, streaming));
  const component = make(done, true);
  assert.equal(lines(component)[1]!.trim(), "+ Размышление · 1.3s",
    "the run is complete while the assistant message still streams");
});

test("a Thinking run that has only emitted thinking_start still shows a live title", (t) => {
  const { make, state } = harness(t);
  const empty = [{ type: "thinking", thinking: "" }];
  const component = make(empty, true);
  const pending = lines(component);
  assert.equal(pending.length, 1, "Pi skips the empty block, so the adapter adds the live title");
  assert.match(pending[0]!, INDICATOR);
  assert.match(pending[0]!, /Думает$/);

  state.status = { phase: "complete" };
  component.updateContent({
    role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "now it has text" }],
  } as any, false);
  assert.equal(lines(component).filter((line) => /Thinking|Размышление/.test(line)).length, 1,
    "the placeholder is replaced by the real run");

  const idle = make(empty, false);
  assert.doesNotMatch(plain(idle), /Thinking|Размышление/, "an idle empty block shows nothing");
});

test("Pi's hide switch and adjacent runs leave exactly one Thinking title", (t) => {
  const { make } = harness(t);
  const empty = [{ type: "thinking", thinking: "" }];

  const hidden = make(empty, true, { hideThinking: true });
  assert.equal(lines(hidden).length, 0, "hideThinkingBlock must not gain a placeholder title");

  const adjacent = make([{ type: "thinking", thinking: "first" }, { type: "thinking", thinking: "" }], true);
  assert.equal(
    lines(adjacent).filter((line) => /Thinking|Размышление|Думает/.test(line)).length,
    1,
    "an empty block inside a rendered run must not add a second title",
  );

  const onlyEmpty = make([{ type: "thinking", thinking: "" }, { type: "text", text: "answer" }, ...empty], true);
  assert.equal(lines(onlyEmpty).filter((line) => /Thinking|Размышление|Думает/.test(line)).length, 1,
    "a trailing empty run shows one live title next to the answer");

  const movedOn = make([{ type: "thinking", thinking: "" }, { type: "text", text: "answer" }], true);
  assert.doesNotMatch(plain(movedOn), /Thinking|Размышление/, "a run that already moved on to text leaves no title");
});

test("an empty Thinking title opens on click and stays open when text arrives", (t) => {
  const { make } = harness(t, () => ({ phase: "streaming" }));
  const component = make([{ type: "thinking", thinking: "" }], true);
  assert.equal(lines(component).length, 1);
  assert.match(lines(component)[0]!, INDICATOR);

  const toggled = component.handleMouse?.(mouse(0, 1));
  assert.equal(toggled?.handled, true, "the live placeholder title is clickable");
  assert.equal(toggled?.render, true);

  component.updateContent({
    role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "first delta arrives" }],
  } as any, true);
  const grown = lines(component);
  assert.match(grown[1]!, INDICATOR, "the same run keeps the live title");
  assert.match(grown.join("\n"), /first delta arrives/, "the opened run reveals the body as soon as it has text");
});

test("an ended empty run shows no spinner", (t) => {
  const { make } = harness(t, () => ({ phase: "complete" }));
  const component = make([{ type: "thinking", thinking: "" }], true);
  assert.equal(lines(component).length, 0, "a completed empty run leaves nothing behind");
});

test("Thinking titles, the quote bar and the reply share Pi's output padding", (t) => {
  const { make } = harness(t);
  for (const pad of [0, 1, 3]) {
    const component = make([
      { type: "thinking", thinking: "PADDED_BODY_TEXT" },
      { type: "text", text: "Public reply" },
    ], false, { outputPad: pad });
    const rows = lines(component);
    const title = rows.find((line) => line.includes("Размышление"))!;
    const reply = rows.find((line) => line.includes("Public reply"))!;
    assert.equal(title.indexOf("+"), pad, `the title starts at Pi's padding (${pad})`);
    assert.equal(reply.indexOf("Public reply"), pad, "the reply starts at the same column");

    const titleRow = rows.indexOf(title);
    for (let x = 0; x < pad; x++) component.handleMouse?.(mouse(titleRow, x));
    assert.doesNotMatch(plain(component), /PADDED_BODY_TEXT/, "left padding is not a click target");
    component.handleMouse?.(mouse(titleRow, visibleWidth(title)));
    assert.doesNotMatch(plain(component), /PADDED_BODY_TEXT/, "trailing whitespace is not a click target");

    assert.equal(component.handleMouse?.(mouse(titleRow, pad))?.handled, true, "the title itself toggles");
    const open = lines(component);
    const bodyRow = open.find((line) => line.includes("PADDED_BODY_TEXT"))!;
    assert.ok(bodyRow.startsWith(`${" ".repeat(pad)}│ `), "the grey bar sits on the padding column");
    assert.equal(bodyRow.indexOf("PADDED_BODY_TEXT"), pad + 2, "body text clears the padding and the bar");
    assert.ok(open.every((line) => visibleWidth(line) <= WIDTH), "padding never pushes a row past the terminal");
  }
});

/** This extension's own self-rendered tool, exactly as Compact renders it. */
function ownedTool(name: string, id: string): ToolExecutionComponent {
  const native = {
    renderShell: "self" as const,
    renderCall: () => new Text(`›  ${name}`, 0, 0),
    renderResult: () => new Text("⎿  1 line", 0, 0),
  };
  const component = new ToolExecutionComponent(
    name, id, {}, {}, markCompactSpacingRenderer(native) as any, { requestRender() {} } as any, ".",
  );
  component.updateResult({ content: [{ type: "text", text: "ok" }], isError: false, durationMs: 30 }, false);
  return component;
}

/** A third-party or MCP tool: Pi's own layout, never marked by this extension. */
function thirdPartyTool(name: string, id: string): ToolExecutionComponent {
  const component = new ToolExecutionComponent(
    name, id, {}, {},
    { renderShell: "self", renderCall: () => new Text(`›  ${name}`, 0, 0), renderResult: () => new Text("⎿  1 line", 0, 0) } as any,
    { requestRender() {} } as any, ".",
  );
  component.updateResult({ content: [{ type: "text", text: "ok" }], isError: false, durationMs: 30 }, false);
  return component;
}

function installSpacingGuard(t: TestContext): void {
  const prototype = ToolExecutionComponent.prototype as typeof ToolExecutionComponent.prototype & Record<symbol, unknown>;
  const key = Symbol.for("pi-ui-extension:compact-spacing-guard");
  const originalRender = prototype.render;
  const originalMouse = prototype.handleMouse;
  t.after(() => {
    prototype.render = originalRender;
    prototype.handleMouse = originalMouse;
    delete prototype[key];
  });
  assert.equal(installCompactSpacingGuard(() => "compact"), true);
}

test("an expanded Thinking body is followed by exactly one blank row before the first tool", (t) => {
  const { make } = harness(t, undefined, needsToolGap);
  installSpacingGuard(t);
  const component = make([
    { type: "thinking", thinking: "First paragraph.\n\nSecond paragraph." },
    { type: "toolCall", id: "1", name: "codemode", arguments: {} },
  ], false);
  const chat = new Container();
  chat.addChild(component);
  chat.addChild(ownedTool("codemode", "1"));
  chat.addChild(ownedTool("bash", "2"));

  const collapsed = chat.render(WIDTH).map(stripTerminalSequences);
  assert.match(collapsed[1]!, /\+ Размышление/);
  assert.match(collapsed[2]!, /›  codemode/,
    "a collapsed block keeps Pi's compact tool spacing with no extra row");

  clickLine(component, /Размышление/);
  const rows = chat.render(WIDTH).map(stripTerminalSequences);
  const title = rows.findIndex((line) => line.includes("− Размышление"));
  assert.ok(title >= 0, "the block expands");
  const lastBody = lastIndex(rows, BAR_ROW);
  assert.ok(lastBody > title);
  assert.ok(rows.slice(title + 1, lastBody + 1).every((line) => BAR_ROW.test(line)),
    "title down to the last body row is one unbroken bar column");
  assert.equal(rows[lastBody + 1], "", "exactly one blank row follows the body");
  assert.equal(rows.findIndex((line) => line.includes("›  codemode")), lastBody + 2,
    "the first tool title starts right after that single blank row");
  assert.deepEqual(rows.slice(lastBody + 2).map((line) => line.trimEnd()),
    ["›  codemode", "⎿  1 line", "›  bash", "⎿  1 line"],
    "consecutive tools keep their own spacing; only the first one follows the Thinking gap");
  assert.ok(rows.every((line) => visibleWidth(line) <= WIDTH));
});

test("a third-party tool keeps its native leading blank row and gains no second gap", (t) => {
  const { make } = harness(t, undefined, needsToolGap);
  installSpacingGuard(t);
  const component = make([
    { type: "thinking", thinking: "Body text." },
    { type: "toolCall", id: "1", name: "mcp__server__search", arguments: {} },
    { type: "toolCall", id: "2", name: "codemode", arguments: {} },
  ], false);
  const chat = new Container();
  chat.addChild(component);
  chat.addChild(thirdPartyTool("mcp__server__search", "1"));
  chat.addChild(ownedTool("codemode", "2"));

  clickLine(component, /Размышление/);
  const rows = chat.render(WIDTH).map(stripTerminalSequences);
  const lastBody = lastIndex(rows, BAR_ROW);
  assert.ok(lastBody > 0);
  assert.equal(rows[lastBody + 1], "", "the body adds no row of its own");
  assert.deepEqual(rows.slice(lastBody + 1).map((line) => line.trimEnd()), [
    "", "›  mcp__server__search", "⎿  1 line", "›  codemode", "⎿  1 line",
  ], "the third-party tool's own leading blank row is the only gap, and the next own tool stays compact");
});

test("without a trimmed tool gap the Thinking body adds no row over the tool's own", (t) => {
  // No needsToolGap option and no spacing guard: the adapter must stay passive.
  const { make } = harness(t);
  const component = make([
    { type: "thinking", thinking: "Body text." },
    { type: "toolCall", id: "1", name: "codemode", arguments: {} },
  ], false);
  const chat = new Container();
  chat.addChild(component);
  const tool = ownedTool("codemode", "1");
  assert.equal(tool.render(WIDTH)[0], "", "Pi's native leading blank row is still there");
  chat.addChild(tool);

  clickLine(component, /Размышление/);
  const rows = chat.render(WIDTH).map(stripTerminalSequences);
  const lastBody = lastIndex(rows, BAR_ROW);
  assert.equal(rows[lastBody + 1], "", "the tool's own blank row is the gap");
  assert.deepEqual(rows.slice(lastBody + 1).map((line) => line.trimEnd()),
    ["", "›  codemode", "⎿  1 line"], "no second row is added");
});

test("the Thinking gap never doubles Pi's own spacing before text or an error", (t) => {
  const { make } = harness(t);
  installSpacingGuard(t);
  const component = make([
    { type: "thinking", thinking: "Body text." },
    { type: "text", text: "Public answer" },
    { type: "thinking", thinking: "Second body." },
  ], false);
  clickLine(component, /Размышление/);
  clickLine(component, /Размышление/, {}, 1, true);
  const rows = lines(component);
  const answer = rows.findIndex((line) => line.includes("Public answer"));
  assert.equal(rows[answer - 1], "", "Pi's native spacer is the only gap before the reply");
  assert.match(rows[answer - 2]!, BAR_ROW);
  const secondTitle = lastIndex(rows, "− Размышление");
  assert.match(rows[secondTitle - 1]!, /Public answer/,
    "Pi's own layout between the reply and the next block is untouched");
  assert.match(rows.at(-1)!, BAR_ROW, "a body with nothing after it adds no trailing gap");

  const failed = make([{ type: "thinking", thinking: "Body text." }], false);
  clickLine(failed, /Размышление/);
  failed.updateContent({
    role: "assistant", stopReason: "error", errorMessage: "boom",
    content: [{ type: "thinking", thinking: "Body text." }],
  } as any, false);
  const errorRows = lines(failed);
  const errorBody = lastIndex(errorRows, BAR_ROW);
  const errorLine = errorRows.findIndex((line) => line.includes("Error: boom"));
  assert.equal(errorLine, errorBody + 2, "the native error spacer is not doubled");
  assert.equal(errorRows[errorBody + 1], "");

  const truncated = make([{ type: "thinking", thinking: "Body text." }], false);
  clickLine(truncated, /Размышление/);
  truncated.updateContent({
    role: "assistant", stopReason: "length",
    content: [{ type: "thinking", thinking: "Body text." }],
  } as any, false);
  const lengthRows = lines(truncated);
  const lengthBody = lastIndex(lengthRows, BAR_ROW);
  assert.equal(lengthRows[lengthBody + 1], "", "Pi's own row before the truncation notice is the only gap");
  assert.match(lengthRows[lengthBody + 2]!, /truncated before completion/);
});

test("widths 1 to 20 clip CJK, emoji, paragraphs and code without overflow", (t) => {
  const { make } = harness(t);
  const body = [
    "第一段：用户想知道 🚀 pi-ui-extension 的最新版本。",
    "",
    "- 列表项 😀",
    "- 第二项 CJK 文本",
    "",
    "```ts",
    "const version = \"1.8.3\";",
    "```",
    "",
    "结尾段落。",
  ].join("\n");
  for (const pad of [0, 1, 3]) {
    const component = make([{ type: "thinking", thinking: body }], false, { outputPad: pad });
    component.handleMouse?.(mouse(lineIndex(component, /Размышление/), Math.min(pad, 3)));
    for (let width = 1; width <= 20; width++) {
      for (const line of lines(component, width)) {
        assert.ok(visibleWidth(line) <= width, `pad ${pad} width ${width} overflowed: ${JSON.stringify(line)}`);
      }
    }
  }
});

test("a foreign patch on top of our marker makes installation fail closed", (t) => {
  const { prototype, initial, transformer } = harness(t);
  const ourOld = function (this: unknown, ...args: unknown[]) {
    return (initial as (...inner: unknown[]) => unknown).apply(this, args);
  };
  const foreign = function (this: unknown, ...args: unknown[]) {
    return ourOld.apply(this, args);
  };
  prototype[ADAPTER_KEY] = { original: initial, patched: ourOld };
  prototype.updateContent = foreign;
  const install = () => installCompactThinkingAdapter(() => "compact", transformer, {
    status: () => ({ phase: "complete" }),
  });
  assert.equal(install(), false, "an unknown patch on top must never be wrapped again");
  assert.equal(prototype.updateContent, foreign, "the other patch stays untouched");
  assert.deepEqual(prototype[ADAPTER_KEY], { original: initial, patched: ourOld }, "the stale marker is left alone");

  prototype.updateContent = ourOld;
  assert.equal(install(), true, "once our patch is on top again the install succeeds");
  assert.equal(prototype[ADAPTER_KEY].original, initial, "it unwrapped down to Pi's native method");
});

test("installation is gated by Pi's component shape, not by an exact version list", (t) => {
  const { prototype, initial, transformer } = harness(t);
  const install = () => installCompactThinkingAdapter(() => "compact", transformer, {
    status: () => ({ phase: "complete" }),
  });
  const restore = () => {
    prototype.updateContent = initial;
    delete prototype[ADAPTER_KEY];
    delete prototype[PREVIOUS_KEY];
  };

  restore();
  assert.equal(install(), true,
    `Pi ${VERSION} keeps the Thinking layout this adapter decorates, so any Pi version may install`);

  restore();
  const host = prototype as unknown as Record<string, unknown>;
  const label = host.setHiddenThinkingLabel;
  host.setHiddenThinkingLabel = undefined;
  try {
    assert.equal(install(), false, "a host without setHiddenThinkingLabel fails closed");
  } finally {
    host.setHiddenThinkingLabel = label;
  }

  restore();
  const update = host.updateContent;
  host.updateContent = undefined;
  try {
    assert.equal(install(), false, "a host without updateContent fails closed");
  } finally {
    host.updateContent = update;
  }
});

test("an older click-guard generation is unwrapped on upgrade", (t) => {
  const { prototype, initial, transformer } = harness(t);
  delete prototype[ADAPTER_KEY];
  const oldGuard = function (this: unknown, ...args: unknown[]) {
    return (initial as (...inner: unknown[]) => unknown).apply(this, args);
  };
  prototype[PREVIOUS_KEY] = { original: initial, patched: oldGuard };
  prototype.updateContent = oldGuard;
  assert.equal(installCompactThinkingAdapter(() => "compact", transformer, {
    status: () => ({ phase: "complete" }),
  }), true);
  assert.equal(prototype[PREVIOUS_KEY], undefined, "the old marker is cleared");
  assert.equal(prototype[ADAPTER_KEY].original, initial, "Pi's native method is the base again");
});
