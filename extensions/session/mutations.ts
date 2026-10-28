import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type DeleteSessionResult =
  | { readonly ok: true; readonly method: "trash" }
  | { readonly ok: false; readonly error: string };

function trashCommand(path: string): { readonly command: string; readonly args: readonly string[] } {
  if (process.platform !== "win32") return { command: "trash", args: [path] };
  const escapedPath = path.replace(/'/g, "''");
  const script = `$ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Stop'; Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${escapedPath}', [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)`;
  return {
    command: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
  };
}

/** Only use recoverable deletion. A trash failure must never trigger permanent deletion. */
export async function deleteSessionFile(pi: ExtensionAPI, path: string): Promise<DeleteSessionResult> {
  try {
    const { command, args } = trashCommand(path);
    const result = await pi.exec(command, [...args], { timeout: 10_000 });
    if (result.code === 0) return { ok: true, method: "trash" };
    const hint = (result.stderr || result.stdout || "").trim().split(/\r?\n/, 1)[0];
    return { ok: false, error: hint || `trash exited with code ${result.code}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
