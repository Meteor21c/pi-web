import assert from "node:assert/strict";
import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { buildSessionContext } = await jiti.import("./session-reader.ts");
const { deleteSessionWithGoal, updateSessionGoal } = await jiti.import("./session-goal.ts");
const { appendSessionPromptSelection, readSessionPromptSelection } = await jiti.import("./prompt-presets.ts");
const { appendSessionWorkMode, appendUserTurnMetadata, inheritSessionWorkMode, readSessionWorkMode } = await jiti.import("./session-work-mode.ts");
const { startsUserTurn } = await jiti.import("./message-display.ts");
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
  let receiveEvent;
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
    getAllTools: () => toolNames.map((name) => ({ name, sourceInfo: { source: "builtin", path: `builtin:${name}` } })),
    getActiveToolNames: () => active,
    setActiveToolsByName: (names) => { active = [...names]; },
    async reload() { active = [...toolNames]; },
    subscribe(listener) {
      receiveEvent = listener;
      return () => { receiveEvent = undefined; };
    },
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
        opts.preflightResult("started");
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
    emit: (event) => receiveEvent(event),
    finish: async () => { finishPrompt(); await tick(); },
    failPreflight: (error) => { preflightError = error; },
    deliverUser: (text) => {
      const message = { role: "user", content: text, timestamp: Date.now() };
      receiveEvent({ type: "message_end", message });
      return manager.appendMessage(message);
    },
  };
}

const modeState = (workMode, pendingWorkMode, workModeRevision) => ({ workMode, pendingWorkMode, workModeRevision });

test("live turn labels survive branch copies and ignore pending mode changes", async (t) => {
  const { wrapper, manager, inner, deliverUser } = fixture(t);
  wrapper.start();
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  await wrapper.send({ type: "set_work_mode", mode: "plan" });
  const planId = deliverUser("Plan first");
  inner.isStreaming = true;
  await wrapper.send({ type: "set_work_mode", mode: "goal" });
  const queuedId = deliverUser("Queued while planning");
  inner.isStreaming = false;
  await wrapper.send({ type: "set_work_mode", mode: "goal" });
  const goalId = deliverUser("Work on the goal");
  await wrapper.send({ type: "set_work_mode", mode: "auto" });
  const autoId = deliverUser("Ask a question");
  assert.deepEqual(events.filter((event) => event.type === "message_end").map((event) => event.turnWorkMode),
    ["plan", "plan", "goal", "auto"]);

  for (const [id, mode] of [[planId, "plan"], [queuedId, "plan"], [goalId, "goal"], [autoId, undefined]]) {
    assert.equal(buildSessionContext(manager.getEntries(), id, { tail: 1 }).messages[0].turnWorkMode, mode);
  }

  // Fork from an earlier leaf after changing mode in a sibling branch.
  manager.branch(planId);
  await wrapper.send({ type: "set_work_mode", mode: "plan" });
  const laterPlanId = deliverUser("Continue on a different branch");
  assert.deepEqual(
    buildSessionContext(manager.getEntries(), laterPlanId).messages.map((message) => message.turnWorkMode),
    [undefined, "plan", "plan"],
  );
  manager.createBranchedSession(laterPlanId);
  assert.deepEqual(
    buildSessionContext(manager.getEntries(), manager.getLeafId()).messages.map((message) => message.turnWorkMode),
    [undefined, "plan", "plan"],
  );
});

test("existing conversations show the historical mode at each turn, including old pages", () => {
  const manager = SessionManager.inMemory();
  appendSessionPromptSelection(manager, { ...snapshot, mode: "plan" });
  manager.appendMessage({ role: "user", content: "Original plan", timestamp: 1 });
  appendSessionWorkMode(manager, modeState("plan", "goal", 1));
  manager.appendMessage({ role: "user", content: "Queued follow-up", timestamp: 2 });
  appendSessionWorkMode(manager, modeState("goal", null, 2));
  const goalId = manager.appendMessage({ role: "user", content: "Switch to goal", timestamp: 3 });
  appendSessionWorkMode(manager, modeState("auto", null, 3));
  const autoId = manager.appendMessage({ role: "user", content: "Ordinary question", timestamp: 4 });
  const entries = manager.getEntries();
  assert.deepEqual(buildSessionContext(entries, autoId).messages.map((message) => message.turnWorkMode),
    ["plan", "plan", "goal", undefined]);
  assert.equal(buildSessionContext(entries, goalId, { tail: 1 }).messages[0].turnWorkMode, "goal");
});

test("steering stays inside its turn in saved history, including pages without the marker", () => {
  const manager = SessionManager.inMemory();
  const appendUser = (content) => manager.appendMessage({ role: "user", content, timestamp: 1 });
  appendUserTurnMetadata(manager, "goal", false);
  appendUser("Start the task");
  appendUserTurnMetadata(manager, "goal", true);
  const steeringId = appendUser("Add an instruction");
  appendUserTurnMetadata(manager, "goal", true);
  appendUser("Add another instruction");
  appendUserTurnMetadata(manager, "goal", false);
  const followUpId = appendUser("Add another instruction");

  const entries = manager.getEntries();
  const { messages } = buildSessionContext(entries, followUpId);
  assert.deepEqual(messages.map(startsUserTurn), [true, false, false, true]);
  assert.deepEqual(messages.map((message) => message.turnWorkMode), ["goal", "goal", "goal", "goal"]);
  const page = buildSessionContext(entries, steeringId, { tail: 1 });
  assert.equal(page.hasMore, true);
  assert.equal(page.messages[0].isSteering, true);
});

test("a running goal keeps its starting objective until the next independent run", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "meteoragent-goal-mode-test-"));
  const manager = SessionManager.create(directory, directory);
  const file = manager.getSessionFile();
  t.after(async () => {
    await deleteSessionWithGoal(file);
    rmdirSync(directory);
  });
  const { wrapper, inner, emit } = fixture(t, { manager });
  wrapper.start();
  await wrapper.send({ type: "set_work_mode", mode: "goal" });
  wrapper.persistUnflushedSession();
  const save = (action, expectedRevision) => updateSessionGoal(file, { action, expectedRevision });
  const project = async () => {
    const messages = await inner.agent.transformContext([
      { role: "system", content: "SDK base", timestamp: 1 },
      { role: "user", content: "Continue working", timestamp: 2 },
    ]);
    const user = messages.at(-1);
    return Array.isArray(user.content) ? user.content[0].text : undefined;
  };

  await save({ type: "set", objective: "Initial objective" }, null);
  inner.isStreaming = true;
  emit({ type: "agent_start" });
  assert.match(await project(), /Initial objective/);
  await save({ type: "set", objective: "Revised objective" }, 1);
  emit({ type: "agent_start" }); // SDK continuation, still inside the same run.
  assert.match(await project(), /Initial objective/);
  inner.isStreaming = false;
  emit({ type: "agent_settled" });

  inner.isStreaming = true;
  emit({ type: "agent_start" });
  assert.match(await project(), /Revised objective/);
  await save({ type: "cancel" }, 2);
  assert.match(await project(), /Revised objective/);
  inner.isStreaming = false;
  emit({ type: "agent_settled" });

  emit({ type: "agent_start" });
  assert.equal(await project(), undefined);
});

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
  assert.equal(projected[0].sections?.meteoragentReplyGuidance, undefined);
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
