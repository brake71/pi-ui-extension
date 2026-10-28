import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth, type TuiInputListener } from "@earendil-works/pi-tui";
import { ToolViewPanel } from "./panel.ts";

const theme = { fg: (_color: string, text: string) => text } as any;

function makePanel(width: number, onOpenResources?: (id: "agents" | "skills" | "extensions" | "mcp") => void) {
  let listener: TuiInputListener | undefined;
  const tui = {
    addInputListener(next: TuiInputListener) { listener = next; return () => {}; },
    requestRender() {},
    currentLayout: undefined as any,
  };
  const panel = new ToolViewPanel(theme, {
    tui: tui as any,
    getDesiredWidth: () => width,
    getMode: () => "compact",
    getUsage: () => ({ counts: [] }),
    onSelect() {},
    onOpenResources,
  });
  return { panel, tui, getListener: () => listener };
}

test("shows four full-width vertical resource links only when enabled", () => {
  const hidden = makePanel(40);
  assert.doesNotMatch(hidden.panel.render(40).join("\n"), /Правила|Навыки|Плагины/);
  hidden.panel.dispose();

  const shown = makePanel(40, () => {});
  const lines = shown.panel.render(40);
  const labels = lines.map(line => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim());
  const rows = ["Правила", "Навыки", "Плагины", "MCP"];
  const positions = rows.map(label => labels.indexOf(`│ ${label}${" ".repeat(40 - label.length - 4)} │`));
  assert.ok(positions.every(index => index >= 0), "every link occupies its own full-width row");
  assert.ok(positions.every((index, row) => row === 0 || index > positions[row - 1]!));
  assert.ok(lines.every(line => visibleWidth(line) <= 40));
  shown.panel.dispose();
});

test("clicking a resource row opens it; releasing elsewhere cancels", async () => {
  const opened: string[] = [];
  const { panel, tui, getListener } = makePanel(40, id => opened.push(id));
  const lines = panel.render(40);
  tui.currentLayout = { root: { component: panel, rect: { x: 10, y: 5, width: 40, height: lines.length }, clip: { x: 10, y: 5, width: 40, height: lines.length }, children: [] } };
  const mcpY = 5 + lines.length - 2;
  getListener()?.(`\u001b[<0;15;${mcpY + 1}M`);
  getListener()?.(`\u001b[<0;15;${mcpY + 1}m`);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(opened, ["mcp"]);

  getListener()?.(`\u001b[<0;15;${mcpY + 1}M`);
  getListener()?.(`\u001b[<0;15;${mcpY}m`);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(opened, ["mcp"]);
  panel.dispose();
});

test("resource rows clip cleanly at narrow widths", () => {
  const { panel } = makePanel(40, () => {});
  for (const width of [1, 2, 4, 7, 12, 18, 30]) {
    assert.ok(panel.render(width).every(line => visibleWidth(line) <= width), `overflow at width ${width}`);
  }
  panel.dispose();
});
