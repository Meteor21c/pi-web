import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  assert.match(helper, /taskkill\.exe/);
  assert.match(helper, /launchctl/);
  assert.match(helper, /bin\", \"pi-web\.js/);
  assert.match(helper, /api\/relay-health/);
});
