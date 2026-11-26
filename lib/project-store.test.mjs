import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
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
