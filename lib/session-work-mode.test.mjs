import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { appendSessionPromptSelection, readSessionPromptSelection } = await jiti.import("./prompt-presets.ts");
const { appendSessionWorkMode, inheritSessionWorkMode, readSessionWorkMode } = await jiti.import("./session-work-mode.ts");
const tick = () => new Promise((resolve) => setImmediate(resolve));

const snapshot = {
  version: 2,
  mode: "auto",
  preset: { id: "saved", name: "Saved", content: "Snapshot, not today's global default." },
};
const readonly = ["read", "grep", "find", "ls"];
const configured = ["read", "grep", "edit"];
const toolNames = [...readonly, "edit", "bash", "write"];

function fixture(t, options = {}) {
  const { manager = SessionManager.inMemory(), ...wrapperOptions } = options;
  appendSessionPromptSelection(manager, snapshot);
  manager.appendMessage({
    role: "user", content: [{ type: "text", text: "Existing turn" }], timestamp: Date.now(),
  });
  const queued = [];
  let active = [...configured];
  let finishPrompt;
  let preflightError;
  const started = [];
  const inner = {
    sessionId: "session-1",
    get sessionFile() { return manager.getSessionFile(); },
    isBashRunning: false,
    isStreaming: false,
    settingsManager: { getDefaultTools: () => ["bash"], setProjectTrusted() {} },
    extensionRunner: {},
    sessionManager: manager,
    agent: { state: { systemPrompt: "SDK default" } },
    getContextUsage: () => undefined,
    getSteeringMessages: () => [],
    getFollowUpMessages: () => queued,
    getAllTools: () => toolNames.map((name) => ({ name })),
    getActiveToolNames: () => active,
    setActiveToolsByName: (names) => { active = [...names]; },
    async reload() { active = [...toolNames]; },
    clearQueue() { return { steering: [], followUp: queued.splice(0) }; },
    async followUp(message, _images, opts) {
      assert.equal(opts.source, "rpc");
      queued.push(message);
    },
    prompt(message, opts) {
      if (preflightError) return Promise.reject(new Error(preflightError));
      return new Promise((resolve) => {
        inner.isStreaming = true;
        started.push({ message, tools: [...active] });
        opts.preflightResult(true);
        finishPrompt = () => {
          inner.isStreaming = false;
          resolve();
        };
      });
    },
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner, { promptSelection: snapshot, ...wrapperOptions });
  t.after(() => wrapper.destroy());
  return {
    manager, inner, wrapper, started, queued,
    finish: async () => { finishPrompt(); await tick(); },
    failPreflight: (error) => { preflightError = error; },
  };
}

const modeState = (workMode, pendingWorkMode, workModeRevision) => ({ workMode, pendingWorkMode, workModeRevision });

test("reads legacy modes and session-wide records without changing the prompt snapshot", () => {
  const manager = SessionManager.inMemory();
  assert.deepEqual(readSessionWorkMode(manager.getEntries()), modeState("auto", null, 0));
  const legacy = { version: 1, mode: "goal", preset: null };
  appendSessionPromptSelection(manager, legacy);
  const oldBranch = manager.getLeafId();
  assert.deepEqual(readSessionWorkMode(manager.getEntries()), modeState("goal", null, 0));
  appendSessionWorkMode(manager, modeState("plan", "auto", 1));
  appendSessionWorkMode(manager, modeState("invalid", null, 2));
  manager.branch(oldBranch);
  assert.deepEqual(readSessionWorkMode(manager.getEntries()), modeState("plan", "auto", 1));
  assert.deepEqual(readSessionPromptSelection(manager.getEntries()), legacy);
});

test("copying an older branch inherits the source's current mode but not its pending mode", () => {
  const copy = SessionManager.inMemory();
  appendSessionPromptSelection(copy, snapshot);
  appendSessionWorkMode(copy, modeState("auto", "goal", 1));
  inheritSessionWorkMode(copy, "plan");
  assert.deepEqual(readSessionWorkMode(copy.getEntries()), modeState("plan", null, 2));
  assert.deepEqual(readSessionPromptSelection(copy.getEntries()), snapshot);
});

test("forking a branch before its first answer persists the source's effective mode", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "meteoragent-work-mode-test-"));
  const source = SessionManager.create(directory, directory);
  const { wrapper, manager } = fixture(t, { manager: source });
  wrapper.setActiveToolSelection(configured);
  const firstUserMessage = manager.getLeafId();
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Answer" }], timestamp: Date.now() });
  await wrapper.send({ type: "set_work_mode", mode: "plan" });
  const { cancelled, newSessionId } = await wrapper.send({ type: "fork_branch", entryId: firstUserMessage });
  assert.equal(cancelled, false);
  const copy = SessionManager.open(SessionManager.findById(directory, newSessionId, directory), directory);
  assert.deepEqual(readSessionWorkMode(copy.getEntries()), modeState("plan", null, 1));
  assert.deepEqual(readSessionPromptSelection(copy.getEntries()), snapshot);
  assert.equal(copy.getHeader().parentSession, source.getSessionFile());
  assert.equal(source.getEntries().filter((entry) => entry.type === "message").length, 2);
});

test("idle switch changes tool policy and full-prompt projection without changing the saved preset", async (t) => {
  const { wrapper, manager, inner } = fixture(t);
  wrapper.setActiveToolSelection(configured);
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  assert.deepEqual(await wrapper.send({ type: "set_work_mode", mode: "plan" }), modeState("plan", null, 1));
  assert.deepEqual(inner.getActiveToolNames(), ["read", "grep"]);
  assert.equal((await wrapper.send({ type: "get_tools" })).find((tool) => tool.name === "edit").configuredActive, true);
  assert.match((await wrapper.send({ type: "get_state" })).systemPrompt, /^Snapshot, .+\n\nYou are in Plan mode/);
  const projected = await inner.agent.transformContext([{ role: "system", content: "SDK base", timestamp: 1 }]);
  assert.match(projected[0].content, /^Snapshot,/);
  assert.match(projected[0].content, /You are in Plan mode/);
  assert.equal((await inner.agent.beforeToolCall({ toolCall: { name: "edit" } })).block, true);
  assert.equal(await inner.agent.beforeToolCall({ toolCall: { name: "grep" } }), undefined);
  await assert.rejects(wrapper.send({ type: "bash", command: "unexpected" }), /计划模式/);
  await assert.rejects(wrapper.send({ type: "steer", message: "/unexpected" }), /计划模式/);
  await assert.rejects(wrapper.send({ type: "prompt", message: "Explore", subagentMode: "on" }), /Subagents cannot be required/);

  const reopened = new AgentSessionWrapper(inner, { promptSelection: snapshot });
  t.after(() => reopened.destroy());
  assert.deepEqual(reopened.getWorkMode(), modeState("plan", null, 1));
  assert.deepEqual(await wrapper.send({ type: "set_work_mode", mode: "goal" }), modeState("goal", null, 2));
  assert.deepEqual(inner.getActiveToolNames(), configured);
  assert.equal(await wrapper.send({ type: "get_prompt_selection" }).then(({ selection }) => selection.preset.content), snapshot.preset.content);
  assert.deepEqual(readSessionPromptSelection(manager.getEntries()), snapshot);
  assert.deepEqual(events.filter((event) => event.type === "work_mode_changed").map((e) => e.workMode), ["plan", "goal"]);
});

test("running turns and queued follow-ups retain policy; mode applies on the next new message", async (t) => {
  const { wrapper, manager, inner, finish, started } = fixture(t);
  wrapper.setActiveToolSelection(configured, true);
  await wrapper.send({ type: "prompt", message: "First" });
  assert.deepEqual(await wrapper.send({ type: "set_work_mode", mode: "plan" }), modeState("auto", "plan", 1));
  assert.deepEqual(readSessionWorkMode(manager.getEntries()), modeState("auto", "plan", 1));
  assert.equal(await inner.agent.beforeToolCall({ toolCall: { name: "edit" } }), undefined);
  await wrapper.send({ type: "prompt", message: "Queued with old policy", streamingBehavior: "followUp" });
  assert.equal(started.length, 1);

  await finish();
  await assert.rejects(wrapper.send({ type: "prompt", message: "Too early" }), /撤回上一轮/);
  await assert.rejects(wrapper.send({ type: "prompt", message: "Raced queue", streamingBehavior: "followUp" }), /上一轮已结束/);
  assert.deepEqual(await wrapper.send({ type: "clear_queue" }), { steering: [], followUp: ["Queued with old policy"] });
  assert.deepEqual(wrapper.getWorkMode(), modeState("auto", "plan", 1));
  await wrapper.send({ type: "prompt", message: "Next" });
  assert.deepEqual(wrapper.getWorkMode(), modeState("plan", null, 2));
  assert.deepEqual(started, [{ message: "First", tools: configured }, { message: "Next", tools: readonly }]);
  assert.equal((await inner.agent.beforeToolCall({ toolCall: { name: "edit" } })).block, true);
  await finish();
});

test("preflight rejection retains pending mode and restores old policy", async (t) => {
  const { wrapper, inner, finish, failPreflight } = fixture(t);
  wrapper.setActiveToolSelection(configured);
  await wrapper.send({ type: "prompt", message: "First" });
  await wrapper.send({ type: "set_work_mode", mode: "plan" });
  await finish();
  failPreflight("test preflight failure");
  await assert.rejects(wrapper.send({ type: "prompt", message: "Second" }), /test preflight failure/);
  assert.deepEqual(wrapper.getWorkMode(), modeState("auto", "plan", 3));
  assert.deepEqual(inner.getActiveToolNames(), configured);
});

test("reloading tools during Plan keeps the configured selection for exiting Plan", async (t) => {
  const { wrapper, inner } = fixture(t);
  wrapper.setActiveToolSelection(configured);
  await wrapper.send({ type: "set_work_mode", mode: "plan" });
  await wrapper.send({ type: "reload" });
  assert.deepEqual(inner.getActiveToolNames(), ["read", "grep"]);
  await wrapper.send({ type: "set_work_mode", mode: "auto" });
  assert.deepEqual(inner.getActiveToolNames(), configured);
});

test("subagent work mode is immutable", async (t) => {
  const { wrapper } = fixture(t, { suppressCompletionNotifications: true });
  await assert.rejects(wrapper.send({ type: "set_work_mode", mode: "goal" }), /subagent cannot change/);
  assert.deepEqual(wrapper.getWorkMode(), modeState("auto", null, 0));
});
