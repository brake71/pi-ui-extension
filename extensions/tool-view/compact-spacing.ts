import {
  ToolExecutionComponent,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import type { ToolViewMode } from "./types.ts";

const OWNER_KEY = Symbol.for("pi-ui-extension:compact-spacing-owned-renderer");
const GUARD_KEY = Symbol.for("pi-ui-extension:compact-spacing-guard");

type OwnedRenderers = ToolRenderers & { [OWNER_KEY]?: boolean };
type ToolInstance = {
  toolDefinition?: OwnedRenderers;
};
type RecordOfPatch = {
  originalRender: ToolExecutionComponent["render"];
  originalMouse: ToolExecutionComponent["handleMouse"];
  patchedRender: ToolExecutionComponent["render"];
  patchedMouse: ToolExecutionComponent["handleMouse"];
};
type ToolPrototype = typeof ToolExecutionComponent.prototype & {
  [GUARD_KEY]?: RecordOfPatch;
};

/** Accept the same Pi layout in both unbundled and whitespace-minified CLI builds. */
export function hasCompatibleSelfToolLayout(
  prototype: Pick<ToolPrototype, "render" | "handleMouse">,
): boolean {
  if (typeof prototype.render !== "function" ||
      typeof prototype.handleMouse !== "function") return false;
  const renderCode = prototype.render.toString();
  const mouseCode = prototype.handleMouse.toString();
  return renderCode.includes("this.selfRenderContainer.render(width)") &&
    renderCode.includes('lines.push("")') &&
    mouseCode.includes("this.selfRenderContainer.handleMouse") &&
    /\bevent\.y\s*-\s*1\b/.test(mouseCode);
}

/** Mark only this extension's tool renderers, never Pi or third-party tools. */
export function markCompactSpacingRenderer<T extends ToolRenderers>(renderer: T): T {
  Object.defineProperty(renderer, OWNER_KEY, { value: true });
  return renderer;
}

/**
 * Pi's ToolExecutionComponent.render() inserts exactly one empty line before
 * every self-rendered tool. Public renderers cannot remove that line. Trim it
 * only for this extension's Compact tools, then offset the mouse y coordinate
 * back to Pi's original layout. Keep native spacing everywhere else.
 *
 * This compatibility adapter fails closed: `hasCompatibleSelfToolLayout`
 * inspects the live host methods on every install, which is the layout contract
 * it depends on. No exact-version whitelist is used, because Pi 1.4.0 keeps this
 * layout unchanged and a version update must not silently disable Compact spacing.
 */
export function installCompactSpacingGuard(getMode: () => ToolViewMode): boolean {
  const prototype = ToolExecutionComponent.prototype as ToolPrototype;
  if (typeof prototype.render !== "function" ||
      typeof prototype.handleMouse !== "function") return false;

  const previous = prototype[GUARD_KEY];
  if (previous) {
    if (prototype.render !== previous.patchedRender ||
        prototype.handleMouse !== previous.patchedMouse) return false;
    // /reload: unwrap the old callbacks instead of stacking wrappers.
    prototype.render = previous.originalRender;
    prototype.handleMouse = previous.originalMouse;
  }

  const originalRender = prototype.render;
  const originalMouse = prototype.handleMouse;
  // Refuse unfamiliar render layouts or previously patched host methods.
  // Pi's bundled CLI minifies event.y - 1 to event.y-1; both are supported.
  if (!hasCompatibleSelfToolLayout({ render: originalRender, handleMouse: originalMouse })) return false;
  const trimmed = new WeakMap<ToolExecutionComponent, boolean>();
  const isOwnedTool = (tool: ToolInstance): boolean =>
    tool.toolDefinition?.renderShell === "self" && tool.toolDefinition?.[OWNER_KEY] === true;
  const eligible = (tool: ToolInstance): boolean => getMode() === "compact" && isOwnedTool(tool);
  const hidden = (tool: ToolInstance): boolean => getMode() === "hidden" && isOwnedTool(tool);

  const patchedRender: typeof originalRender = function (this: ToolExecutionComponent, ...args) {
    if (hidden(this as unknown as ToolInstance)) {
      trimmed.set(this, false);
      return [];
    }
    const lines = originalRender.apply(this, args);
    // A single leading empty row is the exact layout invariant in both SDKs.
    const compact = eligible(this as unknown as ToolInstance) && lines.length > 1 && lines[0] === "";
    trimmed.set(this, compact);
    return compact ? lines.slice(1) : lines;
  };
  const patchedMouse: typeof originalMouse = function (this: ToolExecutionComponent, event) {
    if (hidden(this as unknown as ToolInstance)) return undefined;
    if (trimmed.get(this) && eligible(this as unknown as ToolInstance) && event.y >= 0) {
      return originalMouse.call(this, { ...event, y: event.y + 1, height: event.height + 1 });
    }
    return originalMouse.call(this, event);
  };

  prototype.render = patchedRender;
  prototype.handleMouse = patchedMouse;
  prototype[GUARD_KEY] = { originalRender, originalMouse, patchedRender, patchedMouse };
  return true;
}
