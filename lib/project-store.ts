import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { isPathWithinRoots } from "./path-security";
import { samePath } from "./paths";
import { projectIdentityKey } from "./project-identity";
import { listSessionFamilies } from "./session-family";
import type { NamedProject, ProjectSnapshot } from "./projects";
import type { SessionInfo } from "./types";

interface StoredProjectSnapshot extends ProjectSnapshot {
  version: 1;
}

type ProjectInput = Partial<Record<"name" | "defaultDirectory" | "directories", unknown>>;

export class ProjectStoreError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function projectsPath(): string {
  return join(getAgentDir(), "meteoragent-projects.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDirectoryPath(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && !value.includes("\0");
}

function validStoredProject(value: unknown): value is NamedProject {
  if (!isRecord(value)) return false;
  const { id, name, defaultDirectory, directories } = value;
  return typeof id === "string"
    && typeof name === "string"
    && isDirectoryPath(defaultDirectory)
    && Array.isArray(directories)
    && directories.every(isDirectoryPath)
    && directories.some((directory) => samePath(directory, defaultDirectory));
}

function readProjects(path: string): StoredProjectSnapshot {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, projects: [], assignments: Object.create(null) };
    }
    throw error;
  }
  const invalid = () => new Error("The saved projects file is invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw invalid();
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.projects)
    || !parsed.projects.every(validStoredProject) || !isRecord(parsed.assignments)) {
    throw invalid();
  }

  const ids = new Set(parsed.projects.map((project) => project.id));
  const assignments: ProjectSnapshot["assignments"] = Object.create(null);
  for (const [sessionId, projectId] of Object.entries(parsed.assignments)) {
    if (projectId !== null && (typeof projectId !== "string" || !ids.has(projectId))) throw invalid();
    assignments[sessionId] = projectId;
  }
  if (ids.size !== parsed.projects.length) throw invalid();
  return { version: 1, projects: parsed.projects, assignments };
}

function snapshotOf({ projects, assignments }: StoredProjectSnapshot): ProjectSnapshot {
  return { projects, assignments };
}

export function getProjectSnapshot(path = projectsPath()): ProjectSnapshot {
  return snapshotOf(readProjects(path));
}

export function getNamedProject(id: string, path = projectsPath()): NamedProject | undefined {
  return getProjectSnapshot(path).projects.find((project) => project.id === id);
}

export function sessionProjectId(sessionId: string, path = projectsPath()): string | null | undefined {
  return getProjectSnapshot(path).assignments[sessionId];
}

/** Preserve an unavailable directory in the project settings until it can be located again. */
export function getActiveProjectRoots(project: NamedProject): Set<string> {
  const roots = new Set<string>();
  for (const directory of project.directories) {
    try {
      const real = realpathSync.native(directory);
      // Avoid authorizing a new location if an approved path became a symlink or junction.
      if (samePath(real, directory) && statSync(real).isDirectory()) roots.add(real);
    } catch {
      // A removable drive or folder may be unavailable temporarily.
    }
  }
  return roots;
}

export function isProjectDirectory(cwd: string, project: NamedProject): boolean {
  if (!isDirectoryPath(cwd)) return false;
  try {
    const real = realpathSync.native(cwd);
    return statSync(real).isDirectory() && isPathWithinRoots(real, getActiveProjectRoots(project));
  } catch {
    return false;
  }
}

function existingDirectory(value: unknown, retained: string[]): string {
  if (typeof value !== "string" || !value.trim()) throw new ProjectStoreError("Enter a folder path");
  const raw = value.trim();
  const path = raw === "~" ? homedir() : /^~[\\/]/.test(raw) ? resolve(homedir(), raw.slice(2)) : raw;
  if (!isDirectoryPath(path)) throw new ProjectStoreError("Use an absolute folder path");
  const previouslyApproved = retained.find((folder) => samePath(folder, path));
  if (previouslyApproved) return previouslyApproved;
  try {
    const real = realpathSync.native(path);
    if (!statSync(real).isDirectory()) throw new ProjectStoreError(`This path is not a folder: ${raw}`);
    return real;
  } catch (error) {
    if (error instanceof ProjectStoreError) throw error;
    throw new ProjectStoreError(`Cannot access this folder: ${raw}`);
  }
}

function projectFields(value: unknown, previous?: NamedProject): Omit<NamedProject, "id"> {
  if (!isRecord(value)) throw new ProjectStoreError("Invalid project");
  const input: ProjectInput = value;
  const name = input.name === undefined ? previous?.name : input.name;
  if (typeof name !== "string" || !name.trim()) throw new ProjectStoreError("Enter a project name");

  const retained = previous?.directories ?? [];
  const defaultDirectory = input.defaultDirectory === undefined && previous
    ? previous.defaultDirectory
    : existingDirectory(input.defaultDirectory, retained);
  if (input.directories !== undefined && !Array.isArray(input.directories)) {
    throw new ProjectStoreError("Project folders must be a list");
  }
  const requested = input.directories === undefined
    ? retained
    : input.directories.map((directory) => existingDirectory(directory, retained));
  const directories = [defaultDirectory];
  for (const directory of requested) {
    if (!directories.some((item) => samePath(directory, item))) directories.push(directory);
  }
  return { name: name.trim(), defaultDirectory, directories };
}

/** Serialize read/modify/write across every local Magent process. */
async function changeProjects<T>(path: string, update: (state: StoredProjectSnapshot) => T, afterWrite?: () => void, shouldWrite?: () => boolean): Promise<T> {
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  const filename = join(realpathSync(dirname(path)), basename(path));
  const release = await lockfile.lock(filename, {
    realpath: false,
    retries: { retries: 10, minTimeout: 50, maxTimeout: 300 },
  });
  try {
    const state = readProjects(filename);
    const result = update(state);
    if (!shouldWrite || shouldWrite()) {
      writePrivateFileAtomicSync(filename, JSON.stringify(state, null, 2) + "\n");
      afterWrite?.();
    }
    return result;
  } finally {
    await release();
  }
}

export function createNamedProject(value: unknown, path = projectsPath()): Promise<ProjectSnapshot & { project: NamedProject }> {
  return changeProjects(path, (state) => {
    const project: NamedProject = { id: randomUUID(), ...projectFields(value) };
    state.projects.push(project);
    return { ...snapshotOf(state), project };
  });
}

interface ProjectChangeOptions {
  path?: string;
  beforeWrite?: (changedSessionIds: string[]) => void;
  afterWrite?: () => void;
}

export function updateNamedProject(
  id: string,
  value: unknown,
  { path = projectsPath(), beforeWrite, afterWrite }: ProjectChangeOptions = {},
): Promise<ProjectSnapshot> {
  return changeProjects(path, (state) => {
    const index = state.projects.findIndex((project) => project.id === id);
    if (index < 0) throw new ProjectStoreError("Project not found", 404);
    const oldProject = state.projects[index];
    const project: NamedProject = { id, ...projectFields(value, oldProject) };
    if (beforeWrite && (oldProject.directories.length !== project.directories.length
      || oldProject.directories.some((old) => !project.directories.some((current) => samePath(old, current))))) {
      const sessionIds = Object.entries(state.assignments)
        .filter(([, projectId]) => projectId === id)
        .map(([sessionId]) => sessionId);
      beforeWrite(sessionIds);
    }
    state.projects[index] = project;
    return snapshotOf(state);
  }, afterWrite);
}

export function setSessionProjects(
  sessionIds: string[],
  projectId: string | null,
  { path = projectsPath(), beforeWrite, afterWrite }: ProjectChangeOptions = {},
): Promise<ProjectSnapshot> {
  return changeProjects(path, (state) => {
    if (projectId !== null && !state.projects.some((project) => project.id === projectId)) {
      throw new ProjectStoreError("Project not found", 404);
    }
    const changed = sessionIds.filter((sessionId) => state.assignments[sessionId] !== projectId);
    beforeWrite?.(changed);
    for (const sessionId of changed) state.assignments[sessionId] = projectId;
    return snapshotOf(state);
  }, () => {
    // Legacy file roots used to include this chat's working directory.
    globalThis.__piAllowedRootsCache = undefined;
    afterWrite?.();
  });
}

export function setSessionProject(sessionId: string, projectId: string | null): Promise<ProjectSnapshot> {
  return setSessionProjects([sessionId], projectId);
}

interface ProjectMigrationOptions {
  path?: string;
  isBusy?: (sessionId: string) => boolean;
  afterWrite?: (sessionIds: string[]) => void;
}

function legacyDirectory(path: string): string {
  const normalized = resolve(path);
  try {
    return realpathSync.native(normalized);
  } catch {
    return normalized;
  }
}

/** Convert only unassigned history. Project assignment never rewrites the transcript or its working directory. */
export async function migrateLegacyProjects(
  sessions: readonly SessionInfo[],
  { path = projectsPath(), isBusy, afterWrite }: ProjectMigrationOptions = {},
): Promise<ProjectSnapshot & { deferredMigration?: true }> {
  const existing = getProjectSnapshot(path);
  const families = listSessionFamilies(sessions).filter(({ root, subagents }) =>
    [root, ...subagents].some((session) => !Object.hasOwn(existing.assignments, session.id)),
  );
  if (families.length === 0) return existing;

  const canonicalPaths = new Map<string, string>();
  const folderFor = (folder: string) => {
    let directory = canonicalPaths.get(folder);
    if (directory === undefined) {
      directory = legacyDirectory(folder);
      canonicalPaths.set(folder, directory);
    }
    return directory;
  };
  const candidates = families.map(({ root, subagents }) => ({
    root,
    members: [root, ...subagents],
    directory: isDirectoryPath(root.cwd) ? folderFor(root.cwd) : null,
    group: isDirectoryPath(root.projectRoot) ? folderFor(root.projectRoot)
      : isDirectoryPath(root.cwd) ? folderFor(root.cwd) : null,
  }));
  const migrated: string[] = [];
  return changeProjects(path, (state) => {
    let deferredMigration: true | undefined;
    const directoriesByGroup = new Map<string, Set<string>>();
    for (const { root, group, directory } of candidates) {
      if (!group || Object.hasOwn(state.assignments, root.id)) continue;
      const key = projectIdentityKey(group);
      const directories = directoriesByGroup.get(key) ?? new Set([group]);
      if (directory && ![...directories].some((folder) => samePath(directory, folder))) directories.add(directory);
      directoriesByGroup.set(key, directories);
    }
    for (const { root, members, group, directory } of candidates) {
      const unassigned = members.filter((member) => !Object.hasOwn(state.assignments, member.id));
      if (unassigned.length === 0) continue;
      if (members.some((member) => isBusy?.(member.id))) {
        deferredMigration = true;
        continue;
      }

      let projectId: string | null | undefined = state.assignments[root.id];
      if (projectId === undefined && group) {
        const matches = state.projects.find((project) => project.directories.some((folder) => samePath(folder, group)));
        // An existing project can have a manually limited folder list. A
        // sibling worktree outside it retains its own project and permissions.
        const outsideMatch = matches && directory && !isPathWithinRoots(directory, new Set(matches.directories));
        const rootDirectory = outsideMatch ? directory : group;
        const destination = outsideMatch
          ? state.projects.find((project) => project.directories.some((folder) => samePath(folder, directory)))
          : matches;
        if (destination) projectId = destination.id;
        else {
          projectId = randomUUID();
          const directories = outsideMatch ? [rootDirectory] : [...(directoriesByGroup.get(projectIdentityKey(group)) ?? [rootDirectory])];
          state.projects.push({ id: projectId, name: basename(rootDirectory) || rootDirectory, defaultDirectory: rootDirectory, directories });
        }
      }
      for (const member of unassigned) {
        state.assignments[member.id] = projectId ?? null;
        migrated.push(member.id);
      }
    }
    return { ...snapshotOf(state), ...(deferredMigration ? { deferredMigration } : {}) };
  }, () => {
    globalThis.__piAllowedRootsCache = undefined;
    afterWrite?.(migrated);
  }, () => migrated.length > 0);
}
