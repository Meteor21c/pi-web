import { spawn } from "node:child_process";
import path from "node:path";

export interface NativeDirectoryCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export type NativeFileAction = "open" | "reveal";

/** Return the platform file-manager command without building a shell string. */
export function nativeDirectoryCommand(
  directory: string,
  platform: NodeJS.Platform = process.platform,
): NativeDirectoryCommand {
  if (platform === "darwin") return { command: "open", args: [directory] };
  if (platform === "win32") return { command: "explorer.exe", args: [directory] };
  return { command: "xdg-open", args: [directory] };
}

export function nativeFileCommand(
  filePath: string,
  action: NativeFileAction,
  platform: NodeJS.Platform = process.platform,
): NativeDirectoryCommand {
  if (action === "reveal") {
    if (platform === "darwin") return { command: "open", args: ["-R", filePath] };
    if (platform === "win32") return { command: "explorer.exe", args: ["/select,", filePath] };
    return nativeDirectoryCommand(path.dirname(filePath), platform);
  }
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", "Invoke-Item -LiteralPath $env:METEORAGENT_NATIVE_FILE -ErrorAction Stop"],
      env: { METEORAGENT_NATIVE_FILE: filePath },
    };
  }
  return nativeDirectoryCommand(filePath, platform);
}

export function launchNativeCommand({ command, args, env }: NativeDirectoryCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: env && { ...process.env, ...env },
    });
    const dispatched = () => {
      clearTimeout(timeout);
      child.unref();
      resolve();
    };
    // Desktop handlers can stay alive with their window. Check for immediate failures only.
    const timeout = setTimeout(dispatched, 2_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    // Explorer forwards the request and does not reliably signal success in its exit code.
    if (command === "explorer.exe") child.once("spawn", dispatched);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error("Unable to open the item in the operating system"));
    });
  });
}
