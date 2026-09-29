export interface NativeDirectoryCommand {
  command: string;
  args: string[];
}

/** Return the platform file-manager command without building a shell string. */
export function nativeDirectoryCommand(
  directory: string,
  platform: NodeJS.Platform = process.platform,
): NativeDirectoryCommand {
  if (platform === "darwin") return { command: "open", args: [directory] };
  if (platform === "win32") return { command: "explorer.exe", args: [directory] };
  return { command: "xdg-open", args: [directory] };
}
