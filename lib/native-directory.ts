import { spawn } from "node:child_process";
import path from "node:path";

export interface NativeDirectoryCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
  waitForExit?: boolean;
}

export type NativeFileAction = "open" | "reveal";

// Only hide the PowerShell helper. The Windows shell should show the target in a normal window.
// Keep the path out of the script so spaces, non-ASCII text and shell metacharacters stay literal.
const WINDOWS_SHELL_COMMAND = Buffer.from(`
$ErrorActionPreference = 'Stop'
$target = $env:METEORAGENT_NATIVE_PATH
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.UseShellExecute = $true
$start.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Normal
if ($env:METEORAGENT_NATIVE_ACTION -eq 'reveal') {
  $start.FileName = Join-Path $env:SystemRoot 'explorer.exe'
  $start.Arguments = '/select,"' + $target + '"'
} else {
  $start.FileName = $target
}
[System.Diagnostics.Process]::Start($start) | Out-Null
`, "utf16le").toString("base64");

function windowsShellCommand(target: string, action: NativeFileAction): NativeDirectoryCommand {
  return {
    command: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", WINDOWS_SHELL_COMMAND],
    env: { METEORAGENT_NATIVE_PATH: path.win32.normalize(target), METEORAGENT_NATIVE_ACTION: action },
    waitForExit: true,
  };
}

/** Return the platform file-manager command without building a shell string. */
export function nativeDirectoryCommand(
  directory: string,
  platform: NodeJS.Platform = process.platform,
): NativeDirectoryCommand {
  if (platform === "darwin") return { command: "open", args: [directory] };
  if (platform === "win32") return windowsShellCommand(directory, "open");
  return { command: "xdg-open", args: [directory] };
}

export function nativeFileCommand(
  filePath: string,
  action: NativeFileAction,
  platform: NodeJS.Platform = process.platform,
): NativeDirectoryCommand {
  if (platform === "win32") return windowsShellCommand(filePath, action);
  if (action === "reveal") {
    if (platform === "darwin") return { command: "open", args: ["-R", filePath] };
    return nativeDirectoryCommand(path.dirname(filePath), platform);
  }
  return nativeDirectoryCommand(filePath, platform);
}

export function launchNativeCommand({ command, args, env, waitForExit }: NativeDirectoryCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: env && { ...process.env, ...env },
    });
    const timeout = setTimeout(() => {
      if (waitForExit) {
        child.kill();
        reject(new Error("The operating system took too long to open the item"));
        return;
      }
      // Other platforms may keep the desktop handler alive with its window.
      child.unref();
      resolve();
    }, waitForExit ? 10_000 : 2_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error("Unable to open the item in the operating system"));
    });
  });
}
