import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const route = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const manager = await readFile(new URL("../../../lib/app-restart-manager.ts", import.meta.url), "utf8");
const helper = await readFile(new URL("../../../bin/app-restarter.js", import.meta.url), "utf8");

test("protects restart requests and derives targets from the current process", () => {
  assert.match(route, /isApiRequestAllowed\(request\)/g);
  assert.match(route, /hasJsonContentType\(request\)/);
  assert.doesNotMatch(route, /request\.json\(\)|request\.arrayBuffer\(\)/);
  assert.doesNotMatch(route, /body\.pid|body\.packageRoot|body\.serverPid/);
  assert.match(manager, /METEORAGENT_LAUNCHER_PID/);
  assert.match(manager, /METEORAGENT_PACKAGE_ROOT/);
});

test("hands restart to a detached cross-platform helper", () => {
  assert.match(manager, /detached: true/);
  assert.match(manager, /app-restarter\.js/);
  assert.match(helper, /launchctl/);
  assert.match(helper, /bin\", \"pi-web\.js/);
  assert.match(helper, /api\/relay-health/);
});

test("stops the old Windows launcher and server without killing their detached restarter", () => {
  const stop = helper.slice(helper.indexOf("function stopOldService()"), helper.indexOf("function directStart()"));
  const kills = [];
  runInNewContext(`${stop}\nstopOldService();`, {
    process: {
      platform: "win32",
      kill: (pid, signal) => kills.push([pid, signal]),
    },
    payload: { launcherPid: 123, serverPid: 456 },
    unloadLaunchAgent: () => false,
    log: () => {},
  });
  assert.deepEqual(kills, [[123, "SIGTERM"], [456, "SIGTERM"]]);
});
