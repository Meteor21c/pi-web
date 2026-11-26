import { normalizeFilePathSlashes } from "./file-paths";

export interface NamedProject {
  id: string;
  name: string;
  defaultDirectory: string;
  directories: string[];
}

export interface ProjectSnapshot {
  projects: NamedProject[];
  /** A missing entry is a legacy chat. An explicit null denotes an independent chat. */
  assignments: Record<string, string | null>;
}

/** Browser display check. The server validates actual paths and symbolic links. */
export function projectContainsDirectory(project: NamedProject, cwd: string): boolean {
  const windows = /^[a-z]:[\\/]|^\\\\|^\/\//i.test(cwd);
  const normalize = (path: string) => {
    const slashed = normalizeFilePathSlashes(path).replace(/\/+$/, "");
    return windows ? slashed.toLowerCase() : slashed;
  };
  const path = normalize(cwd);
  return project.directories.some((directory) => {
    const root = normalize(directory);
    return path === root || path.startsWith(root + "/");
  });
}
