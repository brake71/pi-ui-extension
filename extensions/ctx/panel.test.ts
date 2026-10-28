import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth, type TuiInputListener } from "@earendil-works/pi-tui";
import { ContextPanel } from "./panel.ts";
import { estimateContext } from "./data.ts";

const theme = { fg: (_color: string, text: string) => text } as any;

function makePanel(options: { width?: number; tui?: any; totals?: { input: number; output: number; cache: number } } = {}) {
  return new ContextPanel(theme, {
    tui: options.tui,
    getDesiredWidth: () => options.width ?? 50,
    getUsage: () => ({ percent: 42, contextWindow: 200_000 } as any),
    getModel: () => "test-model",
    getThinkingLevel: () => "high",
    getTokenTotals: () => options.totals ?? { input: 0, output: 0, cache: 0 },
    getEstimate: () => estimateContext([{ role: "user", content: "hello" }]),
  });
}

test("renders compact model and percent, bar, and provider token totals", () => {
  const panel = makePanel({ totals: { input: 12_345, output: 234, cache: 5_678 } });
  const lines = panel.render(50);
  const output = lines.join("\n");
  assert.match(output, /test-model · high/);
  assert.match(output, /42%/);
  assert.match(output, /███████████████████/);
  assert.match(output, /in 12K \/ out 234 \/ cache 5\.7K/);
  assert.match(output, /▸ Composition/);
  assert.doesNotMatch(output, /Messages|Images/);
  assert.ok(lines.every(line => visibleWidth(line) <= 50));
  panel.dispose();
});

test("clipped narrow widths never overflow", () => {
  const panel = makePanel({ width: 50, totals: { input: 12_345, output: 234, cache: 5_678 } });
  for (const width of [1, 2, 4, 12, 18, 30]) {
    assert.ok(panel.render(width).every(line => visibleWidth(line) <= width), `overflow at ${width}`);
  }
  panel.dispose();
});

test("composition is collapsed initially and expands on click", () => {
  let listener: TuiInputListener | undefined;
  const tui = { addInputListener(next: TuiInputListener) { listener = next; return () => {}; }, requestRender() {}, currentLayout: undefined as any };
  const panel = makePanel({ tui, totals: { input: 100, output: 20, cache: 0 } });
  const lines = panel.render(50);
  assert.match(lines.join("\n"), /▸ Composition/);
  assert.doesNotMatch(lines.join("\n"), /System|Messages|Images/);
  tui.currentLayout = { root: { component: panel, rect: { x: 10, y: 5, width: 50, height: lines.length }, clip: { x: 10, y: 5, width: 50, height: lines.length }, children: [] } };
  const compositionY = 5 + lines.length - 2;
  assert.deepEqual(listener?.(`\u001b[<0;14;${compositionY + 1}M`), { consume: true });
  assert.deepEqual(listener?.(`\u001b[<0;14;${compositionY + 1}m`), { consume: true });
  const expanded = panel.render(50).join("\n");
  assert.match(expanded, /▾ Composition/);
  assert.match(expanded, /Messages/);
  assert.match(expanded, /Images/);
  panel.dispose();
});

test("releasing outside Composition cancels its toggle", () => {
  let listener: TuiInputListener | undefined;
  const tui = { addInputListener(next: TuiInputListener) { listener = next; return () => {}; }, requestRender() {}, currentLayout: undefined as any };
  const panel = makePanel({ tui, totals: { input: 1, output: 2, cache: 3 } });
  const lines = panel.render(50);
  tui.currentLayout = { root: { component: panel, rect: { x: 10, y: 5, width: 50, height: lines.length }, clip: { x: 10, y: 5, width: 50, height: lines.length }, children: [] } };
  const targetY = 5 + lines.length - 2;
  listener?.(`\u001b[<0;14;${targetY + 1}M`);
  listener?.(`\u001b[<0;14;${targetY + 2}m`);
  assert.match(panel.render(50).join("\n"), /▸ Composition/);
  panel.dispose();
});

test("missing context snapshot remains visible", () => {
  const panel = new ContextPanel(theme, { getDesiredWidth: () => 50, getUsage: () => undefined, getModel: () => "", getThinkingLevel: () => "" });
  assert.match(panel.render(50).join("\n"), /\?%/);
  panel.dispose();
});
