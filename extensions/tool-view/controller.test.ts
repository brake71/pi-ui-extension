import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, Text, stripTerminalSequences } from "@earendil-works/pi-tui";
import {
  getMarkdownTheme,
  initTheme,
} from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { installToolViewController } from "./controller.ts";

type Handler = (event: any, ctx: any) => unknown;

test("applies a mode change from another context wrapper in the active session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tool-view-controller-"));
  const modeFile = join(directory, "mode.json");
  const handlers = new Map<string, Handler[]>();
  const statuses: string[] = [];
  const notices: string[] = [];
  const expandedValues: boolean[] = [];
  const sessionManager = { getSessionId: () => "session-1" };
  let toolsExpanded = false;

  const pi = {
    registerTool() { throw new Error("Tool View must not register tools"); },
    registerToolRenderer() {},
    registerMarkdownTransformer() {},
    getSettings: () => ({}),
    registerCommand() {},
    registerShortcut() {},
    getCommands: () => [],
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as any;
  const ui = {
    setStatus(_id: string, value: string | undefined) { if (value) statuses.push(value); },
    notify(message: string) { notices.push(message); },
    getToolsExpanded: () => toolsExpanded,
    setToolsExpanded(value: boolean) {
      toolsExpanded = value;
      expandedValues.push(value);
    },
    setHiddenThinkingLabel() {},
  };

  try {
    const controller = await installToolViewController(pi, { modeFile });
    const sessionCtx = { mode: "tui", ui, sessionManager } as any;
    for (const handler of handlers.get("session_start") ?? []) handler({}, sessionCtx);

    // Pi may create another ExtensionContext wrapper for a panel/command while
    // retaining the same active SessionManager identity.
    const panelCtx = { mode: "tui", ui, sessionManager } as any;
    await controller.setMode("normal", panelCtx);

    assert.equal(controller.getMode(), "normal");
    assert.deepEqual(JSON.parse(await readFile(modeFile, "utf8")), { mode: "normal" });
    assert.equal(statuses.at(-1), "Отображение инструментов: Normal");
    assert.equal(notices.at(-1), "Отображение инструментов: Normal");
    assert.deepEqual(expandedValues.slice(-2), [true, false]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the single Tool View mode controls Thinking, persists once, and refreshes historical messages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "unified-tool-view-"));
  const modeFile = join(directory, "mode.json");
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, any>();
  const notices: string[] = [];
  const expanded: boolean[] = [];
  let transformer: any;
  let refreshed = 0;
  let toolsExpanded = false;
  let registeredToolDefinitions = 0;
  const pi = {
    registerTool() { registeredToolDefinitions++; },
    registerToolRenderer() {},
    registerMarkdownTransformer(callback: any) { transformer = callback; },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    registerShortcut() {},
    getSettings: () => ({ hideThinkingBlock: false }),
    getCommands: () => [],
    on(name: string, cb: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), cb]); },
  } as any;
  const ctx = {
    mode: "tui",
    sessionManager: { getSessionId: () => "current-session" },
    ui: {
      setStatus() {},
      notify(message: string) { notices.push(message); },
      getToolsExpanded: () => toolsExpanded,
      setToolsExpanded(value: boolean) { expanded.push(value); toolsExpanded = value; },
      setHiddenThinkingLabel() { refreshed++; },
    },
  } as any;
  const context = { messageType: "assistant-thinking", isStreaming: false, availableWidth: 40 };
  initTheme("dark");
  const transform = (markdown: string) => stripTerminalSequences(transformer(markdown, context));
  try {
    const controller = await installToolViewController(pi, { modeFile });
    assert.equal(controller.getMode(), "compact");
    assert.equal(typeof transformer, "function");
    assert.equal(transform("private thought"), "+ Размышление", "unmeasured Thinking collapses to the title");
    for (const callback of handlers.get("session_start") ?? []) callback({}, ctx);
    assert.equal(handlers.has("message_update"), true, "registered stream timing observer");
    const partial = { role: "assistant", content: [{ type: "thinking", thinking: "private thought" }] };
    for (const type of ["thinking_start", "thinking_end"]) {
      for (const callback of handlers.get("message_update") ?? []) {
        callback({ assistantMessageEvent: { type, contentIndex: 0, partial } }, ctx);
      }
    }
    assert.match(transform("private thought"), /^\+ Размышление · \d\.\ds$/, "thinking_end supplies the measured time");
    for (const callback of handlers.get("message_end") ?? []) callback({ message: partial }, ctx);
    assert.match(transform("private thought"), /^\+ Размышление · \d\.\ds$/, "the measured time survives message_end");

    await controller.setMode("normal", ctx);
    assert.equal(transformer("private thought", context), "private thought");
    await commands.get("tool-view").handler("hidden", ctx);
    assert.match(transform("private thought"), /^Размышление · \d\.\ds$/, "Hidden has no disclosure glyph");
    assert.equal(controller.getMode(), "hidden");
    assert.deepEqual(JSON.parse(await readFile(modeFile, "utf8")), { mode: "hidden" });
    assert.equal(refreshed, 2, "one public refresh per mode change, including historical Thinking");
    assert.deepEqual(expanded, [true, false, true, false], "tool transcript refresh still occurs");
    assert.equal(commands.has("thinking-view"), false, "no separate Thinking command");
    assert.equal(registeredToolDefinitions, 0);
    assert.match(notices.join("\n"), /Отображение инструментов: Hidden/);

    const restarted = await installToolViewController(pi, { modeFile });
    assert.equal(restarted.getMode(), "hidden", "existing mode file persists Thinking and Tools together");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unified Tool View removes the earlier click adapter when reloaded", async () => {
  const prototype = AssistantMessageComponent.prototype;
  const original = prototype.updateContent;
  const symbol = Symbol.for("pi-ui-extension:thinking-click-adapter");
  const guardSymbol = Symbol.for("pi-ui-extension:compact-thinking-adapter");
  const marker = prototype as unknown as Record<symbol, any>;
  const previousGuard = marker[guardSymbol];
  const patched: typeof original = function (this: AssistantMessageComponent, ...args) {
    return original.apply(this, args);
  };
  const directory = await mkdtemp(join(tmpdir(), "view-reload-"));
  prototype.updateContent = patched;
  marker[symbol] = { original, patched };
  try {
    const pi = {
      registerToolRenderer() {}, registerMarkdownTransformer() {},
      registerCommand() {}, registerShortcut() {}, getCommands: () => [], on() {},
    } as any;
    await installToolViewController(pi, { modeFile: join(directory, "mode.json") });
    assert.notEqual(prototype.updateContent, patched, "the old clickable-detail adapter is gone");
    assert.equal(marker[symbol], undefined);
    assert.ok(marker[guardSymbol], "the Compact Thinking adapter replaces the old click adapter");
    assert.equal(marker[Symbol.for("pi-ui-extension:thinking-click-guard")], undefined,
      "the earlier click guard generation is no longer installed");
  } finally {
    prototype.updateContent = original;
    delete marker[symbol];
    if (previousGuard) marker[guardSymbol] = previousGuard;
    else delete marker[guardSymbol];
    await rm(directory, { recursive: true, force: true });
  }
});

test("unified Tool View warns if Pi hides Thinking natively without breaking tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tool-thinking-fallback-"));
  const handlers = new Map<string, Handler[]>();
  const notices: string[] = [];
  const pi = {
    registerToolRenderer() {},
    registerMarkdownTransformer() {},
    registerCommand() {},
    registerShortcut() {},
    getSettings: () => ({ hideThinkingBlock: true }),
    getCommands: () => [],
    on(name: string, cb: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), cb]); },
  } as any;
  const ctx = {
    mode: "tui",
    sessionManager: { getSessionId: () => "current-session" },
    ui: {
      setStatus() {},
      notify(message: string) { notices.push(message); },
      getToolsExpanded: () => false,
      setToolsExpanded() {},
      setHiddenThinkingLabel() {},
    },
  } as any;
  try {
    const controller = await installToolViewController(pi, { modeFile: join(directory, "mode.json") });
    for (const callback of handlers.get("session_start") ?? []) callback({}, ctx);
    await controller.setMode("normal", ctx);
    assert.equal(controller.getMode(), "normal");
    assert.match(notices.join("\n"), /hideThinkingBlock: false/);
    assert.doesNotMatch(notices.join("\n"), /не поддерживает изменение отображения рассуждений/,
      "the supported Pi SDK always supplies the transformer");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


const THINKING_ADAPTER = Symbol.for("pi-ui-extension:compact-thinking-adapter");
const PREVIOUS_ADAPTER = Symbol.for("pi-ui-extension:thinking-click-guard");
const SPACING_GUARD = Symbol.for("pi-ui-extension:compact-spacing-guard");

test("Compact Thinking supplies the tool gap only for a tool whose leading blank it trims", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "thinking-tool-gap-"));
  const messages = AssistantMessageComponent.prototype as any;
  const tools = ToolExecutionComponent.prototype as any;
  // Deterministic start: unwind whatever an earlier test in this file installed.
  for (const key of [THINKING_ADAPTER, PREVIOUS_ADAPTER]) {
    if (typeof messages[key]?.original === "function") messages.updateContent = messages[key].original;
    delete messages[key];
  }
  if (tools[SPACING_GUARD]) {
    tools.render = tools[SPACING_GUARD].originalRender;
    tools.handleMouse = tools[SPACING_GUARD].originalMouse;
    delete tools[SPACING_GUARD];
  }
  const clean = { updateContent: messages.updateContent, render: tools.render, mouse: tools.handleMouse };
  t.after(async () => {
    messages.updateContent = clean.updateContent;
    delete messages[THINKING_ADAPTER];
    delete messages[PREVIOUS_ADAPTER];
    tools.render = clean.render;
    tools.handleMouse = clean.mouse;
    delete tools[SPACING_GUARD];
    await rm(directory, { recursive: true, force: true });
  });

  initTheme("dark");
  let transformer: any;
  let renderers: any;
  const pi = {
    registerToolRenderer(callback: any) { renderers = callback; },
    registerMarkdownTransformer(callback: any) { transformer = callback; },
    registerCommand() {},
    registerShortcut() {},
    getSettings: () => ({ hideThinkingBlock: false }),
    getCommands: () => [],
    on() {},
  } as any;
  const install = async () => {
    await installToolViewController(pi, { modeFile: join(directory, "mode.json") });
  };
  const ownTool = (toolName: string) => {
    const component = new ToolExecutionComponent(
      toolName, "1", {}, {}, renderers(toolName, () => undefined),
      { requestRender() {} } as any, ".",
    );
    component.updateResult({ content: [{ type: "text", text: "ok" }], isError: false, durationMs: 30 }, false);
    return component;
  };
  const thirdPartyTool = () => {
    const component = new ToolExecutionComponent(
      "mcp__server__search", "1", {}, {},
      { renderShell: "self", renderCall: () => new Text("›  mcp__server__search", 0, 0), renderResult: () => new Text("⎿  1 line", 0, 0) } as any,
      { requestRender() {} } as any, ".",
    );
    component.updateResult({ content: [{ type: "text", text: "ok" }], isError: false, durationMs: 30 }, false);
    return component;
  };
  // Expand the Thinking block of a message followed by the given tool, then render both.
  const expand = (toolName: string, tool: ToolExecutionComponent): [string[], ToolExecutionComponent] => {
    const message = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), "Thinking...", 1, [transformer]);
    message.updateContent({
      role: "assistant", stopReason: "stop",
      content: [{ type: "thinking", thinking: "Body text." }, { type: "toolCall", id: "1", name: toolName, arguments: {} }],
    } as any, false);
    const title = message.render(64).map(stripTerminalSequences).findIndex((line) => line.includes("Размышление"));
    assert.ok(title >= 0, "the Compact title renders");
    message.handleMouse?.({
      type: "click", button: "left", x: 1, y: title, screenX: 1, screenY: title,
      width: 64, height: 64, shift: false, alt: false, ctrl: false,
    } as any);
    const chat = new Container();
    chat.addChild(message);
    chat.addChild(tool);
    return [chat.render(64).map(stripTerminalSequences).map((line) => line.trimEnd()), tool];
  };
  /** Blank rows between the last body row and the tool's first row. */
  const gapAfterBody = ([rows]: [string[], ToolExecutionComponent]) => {
    let lastBody = rows.length - 1;
    while (lastBody >= 0 && !rows[lastBody]!.includes("│")) lastBody--;
    assert.ok(lastBody >= 0, "the expanded body rendered");
    let blank = 0;
    while (rows[lastBody + 1 + blank] === "") blank++;
    return blank;
  };

  await install();
  // A tool this extension renders: the guard trims its leading blank, so the
  // open body supplies exactly one gap.
  const own = expand("bash", ownTool("bash"));
  assert.notEqual(own[1].render(64)[0], "", "the guard trims its own tool's leading blank");
  assert.equal(gapAfterBody(own), 1, "the body supplies exactly one gap before its own tool");
  assert.match(own[0].at(-1)!, /1 строка/, "the compact tool still renders its result");
  // A third-party tool keeps Pi's own leading blank; the body must not add one.
  const foreign = expand("mcp__server__search", thirdPartyTool());
  assert.equal(gapAfterBody(foreign), 1, "no second gap before a third-party tool");
  assert.deepEqual(foreign[0].slice(-2), ["›  mcp__server__search", "⎿  1 line"]);

  // The guard refuses an unfamiliar Pi layout: the predicate stays false.
  tools.render = function () { return []; };
  await install();
  tools.render = clean.render;
  tools.handleMouse = clean.mouse;
  delete tools[SPACING_GUARD];
  const untrimmed = expand("bash", ownTool("bash"));
  assert.equal(untrimmed[1].render(64)[0], "", "the tool's native leading blank returns");
  assert.equal(gapAfterBody(untrimmed), 1, "the tool's own blank row is the only gap");
});
