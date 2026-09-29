import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { deleteProjectFile } = await createJiti(import.meta.url).import("./file-mutations.ts");

test("deletes only regular files whose parent stays inside an allowed root", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-file-delete-"));
  const allowed = path.join(base, "project");
  const outside = path.join(base, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  const regularFile = path.join(allowed, "remove-me.txt");
  const outsideFile = path.join(outside, "keep-me.txt");
  const outsideLink = path.join(allowed, "outside-link.txt");
  const nestedDirectory = path.join(allowed, "folder");
  fs.writeFileSync(regularFile, "delete");
  fs.writeFileSync(outsideFile, "keep");
  fs.symlinkSync(outsideFile, outsideLink);
  fs.mkdirSync(nestedDirectory);
  t.after(() => {
    for (const filePath of [regularFile, outsideFile, outsideLink]) {
      if (fs.existsSync(filePath) || fs.lstatSync(filePath, { throwIfNoEntry: false })) fs.unlinkSync(filePath);
    }
    fs.rmdirSync(nestedDirectory);
    fs.rmdirSync(allowed);
    fs.rmdirSync(outside);
    fs.rmdirSync(base);
  });

  const roots = new Set([allowed]);
  assert.deepEqual(deleteProjectFile(regularFile, roots), { ok: true });
  assert.equal(fs.existsSync(regularFile), false);
  assert.deepEqual(deleteProjectFile(outsideFile, roots), { ok: false, status: 403, error: "Access denied" });
  assert.deepEqual(deleteProjectFile(nestedDirectory, roots), { ok: false, status: 400, error: "Only regular files can be deleted" });
  assert.deepEqual(deleteProjectFile(outsideLink, roots), { ok: false, status: 400, error: "Only regular files can be deleted" });
  assert.equal(fs.readFileSync(outsideFile, "utf8"), "keep");
});
