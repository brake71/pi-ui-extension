import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type DeleteSessionResult =
  | { readonly ok: true; readonly method: "trash" | "recycle" }
  | { readonly ok: false; readonly error: string };

/**
 * PowerShell one-liner: the only recoverable delete Windows ships.
 * The path is embedded as a single-quoted literal, so apostrophes are doubled.
 */
function recycleScript(path: string): string {
  return `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${path.replace(/'/g, "''")}','OnlyErrorDialogs','SendToRecycleBin')`;
}

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/).filter((entry) => entry.trim().length > 0);
  return line.length > 0 ? line[0]! : "";
}

async function trashCommand(pi: ExtensionAPI, path: string): Promise<DeleteSessionResult> {
  try {
    const result = await pi.exec("trash", [path], { timeout: 10_000 });
    if (result.code === 0) return { ok: true, method: "trash" };
    return { ok: false, error: firstLine(result.stderr) || firstLine(result.stdout) || `trash exited with code ${result.code}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function windowsRecycleBin(pi: ExtensionAPI, path: string): Promise<DeleteSessionResult> {
  try {
    const result = await pi.exec(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", recycleScript(path)],
      { timeout: 20_000 },
    );
    if (result.code === 0) return { ok: true, method: "recycle" };
    return { ok: false, error: firstLine(result.stderr) || firstLine(result.stdout) || `powershell exited with code ${result.code}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Only use recoverable deletion. A failed trash command must never trigger permanent deletion.
 * On Windows, try the cross-platform trash command first, then the Recycle Bin.
 */
export async function deleteSessionFile(pi: ExtensionAPI, path: string): Promise<DeleteSessionResult> {
  const trashed = await trashCommand(pi, path);
  if (trashed.ok || process.platform !== "win32") return trashed;
  const recycled = await windowsRecycleBin(pi, path);
  return recycled.ok ? recycled : { ok: false, error: `trash: ${trashed.error}; recycle bin: ${recycled.error}` };
}
