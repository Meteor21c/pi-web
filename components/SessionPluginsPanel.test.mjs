import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionPluginsPanel.tsx", import.meta.url), "utf8");

test("only exposes session-mode plugins as editable session toggles", () => {
  assert.match(source, /pkg\.activationMode === "session" && pkg\.globalEnabled/);
  assert.match(source, /pkg\.activationMode === "global" \|\| !pkg\.globalEnabled/);
  assert.match(source, /className="session-plugin-row is-readonly"/);
  assert.match(source, /className="session-plugin-row is-editable"/);
});

test("persists a session selection and requires an explicit reload", () => {
  assert.match(source, /fetch\("\/api\/plugins\/session"/);
  assert.match(source, /sendAgentCommand\(sessionId, \{ type: "reload" \}\)/);
  assert.match(source, /sessionRunning \|\| reloadBusy/);
  assert.match(source, /重载会话后才会生效/);
});

test("explains that a new conversation starts with local plugins off", () => {
  assert.match(source, /局部插件在新会话中默认关闭/);
  assert.match(source, /Per-session plugins start off in new sessions/);
  assert.match(source, /disabled=\{!sessionId \|\| busy\}/);
});
