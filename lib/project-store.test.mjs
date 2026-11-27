import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  createNamedProject,
  getActiveProjectRoots,
  getNamedProject,
  getProjectSnapshot,
  isProjectDirectory,
  migrateLegacyProjects,
  sessionProjectId,
  setSessionProjects,
  updateNamedProject,
} = await createJiti(import.meta.url).import("./project-store.ts");

function fixture() {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "magent-projects-")));
  const main = join(dir, "工作目录");
  const extra = join(dir, "附加目录");
  mkdirSync(main);
  mkdirSync(extra);
  return { dir, path: join(dir, "projects.json"), main, extra };
}

test("named projects retain several unique paths and remain editable when a disk is removed", async () => {
  const { dir, path, main, extra } = fixture();
  const { project } = await createNamedProject({
    name: " 项目 A ",
    defaultDirectory: main,
    directories: [extra, main, extra],
  }, path);
  assert.equal(project.name, "项目 A");
  assert.deepEqual(project.directories, [main, extra]);
  assert.equal(isProjectDirectory(extra, project), true);
  assert.equal(isProjectDirectory(dir, project), false);
  renameSync(extra, join(dir, "moved"));
  await updateNamedProject(project.id, { name: "项目新名字", directories: [main, extra] }, { path });
  assert.equal(getNamedProject(project.id, path).name, "项目新名字");
  assert.deepEqual(getNamedProject(project.id, path).directories, [main, extra]);
  assert.equal(isProjectDirectory(extra, project), false);
  symlinkSync(join(dir, "moved"), extra, "junction");
  await updateNamedProject(project.id, { directories: [main, extra] }, { path });
  assert.deepEqual(getNamedProject(project.id, path).directories, [main, extra]);
  assert.deepEqual([...getActiveProjectRoots(getNamedProject(project.id, path))], [main]);
  await assert.rejects(updateNamedProject(project.id, { directories: ["relative-folder"] }, { path }), /absolute folder path/);
  assert.deepEqual(getNamedProject(project.id, path).directories, [main, extra]);
});

test("concurrent assignments preserve named, independent, and legacy distinctions", async () => {
  const { path, main } = fixture();
  const { project } = await createNamedProject({ name: "First", defaultDirectory: main }, path);
  await Promise.all([
    setSessionProjects(["first-chat", "third-chat"], project.id, { path }),
    setSessionProjects(["independent-chat"], null, { path }),
    updateNamedProject(project.id, { name: "Renamed" }, { path }),
  ]);
  assert.equal(getProjectSnapshot(path).projects[0].name, "Renamed");
  assert.equal(sessionProjectId("first-chat", path), project.id);
  assert.equal(sessionProjectId("third-chat", path), project.id);
  assert.equal(sessionProjectId("independent-chat", path), null);
  assert.equal(sessionProjectId("legacy-chat", path), undefined);

  let runtimeClosed = false;
  await assert.rejects(setSessionProjects(["third-chat"], null, {
    path,
    beforeWrite: () => { throw new Error("Chat busy"); },
    afterWrite: () => { runtimeClosed = true; },
  }), /Chat busy/);
  assert.equal(sessionProjectId("third-chat", path), project.id);
  assert.equal(runtimeClosed, false);
});

test("an invalid project file is never silently overwritten", async () => {
  const { path, main } = fixture();
  writeFileSync(path, '{"version":2,"projects":[],"assignments":{}}');
  await assert.rejects(createNamedProject({ name: "Project", defaultDirectory: main }, path), /saved projects file is invalid/);
});

test("legacy chats migrate idempotently by directory while explicit assignments and transcripts stay intact", async () => {
  const { dir, path, main, extra } = fixture();
  const existing = (await createNamedProject({ name: "自定义项目", defaultDirectory: extra }, path)).project;
  await setSessionProjects(["explicit-project"], existing.id, { path });
  await setSessionProjects(["standalone"], null, { path });
  const removed = join(dir, "离线目录");
  const worktree = join(dir, "linked-worktree");
  mkdirSync(worktree);
  const transcript = join(dir, "legacy.jsonl");
  const persisted = JSON.stringify({ type: "session", id: "legacy-one", cwd: main }) + "\n";
  writeFileSync(transcript, persisted);
  const session = (id, cwd, projectRoot = cwd, relation) => ({ id, cwd, projectRoot, relation, modified: "2026-11-28T00:00:00.000Z", path: transcript });
  const sessions = [
    session("legacy-one", main), session("legacy-two", main), session("worktree", worktree, main),
    session("agent", main, main, { kind: "subagent", parentSessionId: "legacy-one" }),
    session("missing", removed), session("same-folder", extra),
    session("explicit-project", main), session("standalone", main),
  ];
  const results = await Promise.all(Array.from({ length: 2 }, () => migrateLegacyProjects(sessions, { path })));
  const snapshot = results[0];
  const migrated = snapshot.projects.find(({ name }) => name === "工作目录");
  assert.deepEqual(results[1], snapshot);
  assert.equal(snapshot.projects.length, 3);
  assert.deepEqual(migrated.directories, [main, worktree]);
  assert.equal(snapshot.assignments["legacy-one"], migrated.id);
  assert.equal(snapshot.assignments["legacy-two"], migrated.id);
  assert.equal(snapshot.assignments.worktree, migrated.id);
  assert.equal(snapshot.assignments.agent, migrated.id);
  assert.equal(snapshot.assignments["same-folder"], existing.id);
  assert.equal(snapshot.assignments["explicit-project"], existing.id);
  assert.equal(snapshot.assignments.standalone, null);
  const missing = snapshot.projects.find(({ name }) => name === "离线目录");
  assert.deepEqual(missing.directories, [removed]);
  assert.equal(snapshot.assignments.missing, missing.id);
  assert.equal(getActiveProjectRoots(missing).size, 0);
  assert.equal(readFileSync(transcript, "utf8"), persisted);
});

test("busy families defer together and an existing project never gains extra trusted roots", async () => {
  const { path, main, extra } = fixture();
  const { project } = await createNamedProject({ name: "现有项目", defaultDirectory: main }, path);
  const sessions = [
    { id: "main", cwd: main, projectRoot: main, modified: "" },
    { id: "busy", cwd: extra, projectRoot: main, modified: "" },
    { id: "child", cwd: extra, projectRoot: main, modified: "", relation: { kind: "subagent", parentSessionId: "busy" } },
  ];
  const changed = [];
  const first = await migrateLegacyProjects(sessions, {
    path,
    isBusy: (id) => id === "busy",
    afterWrite: (ids) => changed.push(...ids),
  });
  assert.equal(first.deferredMigration, true);
  assert.deepEqual(changed, ["main"]);
  assert.equal(first.assignments.main, project.id);
  assert.equal(first.assignments.busy, undefined);
  assert.equal(first.assignments.child, undefined);
  const finished = await migrateLegacyProjects(sessions, { path });
  assert.equal(finished.deferredMigration, undefined);
  assert.deepEqual(getNamedProject(project.id, path).directories, [main]);
  assert.notEqual(finished.assignments.busy, project.id);
  assert.equal(finished.assignments.busy, finished.assignments.child);
  assert.deepEqual(getNamedProject(finished.assignments.busy, path).directories, [extra]);
});
