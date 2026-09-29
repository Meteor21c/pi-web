import fs from "fs";
import path from "path";
import { isExistingFilePathAllowed, isFilePathAllowed } from "./file-access";

export type DeleteProjectFileResult =
  | { ok: true }
  | { ok: false; status: 400 | 403 | 404; error: string };

/** Delete one regular file after authorizing both its lexical path and parent. */
export function deleteProjectFile(filePath: string, allowedRoots: Set<string>): DeleteProjectFileResult {
  if (!isFilePathAllowed(filePath, allowedRoots)) {
    return { ok: false, status: 403, error: "Access denied" };
  }
  if (!isExistingFilePathAllowed(path.dirname(filePath), allowedRoots)) {
    return { ok: false, status: 403, error: "Access denied" };
  }

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    return { ok: false, status: 404, error: "File not found" };
  }
  if (!stat.isFile()) {
    return { ok: false, status: 400, error: "Only regular files can be deleted" };
  }

  try {
    fs.unlinkSync(filePath);
    return { ok: true };
  } catch (error) {
    return { ok: false, status: 400, error: error instanceof Error ? error.message : String(error) };
  }
}
