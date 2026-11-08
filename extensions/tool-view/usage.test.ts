import assert from "node:assert/strict";
import test from "node:test";
import type { ToolExecutionEndEvent } from "@earendil-works/pi-coding-agent";
import { createToolUsageTracker, toolNamesFromBranch } from "./usage.ts";

let nextCallId = 0;
function ended(toolName: string, details: unknown = {}): ToolExecutionEndEvent {
  return {
    type: "tool_execution_end",
    toolCallId: `${toolName}-call-${++nextCallId}`,
    toolName,
    result: { content: [], details },
    isError: false,
  };
}

test("direct, nested, parent snapshot and restored branch share one call identity", () => {
  const tracker = createToolUsageTracker([], () => ["docs"]);
  const nestedCall = { id: "outer/1", name: "mcp__docs__search", status: "ok" };
  const directRead = { type: "message", message: {
    role: "toolResult", toolCallId: "read-1", toolName: "read",
  } };
  const parent = { type: "message", message: {
    role: "toolResult", toolCallId: "outer", toolName: "codemode",
    nestedCalls: { calls: [nestedCall] },
  } };
  tracker.startExchange();
  tracker.record({ ...ended("read"), toolCallId: "read-1" });
  tracker.record({ ...ended("mcp__docs__search"), toolCallId: "outer/1", parentToolCallId: "outer" });
  tracker.record({ ...ended("codemode"), toolCallId: "outer", result: {
    content: [], details: {}, nestedCalls: { calls: [nestedCall] },
  } });
  tracker.record({ ...ended("codemode"), toolCallId: "outer" }); // replay of the same event

  const before = tracker.getSnapshot().counts;
  assert.deepEqual(before, [
    { name: "codemode", kind: "tool", exchange: 1, session: 1 },
    { name: "read", kind: "tool", exchange: 1, session: 1 },
    { name: "mcp__docs__search", kind: "tool", scope: "nested", exchange: 1, session: 1 },
    { name: "docs", kind: "mcp", exchange: 1, session: 1 },
  ]);
  tracker.resetSession([directRead, parent], ["docs"], { preserveExchange: true });
  assert.deepEqual(tracker.getSnapshot().counts, before, "MCP refresh must not double-count events already in the branch");
  tracker.resetSession([directRead, parent], ["docs"], { preserveExchange: true });
  assert.deepEqual(tracker.getSnapshot().counts, before);
  tracker.resetSession([directRead, parent], ["docs"]);
  assert.deepEqual(tracker.getSnapshot().counts, before.map((count) => ({ ...count, exchange: 0 })));
  tracker.resetSession([directRead], ["docs"]);
  assert.deepEqual(tracker.getSnapshot().counts, [
    { name: "read", kind: "tool", exchange: 0, session: 1 },
  ], "switching branches must drop the old nested tool results");
});

test("an anonymized real session reconstructs 32 parent results and 61 nested calls", () => {
  // Derived from the user's real session tool NAMES and counts only.
  // No prompts, args, file paths, model responses or original identifiers.
  const previous = [
    ...Array(15).fill("bash"), ...Array(9).fill("task_todos"),
    ...Array(4).fill("read"), "write", "web_search", "fetch_content", "get_search_content",
  ];
  const current = [
    ...Array(15).fill("bash"), ...Array(6).fill("task_todos"),
    ...Array(4).fill("read"), ...Array(4).fill("write"),
  ];
  const toBranch = (names: string[], prefix: string) => {
    const batches = Array.from({ length: 16 }, () => [] as string[]);
    names.forEach((name, i) => batches[i % 16]!.push(name));
    return batches.map((calls, index) => {
      const id = `${prefix}-${index}`;
      return { type: "message", message: {
        role: "toolResult" as const, toolName: "codemode", toolCallId: id,
        nestedCalls: { calls: calls.map((name, child) => ({ id: `${id}/${child}`, name, status: "ok" })) },
      } };
    });
  };
  const oldBranch = toBranch(previous, "old");
  const newBranch = toBranch(current, "new");
  const tracker = createToolUsageTracker();
  tracker.resetSession(oldBranch);
  tracker.startExchange();
  for (const entry of newBranch) {
    const parent = entry.message;
    for (const child of parent.nestedCalls.calls) {
      tracker.record({
        ...ended(child.name), toolCallId: child.id, parentToolCallId: parent.toolCallId,
      });
    }
    tracker.record({
      ...ended("codemode"), toolCallId: parent.toolCallId,
      result: { content: [], details: {}, nestedCalls: parent.nestedCalls },
    });
  }
  const expected = [
    ["codemode", "direct", 16, 32],
    ["bash", "nested", 15, 30],
    ["task_todos", "nested", 6, 15],
    ["read", "nested", 4, 8],
    ["write", "nested", 4, 5],
    ["fetch_content", "nested", 0, 1],
    ["get_search_content", "nested", 0, 1],
    ["web_search", "nested", 0, 1],
  ] as const;
  const summary = () => Object.fromEntries(tracker.getSnapshot().counts.map((row) =>
    [`${row.scope ?? "direct"}:${row.name}`, [row.exchange, row.session]]));
  const check = () => {
    const actual = summary();
    assert.equal(Object.keys(actual).length, expected.length);
    for (const [name, scope, exchange, session] of expected) {
      assert.deepEqual(actual[`${scope}:${name}`], [exchange, session], `${scope} ${name}`);
    }
  };
  check();
  // MCP discovery rebuilds the current branch while preserving live exchange.
  tracker.resetSession([...oldBranch, ...newBranch], [], { preserveExchange: true });
  check();
  tracker.resetSession([...oldBranch, ...newBranch], [], { preserveExchange: true });
  check();
  // On /reload all historical results remain, but current-question counters reset.
  tracker.resetSession([...oldBranch, ...newBranch]);
  for (const [name, scope, , session] of expected) {
    assert.deepEqual(summary()[`${scope}:${name}`], [0, session]);
  }
});

test("tracks top-level tools for the current question and session", () => {
  const tracker = createToolUsageTracker(["read", "read", "bash"]);
  tracker.startExchange();
  tracker.record(ended("read"));
  // Multiple internal LLM turns in one answer must continue accumulating.
  tracker.record(ended("read"));

  assert.deepEqual(tracker.getSnapshot().counts, [
    { name: "read", kind: "tool", exchange: 2, session: 4 },
    { name: "bash", kind: "tool", exchange: 0, session: 1 },
  ]);

  tracker.startExchange();
  assert.deepEqual(tracker.getSnapshot().counts, [
    { name: "read", kind: "tool", exchange: 0, session: 4 },
    { name: "bash", kind: "tool", exchange: 0, session: 1 },
  ]);
});

test("adds the MCP server for proxy calls without hiding the gateway count", () => {
  const tracker = createToolUsageTracker();
  tracker.startExchange();
  tracker.record(ended("mcp", { mode: "call", server: "codebase-memory-mcp", tool: "search_graph" }));

  assert.deepEqual(tracker.getSnapshot().counts, [
    { name: "mcp", kind: "tool", exchange: 1, session: 1 },
    { name: "codebase-memory-mcp", kind: "mcp", exchange: 1, session: 1 },
  ]);
});

test("attributes Pi native MCP tools to known servers, including sanitized names", () => {
  const tracker = createToolUsageTracker([], () => ["docs", "chrome-devtools"]);
  tracker.startExchange();
  tracker.record(ended("mcp__docs__search"));
  tracker.record(ended("mcp__chrome_devtools__open_page"));
  assert.deepEqual(tracker.getSnapshot().counts.filter((s) => s.kind === "mcp"), [
    { name: "chrome-devtools", kind: "mcp", exchange: 1, session: 1 },
    { name: "docs", kind: "mcp", exchange: 1, session: 1 },
  ]);
  const restored = [{ type: "message", message: { role: "toolResult", toolName: "mcp__docs__search", details: {} } }];
  tracker.resetSession(restored, ["docs"]);
  assert.deepEqual(tracker.getSnapshot().counts.filter((s) => s.kind === "mcp"), [
    { name: "docs", kind: "mcp", exchange: 0, session: 1 },
  ]);
});

test("does not guess an MCP server from ambiguous normalized names", () => {
  const tracker = createToolUsageTracker([], () => ["team-core", "team_core"]);
  tracker.startExchange();
  tracker.record(ended("mcp__team_core__search"));
  assert.deepEqual(tracker.getSnapshot().counts.filter((s) => s.kind === "mcp"), []);
});

test("counts each MCP call made by mcpScript", () => {
  const tracker = createToolUsageTracker([], () => ["codebase-memory-mcp", "context-mode"]);
  tracker.startExchange();
  tracker.record(ended("mcpScript", {
    mode: "script",
    calls: [
      { operation: "search", query: "graph", ok: true },
      { operation: "call", path: "codebase-memory-mcp_search_graph", ok: true },
      { operation: "call", path: "codebase-memory-mcp_get_code_snippet", ok: true },
      { operation: "call", path: "context-mode_ctx_search", ok: false, error: "failed" },
    ],
  }));

  assert.deepEqual(tracker.getSnapshot().counts, [
    { name: "mcpScript", kind: "tool", exchange: 1, session: 1 },
    { name: "codebase-memory-mcp", kind: "mcp", exchange: 2, session: 2 },
    { name: "context-mode", kind: "mcp", exchange: 1, session: 1 },
  ]);
});

test("attributes direct context-mode bridge tools to the MCP server", () => {
  const tracker = createToolUsageTracker();
  tracker.startExchange();
  tracker.record(ended("ctx_execute"));

  assert.deepEqual(tracker.getSnapshot().counts, [
    { name: "ctx_execute", kind: "tool", exchange: 1, session: 1 },
    { name: "context-mode", kind: "mcp", exchange: 1, session: 1 },
  ]);
});

test("does not attribute unknown ctx-prefixed tools to context-mode", () => {
  const tracker = createToolUsageTracker();
  tracker.startExchange();
  tracker.record(ended("ctx_custom"));

  assert.deepEqual(tracker.getSnapshot().counts, [
    { name: "ctx_custom", kind: "tool", exchange: 1, session: 1 },
  ]);
});

test("rebuilds session totals when the active branch changes", () => {
  const firstBranch = [{
    type: "message",
    message: { role: "toolResult", toolName: "read", details: {} },
  }];
  const secondBranch = [{
    type: "message",
    message: { role: "toolResult", toolName: "bash", details: {} },
  }];
  const tracker = createToolUsageTracker(toolNamesFromBranch(firstBranch));
  tracker.startExchange();
  tracker.resetSession(secondBranch);

  assert.deepEqual(tracker.getSnapshot().counts, [
    { name: "bash", kind: "tool", exchange: 0, session: 1 },
  ]);
});

test("re-attributes restored mcpScript calls after MCP server discovery", () => {
  const entries = [{
    type: "message",
    message: {
      role: "toolResult",
      toolName: "mcpScript",
      details: {
        mode: "script",
        calls: [{ operation: "call", path: "team_core_search", ok: false, error: "failed" }],
      },
    },
  }];
  const tracker = createToolUsageTracker(toolNamesFromBranch(entries));
  tracker.resetSession(entries, ["team_core"]);

  assert.deepEqual(tracker.getSnapshot().counts, [
    { name: "mcpScript", kind: "tool", exchange: 0, session: 1 },
    { name: "team_core", kind: "mcp", exchange: 0, session: 1 },
  ]);
});

test("keeps same-named Tool and MCP server in separate sections", () => {
  const tracker = createToolUsageTracker();
  tracker.startExchange();
  tracker.record(ended("mcp", { mode: "call", server: "mcp", tool: "status" }));

  assert.deepEqual(tracker.getSnapshot().counts, [
    { name: "mcp", kind: "tool", exchange: 1, session: 1 },
    { name: "mcp", kind: "mcp", exchange: 1, session: 1 },
  ]);
});

test("rebuilds current-question MCP counts when server discovery arrives late", () => {
  let servers: string[] = [];
  const details = {
    mode: "script",
    calls: [{ operation: "call", path: "team_core_search", ok: true }],
  };
  const entries = [{
    type: "message",
    message: { role: "toolResult", toolName: "mcpScript", toolCallId: "script-live", details },
  }];
  const tracker = createToolUsageTracker([], () => servers);
  tracker.startExchange();
  tracker.record({ ...ended("mcpScript", details), toolCallId: "script-live" });
  servers = ["team_core"];
  tracker.resetSession(entries, servers, { preserveExchange: true });

  assert.deepEqual(tracker.getSnapshot().counts, [
    { name: "mcpScript", kind: "tool", exchange: 1, session: 1 },
    { name: "team_core", kind: "mcp", exchange: 1, session: 1 },
  ]);
});

test("clears current-question counts when the active branch changes", () => {
  const tracker = createToolUsageTracker();
  tracker.startExchange();
  tracker.record(ended("read"));
  tracker.resetSession([{
    type: "message",
    message: { role: "toolResult", toolName: "read", details: {} },
  }]);

  assert.deepEqual(tracker.getSnapshot().counts, [
    { name: "read", kind: "tool", exchange: 0, session: 1 },
  ]);
});

test("restores completed tool and MCP counts from a session branch", () => {
  const entries = [
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "read",
        details: {},
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "mcp",
        details: { mode: "call", server: "codebase-memory-mcp", tool: "search_graph" },
      },
    },
  ];

  assert.deepEqual(toolNamesFromBranch(entries), ["read", "mcp", "codebase-memory-mcp"]);
});
