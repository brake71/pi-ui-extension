import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ToolViewPanel, groupUsageCounts } from "./panel.ts";

test("groups Tool View usage into Tool and MCP sections", () => {
  const grouped = groupUsageCounts([
    { name: "read", kind: "tool", exchange: 2, session: 10 },
    { name: "codebase-memory-mcp", kind: "mcp", exchange: 1, session: 4 },
    { name: "mcp", kind: "tool", exchange: 1, session: 3 },
    { name: "context-mode", kind: "mcp", exchange: 0, session: 7 },
  ]);

  assert.deepEqual(grouped.tool.map((count) => count.name), ["read", "mcp"]);
  assert.deepEqual(grouped.mcp.map((count) => count.name), ["codebase-memory-mcp", "context-mode"]);
});

function renderPanel(): string[] {
  const tui = { addInputListener: () => () => {}, requestRender() {} } as any;
  const theme = { fg: (_color: string, text: string) => text } as any;
  return new ToolViewPanel(theme, {
    tui,
    getDesiredWidth: () => 60,
    getMode: () => "compact",
    getUsage: () => ({
      counts: [
        { name: "read", kind: "tool", exchange: 1, session: 4 },
        { name: "context-mode", kind: "mcp", exchange: 1, session: 3 },
      ],
    }),
    onSelect() {},
  }).render(60);
}

test("renders separate Direct and Nested groups for same-named tool calls", () => {
  const tui = { addInputListener: () => () => {}, requestRender() {} } as any;
  const theme = { fg: (_color: string, text: string) => text } as any;
  const panel = new ToolViewPanel(theme, {
    tui,
    getDesiredWidth: () => 54,
    getMode: () => "compact",
    getUsage: () => ({ counts: [
      { name: "codemode", kind: "tool", exchange: 1, session: 2 },
      { name: "read", kind: "tool", exchange: 1, session: 2 },
      { name: "read", kind: "tool", scope: "nested", exchange: 3, session: 8 },
      { name: "bash", kind: "tool", scope: "nested", exchange: 5, session: 30 },
      { name: "docs", kind: "mcp", exchange: 1, session: 2 },
    ] }),
    onSelect() {},
  });
  const rendered = panel.render(54).join("\n");
  assert.match(rendered, /ВЫЗОВЫ[\s\S]*codemode\s+1\/2[\s\S]*read\s+1\/2/);
  assert.match(rendered, /ВЛОЖЕННЫЕ[\s\S]*read\s+3\/8/);
  assert.match(rendered, /ВЛОЖЕННЫЕ[\s\S]*bash\s+5\/30/);
  assert.match(rendered, /MCP[\s\S]*docs\s+1\/2/);
  assert.ok(rendered.indexOf("ВЫЗОВЫ") < rendered.indexOf("ВЛОЖЕННЫЕ"));
  assert.ok(rendered.indexOf("ВЛОЖЕННЫЕ") < rendered.indexOf("MCP"));
  panel.dispose();
});

test("summary retains Run/Total but group headers omit redundant subtotals", () => {
  const tui = { addInputListener: () => () => {}, requestRender() {} } as any;
  const theme = { fg: (_color: string, text: string) => text } as any;
  const panel = new ToolViewPanel(theme, {
    tui,
    getDesiredWidth: () => 56,
    getMode: () => "normal",
    getUsage: () => ({ counts: [
      { name: "codemode", kind: "tool", exchange: 2, session: 10 },
      { name: "read", kind: "tool", exchange: 1, session: 7 },
      { name: "bash", kind: "tool", scope: "nested", exchange: 4, session: 20 },
      { name: "read", kind: "tool", scope: "nested", exchange: 0, session: 8 },
      { name: "docs", kind: "mcp", exchange: 5, session: 55 },
    ] }),
    onSelect() {},
  });
  const rendered = panel.render(56);
  assert.match(rendered.join("\n"), /СЕЙЧАС\s+ВСЕГО/);
  assert.match(rendered.join("\n"), /\n[^\n]*7\s+45\s*│/);
  const directHeader = rendered.find((line) => line.includes("ВЫЗОВЫ"));
  const nestedHeader = rendered.find((line) => line.includes("ВЛОЖЕННЫЕ"));
  const mcpHeader = rendered.find((line) => line.includes("MCP ·"));
  assert.match(directHeader ?? "", /ВЫЗОВЫ · 2/);
  assert.match(nestedHeader ?? "", /ВЛОЖЕННЫЕ · 2/);
  assert.match(mcpHeader ?? "", /MCP · 1/);
  for (const header of [directHeader, nestedHeader, mcpHeader]) {
    assert.doesNotMatch(header ?? "", /\d+\/\d+/, "no redundant Run/Total in group headers");
  }
  assert.match(rendered.join("\n"), /codemode\s+2\/10/);
  assert.doesNotMatch(rendered.join("\n"), /▸\s+codemode/, "direct tools have no leading glyph");
  assert.match(rendered.join("\n"), /bash\s+4\/20/);
  assert.doesNotMatch(rendered.join("\n"), /↳/, "nested tool names no longer carry arrows");
  const directRow = rendered.find((line) => line.includes("codemode"));
  const nestedRow = rendered.find((line) => line.includes("bash"));
  assert.equal(directRow?.indexOf("codemode"), nestedRow?.indexOf("bash"), "nested and direct names must align");
  assert.match(rendered.join("\n"), /read\s+0\/8/, "nested detail rows remain fully visible");
  panel.dispose();
});

test("run counts use success color, zero counts stay dim, and totals remain neutral", () => {
  const tui = { addInputListener: () => () => {}, requestRender() {} } as any;
  const codes: Record<string, number> = { success: 32, dim: 90, text: 37, accent: 35, muted: 90, warning: 33 };
  const theme = { fg: (name: string, value: string) => `\x1b[${codes[name] ?? 37}m${value}\x1b[39m` } as any;
  const panel = new ToolViewPanel(theme, {
    tui,
    getDesiredWidth: () => 52,
    getMode: () => "compact",
    getUsage: () => ({ counts: [
      { name: "codemode", kind: "tool", exchange: 2, session: 32 },
      { name: "bash", kind: "tool", scope: "nested", exchange: 0, session: 30 },
    ] }),
    onSelect() {},
  });
  const lines = panel.render(52);
  const body = lines.join("\n");
  assert.match(body, /\x1b\[32m2\x1b\[39m\x1b\[90m\/\x1b\[39m\x1b\[37m32/);
  assert.match(body, /\x1b\[90m0\x1b\[39m\x1b\[90m\/\x1b\[39m\x1b\[37m30/);
  assert.ok(lines.every((line) => visibleWidth(line) === 52), "ANSI styling must not break column alignment");
  panel.dispose();
});

test("long tool names and group labels adapt to narrow terminal widths without wrapping", () => {
  const tui = { addInputListener: () => () => {}, requestRender() {} } as any;
  const theme = { fg: (_color: string, text: string) => text } as any;
  const panel = new ToolViewPanel(theme, {
    tui,
    getDesiredWidth: () => 56,
    getMode: () => "compact",
    getUsage: () => ({ counts: [
      { name: "codemode", kind: "tool", exchange: 0, session: 32 },
      { name: "get_search_content_extremely_long_named_tool", kind: "tool", scope: "nested", exchange: 0, session: 999 },
      { name: "bash", kind: "tool", scope: "nested", exchange: 0, session: 30 },
      { name: "really_long_mcp_server_name", kind: "mcp", exchange: 0, session: 120 },
    ] }),
    onSelect() {},
  });
  for (const width of [16, 18, 24, 32, 48, 56]) {
    const lines = panel.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `overflow at width ${width}`);
    assert.equal(lines.length, panel.render(56).length, "all nested rows stay visible");
    assert.doesNotMatch(lines.join("\n"), /↳/, "nested rows no longer use arrows");
    assert.match(lines.join("\n"), /999/, "nested totals remain visible when labels truncate");
  }
  panel.dispose();
});

test("keeps the mode selector visible alongside Tool and MCP usage", () => {
  const lines = renderPanel();
  const output = lines.join("\n");
  assert.match(lines[0] ?? "", /ОТОБРАЖЕНИЕ/);
  assert.doesNotMatch(lines[0] ?? "", /TOOL VIEW/);
  assert.equal(lines.length, 12);
  assert.match(lines[1] ?? "", /Полный.*Краткий.*Скрытый/);
  assert.equal(lines[2], `├${"─".repeat(58)}┤`, "mode separator must reach both borders with no padding");
  assert.match(lines[3] ?? "", /СЕЙЧАС\s+ВСЕГО/);
  assert.match(output, /ВЫЗОВЫ · 1/);
  assert.match(output, /MCP · 1/);
  assert.doesNotMatch(lines.find((line) => line.includes("ВЫЗОВЫ")) ?? "", /\d+\/\d+/);
  assert.doesNotMatch(lines.find((line) => line.includes("MCP ·")) ?? "", /\d+\/\d+/);
  assert.match(output, /Полный/);
  assert.match(output, /Краткий/);
  assert.match(output, /Скрытый/);
  assert.match(output, /ВЫЗОВЫ/);
  assert.match(output, /read/);
  assert.match(output, /MCP/);
  assert.match(output, /context-mode/);
});
