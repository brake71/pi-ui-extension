import type { TokenTotals } from "./panel.ts";

/** Provider-reported assistant usage, accumulated for the active session branch. */
export function createTokenUsageTracker(): {
  add(usage: unknown): void;
  reset(branch: readonly unknown[]): void;
  getTotals(): TokenTotals;
} {
  let input = 0;
  let output = 0;
  let cache = 0;
  const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  const add = (usage: unknown): void => {
    if (!usage || typeof usage !== "object") return;
    const values = usage as { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown };
    input += number(values.input);
    output += number(values.output);
    cache += number(values.cacheRead) + number(values.cacheWrite);
  };
  return {
    add,
    reset(branch): void {
      input = output = cache = 0;
      for (const entry of branch) {
        if (!entry || typeof entry !== "object") continue;
        const typed = entry as { type?: unknown; message?: { role?: unknown; usage?: unknown } };
        if (typed.type === "message" && typed.message?.role === "assistant") add(typed.message.usage);
      }
    },
    getTotals: () => ({ input, output, cache }),
  };
}
