export const TOOL_VIEW_MODES = ["normal", "focus", "compact", "hidden"] as const;
export type ToolViewMode = (typeof TOOL_VIEW_MODES)[number];

/** Focus shares Compact tool rendering, but expands Thinking by default. */
export function isCompactMode(mode: ToolViewMode): boolean {
  return mode === "compact" || mode === "focus";
}

/** One description for the mode status/notification, not a second sidebar row. */
export function modeDescription(mode: ToolViewMode): string {
  switch (mode) {
    case "normal": return "Full thoughts & tool output";
    case "focus": return "Thoughts open · tools compact";
    case "compact": return "Thoughts folded · tools compact";
    case "hidden": return "Thoughts & tools hidden";
  }
}

export function isToolViewMode(value: unknown): value is ToolViewMode {
  return typeof value === "string" && TOOL_VIEW_MODES.includes(value as ToolViewMode);
}
