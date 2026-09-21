import fs from "fs";
import path from "path";

export const UPLOAD_CONFLICT_STRATEGIES = ["error", "overwrite", "skip", "rename"] as const;
export type UploadConflictStrategy = typeof UPLOAD_CONFLICT_STRATEGIES[number];

const UPLOAD_CONFLICT_STRATEGY_SET = new Set<string>(UPLOAD_CONFLICT_STRATEGIES);

export interface UploadTargetInspection {
  conflicts: string[];
  nonReplaceable: string[];
}

export function parseUploadConflictStrategy(value: string | null): UploadConflictStrategy | null {
  const candidate = value ?? "error";
  return UPLOAD_CONFLICT_STRATEGY_SET.has(candidate)
    ? candidate as UploadConflictStrategy
    : null;
}

export function validateUploadFileNames(fileNames: string[]): string | null {
  if (fileNames.length === 0) return "No files selected";

  const seen = new Set<string>();
  for (const fileName of fileNames) {
    if (!fileName || fileName === "." || fileName === ".." || fileName.includes("\0")) {
      return `Invalid file name: ${fileName || "(empty)"}`;
    }
    if (fileName.includes("/") || fileName.includes("\\") || path.basename(fileName) !== fileName) {
      return `File names must not contain a path: ${fileName}`;
    }
    if (seen.has(fileName)) return `Duplicate file name in upload: ${fileName}`;
    seen.add(fileName);
  }

  return null;
}

export function inspectUploadTargets(directory: string, fileNames: string[]): UploadTargetInspection {
  const conflicts: string[] = [];
  const nonReplaceable: string[] = [];

  for (const fileName of fileNames) {
    const destination = path.join(directory, fileName);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      throw error;
    }

    conflicts.push(fileName);
    if (!stat.isFile() || stat.isSymbolicLink()) nonReplaceable.push(fileName);
  }

  return { conflicts, nonReplaceable };
}

/**
 * Pick a sibling name without overwriting an existing project file. Composer
 * attachments use this policy because attaching the same-named download twice
 * should be safe and should not interrupt the chat with an overwrite dialog.
 */
export function availableUploadFileName(
  directory: string,
  requestedName: string,
  reservedNames: ReadonlySet<string> = new Set(),
): string {
  if (!reservedNames.has(requestedName) && !fs.existsSync(path.join(directory, requestedName))) {
    return requestedName;
  }

  const parsed = path.parse(requestedName);
  for (let suffix = 1; suffix <= 10_000; suffix += 1) {
    const candidate = `${parsed.name} (${suffix})${parsed.ext}`;
    if (!reservedNames.has(candidate) && !fs.existsSync(path.join(directory, candidate))) {
      return candidate;
    }
  }
  throw new Error(`Unable to choose an available file name for: ${requestedName}`);
}
