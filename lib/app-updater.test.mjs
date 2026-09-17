import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../bin/app-updater.js", import.meta.url), "utf8");

test("rollback stops the failed replacement before reinstalling the backup", () => {
  const catchBlock = source.slice(source.indexOf("update failed:"), source.indexOf("rollback failed:"));
  assert.ok(catchBlock.indexOf("await stopReplacementService()") < catchBlock.indexOf("install(backupPath)"));
  assert.match(catchBlock, /installedVersion\(\) !== previousVersion/);
  assert.match(catchBlock, /waitForHealthy\(previousVersion\)/);
});

test("Windows rollback stops the entire replacement process tree", () => {
  assert.match(source, /taskkill\.exe/);
  assert.match(source, /"\/T", "\/F"/);
});

test("reuses the launcher's user-writable npm prefix for install and rollback", () => {
  assert.match(source, /METEORAGENT_NPM_PREFIX/);
  assert.match(source, /args\.push\("--prefix", npmPrefix\)/);
});
