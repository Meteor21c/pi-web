import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

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

function launchdCalls(currentPid, launcherPid, replacementPid) {
  const calls = [];
  const implementation = source.slice(source.indexOf("function managedLaunchAgentPid"), source.indexOf("function stopOldService"));
  const context = {
    payload: { launcherPid }, startedLauncherPid: replacementPid,
    launchdWasUnloaded: false,
    process: { platform: "darwin", getuid: () => 501 },
    join: (...parts) => parts.join("/"), homedir: () => "/home/test",
    existsSync: () => true, log() {},
    spawnSync: (_command, args) => {
      calls.push(args);
      return args[0] === "print" ? { status: 0, stdout: `job = {\n\tpid = ${currentPid}\n}` } : { status: 0 };
    },
  };
  vm.runInNewContext(`${implementation}; unloadLaunchAgent();`, context);
  return { calls, unloaded: context.launchdWasUnloaded };
}

test("updating an independent install leaves another macOS LaunchAgent running", () => {
  const value = launchdCalls(500, 600);
  assert.equal(value.unloaded, false);
  assert.equal(value.calls.some((args) => args[0] === "bootout"), false);
});

test("macOS update and rollback stop only their own managed launchers", () => {
  assert.equal(launchdCalls(500, 500).unloaded, true);
  assert.equal(launchdCalls(700, 500, 700).unloaded, true);
  assert.equal(launchdCalls(0, 500).unloaded, false);
});

test("the updater changes to its persistent backup folder before replacing the package", () => {
  const body = source.slice(source.indexOf("async function main()"));
  assert.ok(body.indexOf("process.chdir(backupDirectory)") < body.indexOf("packBackup()"));
  assert.ok(body.indexOf("process.chdir(backupDirectory)") < body.indexOf("stopOldService()"));
});
