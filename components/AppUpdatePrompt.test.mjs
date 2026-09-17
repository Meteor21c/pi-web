import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppUpdatePrompt.tsx", import.meta.url), "utf8");

test("the global update prompt uses the automatic install endpoint and health-based reload", () => {
  assert.match(source, /\/api\/app-update\/install/);
  assert.match(source, /\/api\/relay-health/);
  assert.match(source, /window\.location\.reload\(\)/);
  assert.match(source, /current\?\.phase === "preparing-restart" && next\.phase === "idle"/);
});

test("the update prompt checks again while a long-running app remains open", () => {
  assert.match(source, /setInterval\(checkForUpdate, UPDATE_CHECK_INTERVAL_MS\)/);
  assert.match(source, /visibilitychange/);
});

test("the update prompt describes preserved data and blocks active-task updates", () => {
  assert.match(source, /appUpdate\.dataSafe/);
  assert.match(source, /runningCount > 0/);
  assert.match(source, /disabled=\{installing \|\| runningCount > 0\}/);
});
