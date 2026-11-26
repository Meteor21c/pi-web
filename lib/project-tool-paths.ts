import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isExistingPathWithinRoots } from "./path-security";
import { toNativePath } from "./paths";

const FILE_TOOLS = new Set(["read", "write", "edit", "find", "grep", "ls"]);

export function isProjectFileTool(name: string): boolean {
  return FILE_TOOLS.has(name);
}

export function allowsProjectToolPath(name: string, args: unknown, cwd: string, directories: readonly string[]): boolean {
  const input = args as { path?: unknown } | null;
  const inputPath = input?.path ?? ".";
  if (typeof inputPath !== "string" || inputPath.includes("\0")) return false;
  // Match the Pi built-in tools' path notation before checking the real path.
  let path = inputPath.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "");
  if (process.platform === "win32" && !path.includes("\\")) {
    const shellDrive = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(path);
    if (shellDrive) path = `${shellDrive[1]}:\\${shellDrive[2] ?? ""}`;
  }
  if (path === "~") path = homedir();
  else if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) {
    path = resolve(homedir(), path.slice(2));
  }
  try {
    if (path.startsWith("file://")) path = fileURLToPath(path);
  } catch {
    return false;
  }
  const roots = new Set(directories);
  let target = resolve(cwd, toNativePath(path || "."));
  // A new file inherits the path policy of its first existing ancestor.
  // lstat also detects a dangling symlink, which must not be treated as new.
  while (true) {
    try {
      lstatSync(target);
      return isExistingPathWithinRoots(target, roots);
    } catch (error) {
      const parent = dirname(target);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || name !== "write" || parent === target) return false;
      target = parent;
    }
  }
}
