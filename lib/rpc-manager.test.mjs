import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, getCurrentTools, getSupportedThinkingLevels, getSystemMessageText } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { writeModelsConfig } = await jiti.import("./models-config-store.ts");
const { buildSessionContext, persistPreparedSession } = await jiti.import("./session-reader.ts");
const { readSessionGoal, updateSessionGoal, updateSessionGoalFromRun } = await jiti.import("./session-goal.ts");
const { createSubagentExtension, subagentToolDetails } = await jiti.import("./subagent-extension.ts");
const { createSubagentController } = await jiti.import("./subagent-runtime.ts");
const { USER_QUESTION_TOOL } = await jiti.import("./user-questions.ts");

async function createGoalRunFixture(t, mode = "goal", {
  previousOutcome,
  message = "Work on this goal",
  handled = false,
  chatOnly = false,
  childSession = false,
  subagentMode,
  thinkingLevel,
  activeTools = [],
  hasAgent = false,
  supportedThinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "magent-goal-run-"));
  const manager = SessionManager.create(root, root);
  const sessionFile = manager.getSessionFile();
  let receive;
  let finishPrompt;
  let boundary;
  let onAgentStart;
  let reportTool;
  let ui;
  let deliverPrompt;
  const availableTools = [...activeTools, ...(hasAgent ? ["Agent"] : [])].map((name) => ({ name }));
  const delivered = new Promise((resolve) => { deliverPrompt = resolve; });
  const inner = {
    sessionManager: manager,
    sessionFile,
    sessionId: manager.getSessionId(),
    agent: { state: {} },
    isStreaming: false,
    subscribe(listener) { receive = listener; return () => {}; },
    async bindExtensions(options) { ui = options.uiContext; },
    settingsManager: SettingsManager.inMemory(),
    getActiveToolNames() { return activeTools; },
    getAllTools() { return availableTools; },
    setActiveToolsByName(names) { activeTools = names; },
    getAvailableThinkingLevels() { return supportedThinkingLevels; },
    setThinkingLevel(level) {
      inner.agent.state.thinkingLevel = level;
      manager.appendThinkingLevelChange(level);
    },
    async prompt(text, { preflightResult }) {
      if (handled) {
        preflightResult("handled");
        return;
      }
      inner.isStreaming = true;
      preflightResult("started");
      const startEvent = { type: "agent_start" };
      await onAgentStart?.(startEvent);
      receive(startEvent);
      receive({ type: "message_end", message: { role: "user", content: text } });
      await new Promise((resolve) => {
        finishPrompt = resolve;
        deliverPrompt();
      });
    },
    abort() { stop(); },
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner, {
    chatOnly, suppressCompletionNotifications: childSession, promptSelection: { version: 2, preset: null, mode },
  });
  t.after(async () => {
    wrapper.destroy();
    await unlink(`${sessionFile}.goal.json`);
    await unlink(sessionFile);
    await rmdir(root);
  });
  await updateSessionGoal(sessionFile, { action: { type: "set", objective: "Verify the fixture" }, expectedRevision: null },
    () => wrapper.persistUnflushedSession());
  if (previousOutcome) await updateSessionGoalFromRun(sessionFile, 1, previousOutcome);
  await AgentSessionWrapper.goalExtension(() => wrapper).factory({
    on(name, handler) {
      if (name === "agent_before_settle") boundary = handler;
      if (name === "agent_start") onAgentStart = handler;
    },
    registerTool(tool) { reportTool = tool; },
  });
  wrapper.start();
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  if (!childSession) await wrapper.send({ type: "set_work_mode", mode });
  if (thinkingLevel) await wrapper.send({ type: "set_thinking_level", level: thinkingLevel });
  const events = [];
  const completed = new Promise((resolve) => {
    wrapper.onEvent((event) => {
      events.push(event);
      if (event.type === "prompt_done") resolve();
    });
  });
  await wrapper.send({ type: "prompt", message, subagentMode });
  if (!handled) await Promise.race([delivered, completed]);
  function stop() {
    inner.isStreaming = false;
    receive({ type: "agent_settled" });
    finishPrompt();
  }
  return {
    wrapper, inner, sessionFile, reportTool, ui, events, receive,
    reply: (content, stopReason = "stop") =>
      receive({ type: "message_end", message: { role: "assistant", provider: "test", model: "fixture", stopReason, content } }),
    toolResult: (message) => receive({ type: "message_end", message: { role: "toolResult", ...message } }),
    boundary: (pendingMessages = [], overrides = {}) =>
      boundary({ outcome: "completed", continue: false, entries: [], context: { pendingMessages }, ...overrides }),
    finish: async () => { stop(); await completed; return readSessionGoal(sessionFile); },
    completed,
  };
}

const delegationFixtureTools = ["bash", "read", "edit", "write"];
const delegationFixtureReply = [{ type: "text", text: "Verified the fixture." }];

async function getDelegationPrompt(run) {
  const projected = await run.inner.agent.transformContext([
    { role: "system", content: "", timestamp: 1, toolsAdded: run.inner.getActiveToolNames().map((name) => ({ name })) },
    { role: "user", content: "Verify the fixture", timestamp: 2 },
  ]);
  return projected.filter((message) => message.role === "system").map(getSystemMessageText).join("\n");
}

test("high reasoning in Auto prioritizes early parallel work and never retries to fill a quota", async (t) => {
  for (const thinkingLevel of ["high", "xhigh", "max"]) {
    await t.test(thinkingLevel, async (t) => {
      const run = await createGoalRunFixture(t, "auto", {
        activeTools: delegationFixtureTools, hasAgent: true, thinkingLevel, subagentMode: "auto",
      });

      assert.ok(run.inner.getActiveToolNames().includes("Agent"));
      const guidance = await getDelegationPrompt(run);
      assert.match(guidance, /use Agent early/i);
      assert.match(guidance, /start your own part immediately/i);
      assert.doesNotMatch(guidance, /call Agent at least once/i);
      run.reply(delegationFixtureReply);
      assert.equal(run.boundary(), undefined);
      await run.finish();
      assert.equal(run.events.some((event) => event.type === "subagent_required_unmet"), false);
    });
  }
});

test("ordinary delegation, explicit Off, and restricted sessions keep their existing behavior", async (t) => {
  const cases = [
    { label: "medium remains optional", thinkingLevel: "medium", visible: true },
    { label: "provider Auto remains optional", thinkingLevel: "auto", visible: true },
    { label: "an unsupported Max selection falls back to provider Auto", supportedThinkingLevels: ["off"], visible: true },
    { label: "explicit Off overrides Max", subagentMode: "off", visible: false },
    { label: "the runtime has no Agent tool", hasAgent: false, visible: false },
    { label: "read-only tool preset", activeTools: ["read", "grep", "find", "ls"], visible: false },
    { label: "plan mode", mode: "plan", visible: false },
    { label: "chat only", chatOnly: true, visible: false },
    { label: "child session", childSession: true, visible: false },
  ];
  for (const { label, mode = "auto", visible, ...options } of cases) {
    await t.test(label, async (t) => {
      const run = await createGoalRunFixture(t, mode, {
        activeTools: delegationFixtureTools, hasAgent: true, thinkingLevel: "max", subagentMode: "auto", ...options,
      });
      const tools = run.inner.getActiveToolNames();
      assert.equal(tools.includes("Agent"), visible);
      assert.doesNotMatch(await getDelegationPrompt(run), /use Agent early|call Agent at least once/i);
      run.reply(delegationFixtureReply);
      assert.equal(run.boundary(), undefined);
      await run.finish();
      assert.equal(run.events.some((event) => event.type === "subagent_required_unmet"), false);
    });
  }
});

test("explicit Force still requires delegation with medium reasoning", async (t) => {
  const run = await createGoalRunFixture(t, "auto", {
    activeTools: delegationFixtureTools, hasAgent: true, thinkingLevel: "medium", subagentMode: "on",
  });
  assert.match(await getDelegationPrompt(run), /call Agent at least once/i);
  run.reply(delegationFixtureReply);
  assert.equal(run.boundary(), undefined);
  await run.finish();
  assert.equal(run.events.filter((event) => event.type === "subagent_required_unmet").length, 1);
});

function scheduleFixtureSubagent(run, name = "fixture-child") {
  const child = {
    sessionId: name, parentToolCallId: `launch-${name}`, status: "queued",
    description: name, profile: "general", runInBackground: true,
  };
  let finish;
  const completion = new Promise((resolve) => { finish = resolve; });
  run.wrapper.subagentTask.track(child, completion);
  run.wrapper.publishSubagentStatus(child);
  return (status = "completed", result = `Result from ${name}`) => {
    const outcome = { ...child, status, result, ...(status === "failed" ? { error: result } : {}) };
    run.wrapper.publishSubagentStatus(outcome);
    finish(outcome);
    return outcome;
  };
}

test("the parent joins unread outcomes in one hidden continuation", async (t) => {
  const run = await createGoalRunFixture(t, "auto", {
    activeTools: delegationFixtureTools, hasAgent: true, thinkingLevel: "max", subagentMode: "auto",
  });
  const finishFirst = scheduleFixtureSubagent(run, "first");
  const finishSecond = scheduleFixtureSubagent(run, "second");
  assert.doesNotMatch(await getDelegationPrompt(run), /use Agent early/i);
  run.reply(delegationFixtureReply);
  const boundary = run.boundary();
  assert.equal(run.wrapper.runActivity.waitingForSubagents, true);
  finishSecond("failed", "Second worker failed");
  await Promise.resolve();
  assert.equal(run.wrapper.runActivity.waitingForSubagents, true);
  finishFirst();
  const joined = await boundary;
  assert.equal(joined.continue, true);
  assert.equal(joined.entries.length, 1);
  assert.equal(joined.entries[0].customType, "meteoragent:subagent-results");
  assert.equal(joined.entries[0].display, false);
  assert.match(joined.entries[0].content, /Result from first/);
  assert.match(joined.entries[0].content, /Second worker failed/);
  assert.equal(run.wrapper.runActivity.waitingForSubagents, undefined);
  assert.equal(run.boundary(), undefined);
  await run.finish();
  assert.equal(run.events.filter((event) => event.type === "subagent_status").length, 4);
  assert.equal(run.events.some((event) => event.type === "subagent_required_unmet"), false);
});

test("high reasoning delegation respects terminal and pending-work boundaries", async (t) => {
  const run = await createGoalRunFixture(t, "auto", {
    activeTools: delegationFixtureTools, hasAgent: true, thinkingLevel: "max", subagentMode: "auto",
  });
  run.reply(delegationFixtureReply);
  assert.equal(run.boundary([{ role: "user", content: "Next task" }]), undefined);
  assert.equal(run.boundary([], { continue: true }), undefined);
  assert.equal(run.boundary([], { outcome: "aborted" }), undefined);
  run.reply([], "error");
  assert.equal(run.boundary(), undefined);
  await run.finish();
  assert.equal(run.events.some((event) => event.type === "subagent_required_unmet"), false);
});

test("a Goal completion is rechecked after new work and requires results in model context", async (t) => {
  const run = await createGoalRunFixture(t, "goal", {
    activeTools: delegationFixtureTools, hasAgent: true, thinkingLevel: "max", subagentMode: "auto",
  });
  await run.reportTool.execute("complete", { status: "complete", detail: "Initial review appeared complete." });
  const finishChild = scheduleFixtureSubagent(run);
  const complete = { status: "complete", detail: "Checked the child result against the fixture." };
  await assert.rejects(run.reportTool.execute("complete", complete), /review outstanding subagent results/i);

  const child = finishChild();
  const toolResult = { role: "toolResult", toolName: "get_subagent_result", details: subagentToolDetails(child), content: [] };
  run.toolResult(toolResult);
  await assert.rejects(run.reportTool.execute("complete", complete), /review outstanding subagent results/i);
  await run.inner.agent.transformContext([{ role: "system", content: "", timestamp: 1 }, toolResult]);
  await run.reportTool.execute("complete", complete);
  run.reply(delegationFixtureReply);
  assert.equal(run.boundary(), undefined);
  const goal = await run.finish();
  assert.equal(goal.status, "completed");
  assert.equal(goal.evidence, complete.detail);
});

test("editing a Goal during the join releases the wait and preserves the new revision", async (t) => {
  const run = await createGoalRunFixture(t, "goal", {
    activeTools: delegationFixtureTools, hasAgent: true, subagentMode: "auto",
  });
  const finishChild = scheduleFixtureSubagent(run);
  run.reply(delegationFixtureReply);
  const boundary = run.boundary();
  assert.equal(run.wrapper.runActivity.waitingForSubagents, true);
  const next = await updateSessionGoal(run.sessionFile, {
    action: { type: "set", objective: "Inspect another fixture" }, expectedRevision: 1,
  });
  run.wrapper.onUserGoalChange(next.goal);
  assert.equal(await boundary, undefined);
  const task = run.wrapper.subagentTask;
  assert.deepEqual(await run.finish(), next.goal);
  assert.equal(task.signal.aborted, true);
  finishChild("aborted");
});

test("high-effort Auto waits for user or mode changes without a delegation warning", async (t) => {
  const options = { activeTools: delegationFixtureTools, hasAgent: true, thinkingLevel: "max", subagentMode: "auto" };
  await t.test("a goal needs an answer", async (t) => {
    const run = await createGoalRunFixture(t, "goal", options);
    await run.reportTool.execute("blocked", {
      status: "blocked", detail: "Two fixtures match.", userAction: "Which fixture should I verify?",
    });
    run.reply([{ type: "text", text: "Which fixture should I verify?" }]);
    assert.equal(run.boundary(), undefined);
    assert.equal((await run.finish()).status, "blocked");
    assert.equal(run.events.some((event) => event.type === "subagent_required_unmet"), false);
  });
  await t.test("a new mode is pending", async (t) => {
    const run = await createGoalRunFixture(t, "auto", options);
    run.reply(delegationFixtureReply);
    await run.wrapper.send({ type: "set_work_mode", mode: "plan" });
    assert.equal(run.boundary(), undefined);
    await run.finish();
    assert.equal(run.events.some((event) => event.type === "subagent_required_unmet"), false);
  });
  await t.test("a confirmation was refused", async (t) => {
    const run = await createGoalRunFixture(t, "auto", options);
    const confirmation = run.ui.confirm("Change file", "Allow the operation?");
    const request = run.events.find((event) => event.type === "extension_ui_request");
    assert.ok(request);
    await run.wrapper.send({ type: "extension_ui_response", id: request.id, confirmed: false });
    assert.equal(await confirmation, false);
    run.reply(delegationFixtureReply);
    assert.equal(run.boundary(), undefined);
    await run.finish();
    assert.equal(run.events.some((event) => event.type === "subagent_required_unmet"), false);
  });
});

test("the pinned Pi runtime settles a direct High Auto answer on the first model request", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "magent-sdk-delegation-"));
  const manager = SessionManager.create(root, root);
  const authPath = join(root, "auth.json");
  const modelRuntime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
  await modelRuntime.setRuntimeApiKey("openai", "mock");
  const fixtureModel = modelRuntime.getModel("openai", "gpt-4.1");
  assert.ok(fixtureModel);
  const model = { ...fixtureModel, reasoning: true };
  const host = {};
  const stubAgent = (pi) => pi.registerTool({
    name: "Agent",
    label: "Agent",
    description: "Mock subagent tool",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "Mock result" }], details: {} }),
  });
  const services = await createAgentSessionServices({
    cwd: root, agentDir: root, modelRuntime,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
    resourceLoaderOptions: { noExtensions: true, extensionFactories: [stubAgent, AgentSessionWrapper.goalExtension(() => host.wrapper)] },
  });
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model });
  const captures = [];
  session.agent.streamFunction = (_model, context) => {
    captures.push(structuredClone(context.messages));
    const message = {
      role: "assistant", content: delegationFixtureReply,
      api: model.api, provider: model.provider, model: model.id,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now(),
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message });
    return stream;
  };
  const wrapper = new AgentSessionWrapper(session);
  host.wrapper = wrapper;
  t.after(async () => {
    await wrapper.shutdown();
    await unlink(manager.getSessionFile());
    await unlink(authPath);
    await rmdir(root);
  });
  wrapper.start();
  wrapper.beginExtensionBinding();
  assert.equal((await wrapper.send({ type: "set_thinking_level", level: "high" })).thinkingLevel, "high");

  const events = [];
  const done = new Promise((resolve) => wrapper.onEvent((event) => {
    events.push(event.type);
    if (event.type === "prompt_done") resolve();
  }));
  await wrapper.send({ type: "prompt", message: "Verify the fixture", subagentMode: "auto" });
  await done;

  assert.equal(captures.length, 1);
  for (const messages of captures) {
    assert.ok(getCurrentTools(messages).some(({ name }) => name === "Agent"));
    const prompt = messages.filter((message) => message.role === "system").map(getSystemMessageText).join("\n");
    assert.match(prompt, /use Agent early/i);
  }
  const entries = manager.getEntries();
  assert.equal(entries.filter((entry) => entry.type === "message" && entry.message.role === "user").length, 1);
  assert.equal(entries.filter((entry) => entry.type === "custom_message" && entry.customType === "meteoragent:turn-timing").length, 1);
  const retries = entries.filter((entry) => entry.type === "custom_message" && entry.customType === "meteoragent:subagent-retry");
  assert.equal(retries.length, 0);
  assert.equal(events.filter((type) => type === "subagent_required_unmet").length, 0);
  assert.equal(events.filter((type) => type === "agent_settled").length, 1);
});

function fixtureTool(id, name, args = {}) {
  return { type: "toolCall", id, name, arguments: args };
}

function fixtureStream(model, content, reason = content.some(({ type }) => type === "toolCall") ? "toolUse" : "stop") {
  const stream = createAssistantMessageEventStream();
  const message = {
    role: "assistant", content, stopReason: reason,
    api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  if (reason === "aborted" || reason === "error") {
    stream.push({ type: "error", reason, error: { ...message, errorMessage: "Fixture worker failed" } });
  } else {
    stream.push({ type: "done", reason, message });
  }
  return stream;
}

async function createParallelSdkFixture(t, { maxConcurrent = 2, workMode = "auto", reply }) {
  const root = await mkdtemp(join(tmpdir(), "magent-parallel-run-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const settingsPath = join(root, "agents", "settings.json");
  await mkdir(dirname(settingsPath));
  await writeFile(settingsPath, JSON.stringify({ maxConcurrent }));
  const manager = SessionManager.create(root, root);
  const sessionFile = manager.getSessionFile();
  const authPath = join(root, "auth.json");
  const modelRuntime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
  await modelRuntime.setRuntimeApiKey("openai", "mock");
  const model = { ...modelRuntime.getModel("openai", "gpt-4.1"), reasoning: true };
  const workers = new Map();
  const captures = [];
  const events = [];
  let wrapper;
  let childDirectory;
  const controller = createSubagentController({
    getSession: (id) => id === manager.getSessionId() ? wrapper : workers.get(id),
    registerSession(inner) {
      const worker = {
        inner,
        sessionFile: inner.sessionFile,
        isAlive: () => true,
        isRunning: () => inner.isStreaming,
        waitUntilReady: async () => {},
        requested: false,
        release: undefined,
      };
      workers.set(inner.sessionId, worker);
      childDirectory = dirname(inner.sessionFile);
      inner.agent.streamFunction = (physicalModel, _context, { signal }) => {
        worker.requested = true;
        return new Promise((resolve) => {
          const abort = () => worker.release("aborted");
          worker.release = (reason = "stop") => {
            signal?.removeEventListener("abort", abort);
            resolve(fixtureStream(physicalModel, [{ type: "text", text: `Checked ${inner.sessionManager.getSessionName()}` }], reason));
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      };
    },
    reopenSession: async () => { throw new Error("An owned task must not reopen its parent"); },
    resolveSessionPath: async () => null,
    invalidateSessionList: () => {},
    subagentMode: () => wrapper.effectiveSubagentMode(),
    subagentTask: () => wrapper.subagentTask,
    publishStatus: (run) => wrapper.publishSubagentStatus(run),
  });
  const services = await createAgentSessionServices({
    cwd: root, agentDir: root, modelRuntime,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
    resourceLoaderOptions: { noExtensions: true, extensionFactories: [
      createSubagentExtension(controller.extensionRuntime, () => []),
      AgentSessionWrapper.goalExtension(() => wrapper),
    ] },
  });
  const { session } = await createAgentSessionFromServices({
    services, sessionManager: manager, model,
    customTools: [AgentSessionWrapper.userQuestionTool(() => wrapper)],
  });
  session.agent.streamFunction = (physicalModel, context) => {
    captures.push(structuredClone(context.messages));
    return fixtureStream(physicalModel, reply(captures.length, context.messages, workers));
  };
  wrapper = new AgentSessionWrapper(session);
  t.after(async () => {
    process.env.PI_CODING_AGENT_DIR = root;
    const active = controller.listActive(manager.getSessionId());
    await wrapper.send({ type: "abort" });
    for (const { sessionId } of active) await controller.extensionRuntime.get(sessionId, manager.getSessionId(), {});
    await wrapper.shutdown();
    const [first, second] = workers.values();
    first?.inner.dispose();
    second?.inner.dispose();
    if (first) await unlink(first.sessionFile);
    if (second) await unlink(second.sessionFile);
    if (childDirectory) {
      await rmdir(childDirectory);
      await rmdir(join(root, "sessions"));
    }
    if (workMode === "goal") await unlink(`${sessionFile}.goal.json`);
    await unlink(sessionFile);
    await unlink(authPath);
    await unlink(settingsPath);
    await rmdir(dirname(settingsPath));
    await rmdir(root);
  });
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });

  wrapper.start();
  wrapper.beginExtensionBinding();
  wrapper.onEvent((event) => events.push(event));
  if (workMode === "goal") {
    await updateSessionGoal(sessionFile, { action: { type: "set", objective: "Verify both workers" }, expectedRevision: null },
      () => wrapper.persistUnflushedSession());
  }
  if (workMode !== "auto") await wrapper.send({ type: "set_work_mode", mode: workMode });
  await wrapper.send({ type: "set_thinking_level", level: "high" });
  const waitForEvent = (predicate) => new Promise((resolve) => {
    const event = events.find(predicate);
    if (event) resolve(event);
    else {
      const unsubscribe = wrapper.onEvent((next) => {
        if (!predicate(next)) return;
        unsubscribe();
        resolve(next);
      });
    }
  });
  return { wrapper, manager, controller, workers, captures, events, waitForEvent };
}

function startFixtureWorkers() {
  return [
    fixtureTool("first-launch", "Agent", { prompt: "Check fixture A", description: "fixture A" }),
    fixtureTool("second-launch", "Agent", { prompt: "Check fixture B", description: "fixture B" }),
  ];
}

test("Pi continues main work after early background launches in both On and High Auto", { timeout: 10000 }, async (t) => {
  for (const subagentMode of ["on", "auto"]) {
    await t.test(subagentMode, async (t) => {
      const run = await createParallelSdkFixture(t, {
        reply(round) {
          if (round === 1) return startFixtureWorkers();
          if (round === 2) return [fixtureTool("main-read", "read", { path: "agents/settings.json" })];
          return [{ type: "text", text: round === 3 ? "Main work done." : "Checked the combined result." }];
        },
      });
      await run.wrapper.send({ type: "prompt", message: "Verify the fixtures", subagentMode });
      await run.waitForEvent((event) => event.type === "subagent_wait_changed" && event.runActivity.waitingForSubagents);
      assert.equal(run.captures.length, 3);
      assert.ok(run.captures[2].some((message) => message.role === "toolResult" && message.toolCallId === "main-read" && !message.isError));
      assert.deepEqual([...run.workers.values()].map((child) => child.requested), [true, true]);
      assert.equal(run.events.some((event) => event.subagent?.status === "completed"), false);

      const [first, second] = run.workers.values();
      second.release();
      await run.waitForEvent((event) => event.subagent?.status === "completed");
      assert.equal(run.captures.length, 3);
      first.release();
      await run.waitForEvent((event) => event.type === "prompt_done");

      assert.equal(run.captures.length, 4);
      assert.equal(run.events.filter((event) => event.type === "agent_settled").length, 1);
      assert.ok(run.captures[3].some((message) => message.role === "user" && JSON.stringify(message.content).includes("Subagent results for this task")));
      const entries = run.manager.getEntries();
      const batches = entries.filter((entry) => entry.type === "custom_message" && entry.customType === "meteoragent:subagent-results");
      assert.equal(batches.length, 1);
      assert.equal(batches[0].display, false);
      assert.match(batches[0].content, /Checked fixture A/);
      assert.match(batches[0].content, /Checked fixture B/);
      assert.equal(entries.filter((entry) => entry.type === "message" && entry.message.role === "user").length, 1);
    });
  }
});

test("Pi Stop releases the join and cancels both running and queued children", { timeout: 10000 }, async (t) => {
  const run = await createParallelSdkFixture(t, {
    maxConcurrent: 1,
    reply: (round) => round === 1 ? startFixtureWorkers() : delegationFixtureReply,
  });
  await run.wrapper.send({ type: "prompt", message: "Verify the fixtures", subagentMode: "on" });
  await run.waitForEvent((event) => event.type === "subagent_wait_changed" && event.runActivity.waitingForSubagents);
  assert.deepEqual([...run.workers.values()].map((child) => child.requested), [true, false]);
  const ids = [...run.workers.keys()];
  await run.wrapper.send({ type: "abort" });
  await run.waitForEvent((event) => event.type === "prompt_done");
  for (const sessionId of ids) {
    const child = await run.controller.extensionRuntime.get(sessionId, run.manager.getSessionId(), {});
    assert.equal(child.status, "aborted");
  }
  assert.equal(run.captures.length, 2);
  assert.equal(run.events.some((event) => event.subagent?.status === "completed"), false);
});

test("Pi waits for named dependencies and completes a Goal only after the results reach the parent", { timeout: 10000 }, async (t) => {
  const report = { status: "complete", detail: "Verified both child results." };
  const run = await createParallelSdkFixture(t, {
    workMode: "goal",
    reply(round, _messages, workers) {
      if (round === 1) return startFixtureWorkers();
      const [first, second] = workers.keys();
      if (round === 2) return [fixtureTool("wait-first", "get_subagent_result", { agent_id: first, wait: true })];
      if (round === 3) return [
        fixtureTool("too-early", "meteoragent_report_goal", report),
        fixtureTool("wait-second", "get_subagent_result", { agent_id: second, wait: true }),
      ];
      if (round === 4) return [fixtureTool("verified", "meteoragent_report_goal", report)];
      return delegationFixtureReply;
    },
  });
  await run.wrapper.send({ type: "prompt", message: "Verify the fixtures", subagentMode: "on" });
  await run.waitForEvent((event) => event.type === "tool_execution_start" && event.toolCallId === "wait-first");
  assert.equal(run.captures.length, 2);
  const [first, second] = run.workers.values();
  first.release();
  await run.waitForEvent((event) => event.type === "tool_execution_start" && event.toolCallId === "wait-second");
  assert.equal(run.captures.length, 3);
  assert.ok(run.captures[2].some((message) => message.toolCallId === "wait-first" && !message.isError));
  assert.equal(run.events.some((event) => event.subagent?.status === "completed" && event.subagent.sessionId === second.inner.sessionId), false);
  assert.equal(readSessionGoal(run.manager.getSessionFile()).status, "active");
  second.release();
  await run.waitForEvent((event) => event.type === "prompt_done");

  assert.equal(run.captures.length, 5);
  const premature = run.captures[3].find((message) => message.toolCallId === "too-early");
  assert.equal(premature.isError, true);
  assert.match(premature.content[0].text, /review outstanding subagent results/i);
  assert.ok(run.captures[4].some((message) => message.toolCallId === "verified" && !message.isError));
  assert.equal(readSessionGoal(run.manager.getSessionFile()).status, "completed");
  assert.equal(run.manager.getEntries().some((entry) => entry.customType === "meteoragent:subagent-results"), false);
});

test("Pi processes user steering during a join before any child needs to finish", { timeout: 10000 }, async (t) => {
  const run = await createParallelSdkFixture(t, {
    reply(round) {
      if (round === 1) return startFixtureWorkers();
      if (round === 3) return [fixtureTool("steered-read", "read", { path: "agents/settings.json" })];
      return delegationFixtureReply;
    },
  });
  await run.wrapper.send({ type: "prompt", message: "Verify the fixtures", subagentMode: "auto" });
  await run.waitForEvent((event) => event.type === "subagent_wait_changed" && event.runActivity.waitingForSubagents);
  await run.wrapper.send({ type: "steer", message: "Also read the project settings." });
  await run.waitForEvent((event) => event.type === "tool_execution_end" && event.toolCallId === "steered-read");
  assert.ok(run.captures[2].some((message) => message.role === "user" && JSON.stringify(message.content).includes("Also read the project settings")));
  assert.equal(run.events.some((event) => event.subagent?.status === "completed"), false);
  const [first, second] = run.workers.values();
  first.release();
  second.release();
  await run.waitForEvent((event) => event.type === "prompt_done");
  assert.equal(run.manager.getEntries().filter((entry) => entry.customType === "meteoragent:subagent-results").length, 1);
});

const askFixture = [
  { question: "报告要给谁看？", options: [{ label: "项目组" }, { label: "客户", description: "保留交付和验收信息" }] },
  { question: "请填写交付日期。" },
];

const isQuestionRequest = (event) => event.type === "extension_ui_request" && event.method === "question";

test("Pi pauses for a grouped question and resumes the same task with selected and custom answers", { timeout: 10000 }, async (t) => {
  const run = await createParallelSdkFixture(t, {
    reply: (round) => round === 1 ? [
      fixtureTool("ask", USER_QUESTION_TOOL, { questions: askFixture }),
      fixtureTool("premature-write", "write", { path: "agents/settings.json", content: "should not run" }),
    ] : delegationFixtureReply,
  });
  await run.wrapper.send({ type: "prompt", message: "准备报告", subagentMode: "off", computerUseApprovalPolicy: "full" });
  const question = await run.waitForEvent(isQuestionRequest);
  assert.deepEqual(JSON.parse(JSON.stringify(question.questions)), askFixture);
  assert.equal(run.wrapper.isRunning(), true);
  assert.equal(run.captures.length, 1);

  const replay = [];
  run.wrapper.onEvent((event) => replay.push(event))();
  assert.deepEqual(replay.filter(isQuestionRequest), [question]);

  const respond = (answer) => run.wrapper.send({ type: "extension_ui_response", id: question.id, ...answer });
  await assert.rejects(respond({ confirmed: true }), /one answer for each question/);
  await assert.rejects(respond({ answers: [{ optionIndex: 8 }, { text: "周四" }] }), /invalid answer/i);
  await assert.rejects(respond({ answers: [{ optionIndex: 1 }, { text: " " }] }), /invalid answer/i);
  assert.equal(run.events.some((event) => event.type === "extension_ui_closed"), false);
  await respond({ answers: [{ optionIndex: 1 }, { text: "  周四前  " }] });
  await run.waitForEvent((event) => event.type === "prompt_done");

  const reply = run.captures[1].find((message) => message.toolCallId === "ask");
  assert.equal(reply.isError, false);
  assert.match(reply.content[0].text, /客户.+周四前/);
  const sibling = run.captures[1].find((message) => message.toolCallId === "premature-write");
  assert.equal(sibling.isError, true);
  assert.match(sibling.content[0].text, /wait for the user's answer/i);
  assert.equal(run.manager.getEntries().filter((entry) => entry.message?.role === "user").length, 1);
  const saved = run.manager.getEntries().find((entry) => entry.message?.toolCallId === "ask");
  assert.deepEqual(saved.message.details, {
    status: "answered",
    answers: [
      { question: "报告要给谁看？", answer: "客户" },
      { question: "请填写交付日期。", answer: "周四前" },
    ],
  });
});

test("a skipped question cannot reopen in the same Goal run", { timeout: 10000 }, async (t) => {
  const run = await createParallelSdkFixture(t, {
    workMode: "goal",
    reply(round) {
      if (round <= 2) return [fixtureTool(`ask-${round}`, USER_QUESTION_TOOL, { questions: askFixture })];
      if (round === 3) return [fixtureTool("report-blocked", "meteoragent_report_goal", {
        status: "blocked", detail: "The intended audience is unknown.", userAction: "请告诉我报告是给谁看的。",
      })];
      return delegationFixtureReply;
    },
  });
  await run.wrapper.send({ type: "prompt", message: "准备报告", subagentMode: "off" });
  const question = await run.waitForEvent(isQuestionRequest);
  await run.wrapper.send({ type: "extension_ui_response", id: question.id, cancelled: true });
  await run.waitForEvent((event) => event.type === "prompt_done");
  assert.equal(run.events.filter(isQuestionRequest).length, 1);
  assert.ok(run.captures[1].some((message) => message.toolCallId === "ask-1" && /user skipped/.test(message.content[0].text)));
  assert.ok(run.captures[2].some((message) => message.toolCallId === "ask-2" && message.isError));
  assert.equal(readSessionGoal(run.manager.getSessionFile()).status, "blocked");
});

test("Plan can ask a question and Stop closes the pending dialog", { timeout: 10000 }, async (t) => {
  const run = await createParallelSdkFixture(t, {
    workMode: "plan",
    reply: (round) => round === 1 ? [fixtureTool("plan-question", USER_QUESTION_TOOL, { questions: askFixture })]
      : delegationFixtureReply,
  });
  await run.wrapper.send({ type: "prompt", message: "先规划报告", subagentMode: "off" });
  const question = await run.waitForEvent(isQuestionRequest);
  const tools = new Set(getCurrentTools(run.captures[0]).map(({ name }) => name));
  assert.ok(tools.has(USER_QUESTION_TOOL));
  assert.ok(tools.has("read"));
  assert.ok(!tools.has("write") && !tools.has("bash"));
  await run.wrapper.send({ type: "abort" });
  await run.waitForEvent((event) => event.type === "prompt_done");
  assert.ok(run.events.some((event) => event.type === "extension_ui_closed" && event.id === question.id));
  assert.equal(run.captures.length, 1);
});

test("run timing survives intermediate rounds and empty tool updates", async (t) => {
  const run = await createGoalRunFixture(t);
  const { startedAt } = run.wrapper.runActivity;
  const clock = t.mock.method(Date, "now", () => startedAt + 46_000);
  const tool = { toolCallId: "rust-install", toolName: "bash" };
  run.receive({ type: "tool_execution_start", ...tool });
  assert.deepEqual(run.wrapper.runActivity, {
    startedAt, lastActivityAt: startedAt + 46_000, tools: [{ id: "rust-install", name: "bash" }],
  });

  clock.mock.mockImplementation(() => startedAt + 90_000);
  run.receive({ type: "tool_execution_update", ...tool, partialResult: { content: [] } });
  assert.equal(run.wrapper.runActivity.lastActivityAt, startedAt + 46_000);
  run.receive({ type: "tool_execution_update", ...tool,
    partialResult: { content: [{ type: "text", text: "Downloading target." }] } });
  assert.equal(run.wrapper.runActivity.lastActivityAt, startedAt + 90_000);
  assert.equal(run.events.at(-1).activityAt, startedAt + 90_000);

  run.receive({ type: "tool_execution_end", ...tool });
  assert.deepEqual(run.wrapper.runActivity.tools, []);
  run.receive({ type: "agent_end" });
  run.receive({ type: "agent_start" });
  assert.equal(run.wrapper.runActivity.startedAt, startedAt);

  run.reply([{ type: "text", text: "Finished." }]);
  await run.finish();
  assert.equal(run.wrapper.runActivity, undefined);
  const markers = run.inner.sessionManager.getEntries().filter((entry) =>
    entry.type === "custom_message" && entry.customType === "meteoragent:turn-timing");
  assert.equal(markers.length, 1);
  assert.equal(markers[0].display, false);
  assert.ok(Number.isSafeInteger(markers[0].details.durationMs));
  const projected = await run.inner.agent.transformContext([
    { role: "custom", customType: markers[0].customType, content: "", details: markers[0].details },
  ]);
  assert.ok(!projected.some((message) => message.customType === "meteoragent:turn-timing"));
});

test("a saved goal continues a reasoning-only stop once and then records the pause", async (t) => {
  const run = await createGoalRunFixture(t);
  const system = { role: "system", content: "", timestamp: 1, toolsAdded: [{ name: "meteoragent_report_goal" }] };
  const user = { role: "user", content: "Work on this goal", timestamp: 2 };
  const projected = await run.inner.agent.transformContext([system, user]);
  assert.match(projected[0].sections.meteoragentSessionGoal, /does not expand the user's permissions/);
  assert.match(projected[1].content[0].text, /Verify the fixture/);
  assert.equal(projected[1].content[1].text, user.content);
  assert.equal(projected[0].toolsAdded.length, 1);
  run.reply([{ type: "thinking", thinking: "Will work on this." }]);
  const firstDraft = { type: "custom", customType: "test:prior-extension-entry" };
  const continuation = run.boundary([], { entries: [firstDraft] });
  assert.equal(continuation.continue, true);
  assert.equal(continuation.entries.length, 2);
  assert.equal(continuation.entries[0], firstDraft);
  assert.equal(continuation.entries[1].display, false);
  const { customType, content, details } = continuation.entries[1];
  const context = [system, { role: "custom", customType, content, details }];
  assert.equal((await run.inner.agent.transformContext(context)).length, 2);

  run.reply([{ type: "text", text: "  " }]);
  assert.equal(run.boundary(), undefined);
  assert.equal((await run.finish()).reason, "empty_reply");
  assert.equal((await run.inner.agent.transformContext(context)).length, 1);
});

test("a goal continues a prose-only checkpoint and pauses if it still has no evidence of progress", async (t) => {
  const run = await createGoalRunFixture(t);
  run.reply([{ type: "text", text: "I have checked the files. Next I will verify the results." }]);
  assert.equal(run.boundary()?.continue, true);
  run.reply([{ type: "text", text: "I still need to verify the results." }]);
  assert.equal(run.boundary(), undefined);
  const goal = await run.finish();
  assert.equal(goal.status, "paused");
  assert.equal(goal.reason, "no_progress");
  assert.equal(goal.userAction, undefined);
});

test("goal reports require evidence and fresh checkpoints keep work going until completion", async (t) => {
  const run = await createGoalRunFixture(t);
  await assert.rejects(run.reportTool.execute("whitespace", { status: "complete", detail: " " }), /Provide evidence/);
  await run.reportTool.execute("progress", { status: "progress", detail: "Created fixture. Verification remains." });
  run.reply([{ type: "text", text: "The test fixture is ready." }]);
  assert.equal(run.boundary().continue, true);
  await run.reportTool.execute("progress", { status: "progress", detail: "Verified the first case. The second remains." });
  run.reply([{ type: "text", text: "The first case passed." }]);
  assert.equal(run.boundary().continue, true);

  await run.reportTool.execute("complete", { status: "complete", detail: "Verified both fixture cases." });
  run.reply([{ type: "text", text: "Both cases passed." }]);
  assert.equal(run.boundary(), undefined);
  const goal = await run.finish();
  assert.equal(goal.status, "completed");
  assert.equal(goal.evidence, "Verified both fixture cases.");
});

test("goal progress at the continuation limit keeps the evidence for the user", async (t) => {
  const run = await createGoalRunFixture(t);
  for (let round = 1; round <= 8; round++) {
    await run.reportTool.execute("progress", { status: "progress", detail: `Verified fixture ${round}.` });
    run.reply([{ type: "text", text: "Verification is still in progress." }]);
    assert.equal(run.boundary()?.continue, true);
  }
  await run.reportTool.execute("progress", { status: "progress", detail: "Verified fixture 9." });
  run.reply([{ type: "text", text: "The tenth fixture remains." }]);
  assert.equal(run.boundary(), undefined);
  const goal = await run.finish();
  assert.equal(goal.reason, "budget");
  assert.equal(goal.evidence, "Verified fixture 9.");
});

test("rephrasing a checkpoint's case and whitespace does not reset goal recovery", async (t) => {
  const run = await createGoalRunFixture(t);
  for (const detail of ["Verified first case.", "VERIFIED  FIRST CASE."]) {
    await run.reportTool.execute("progress", { status: "progress", detail });
    run.reply([{ type: "text", text: detail }]);
    assert.equal(run.boundary()?.continue, true);
  }
  await run.reportTool.execute("progress", { status: "progress", detail: "Verified\nfirst case." });
  run.reply([{ type: "text", text: "The first case passed." }]);
  assert.equal(run.boundary(), undefined);
  const goal = await run.finish();
  assert.equal(goal.reason, "no_progress");
  assert.equal(goal.evidence, "Verified first case.");
});

test("goal pauses for an explicit blocker that needs the user's action", async (t) => {
  const run = await createGoalRunFixture(t);
  const detail = "The workspace path is unavailable.";
  await assert.rejects(run.reportTool.execute("blocker", { status: "blocked", detail, userAction: " " }), /exactly what the user needs/);
  await run.reportTool.execute("blocker", { status: "blocked", detail, userAction: " 请选择项目目录。 " });
  run.reply([{ type: "text", text: "需要你选择项目目录。" }]);
  assert.equal(run.boundary(), undefined);
  const goal = await run.finish();
  assert.equal(goal.status, "blocked");
  assert.equal(goal.reason, "blocked");
  assert.equal(goal.detail, detail);
  assert.equal(goal.userAction, "请选择项目目录。");
});

test("a new message in goal mode answers a blocker directly while OS permissions still require an explicit resume", async (t) => {
  await t.test("the answer continues the same goal", async (t) => {
    const run = await createGoalRunFixture(t, "goal", {
      previousOutcome: { status: "blocked", reason: "blocked", detail: "Two projects found.", userAction: "Which project should I verify?" },
      message: "Use the project named Demo.",
    });
    const system = { role: "system", content: "", timestamp: 1, toolsAdded: [{ name: "meteoragent_report_goal" }] };
    const user = { role: "user", content: "Use the project named Demo.", timestamp: 2 };
    const projected = await run.inner.agent.transformContext([system, user]);
    assert.match(projected[1].content[0].text, /Verify the fixture/);
    assert.equal(projected[1].content[1].text, user.content);
    await run.reportTool.execute("complete", { status: "complete", detail: "Verified Demo's fixture." });
    run.reply([{ type: "text", text: "Verified the Demo project." }]);
    assert.equal(run.boundary(), undefined);
    const goal = await run.finish();
    assert.equal(goal.status, "completed");
    assert.equal(goal.evidence, "Verified Demo's fixture.");
    assert.equal(goal.userAction, undefined);
  });
  await t.test("a chat message alone does not resume an OS blocker", async (t) => {
    const run = await createGoalRunFixture(t, "goal", {
      previousOutcome: { status: "blocked", reason: "screen_recording" },
      message: "What is Screen Recording?",
    });
    run.reply([{ type: "text", text: "The OS permission lets the app capture the display." }]);
    assert.equal(run.boundary(), undefined);
    const goal = await run.finish();
    assert.equal(goal.status, "blocked");
    assert.equal(goal.reason, "screen_recording");
    assert.equal(goal.revision, 2);
    assert.deepEqual(run.inner.sessionManager.getEntries().at(-1)?.details, { status: "untracked" });
  });
  await t.test("Chat only shows the answer without advancing the active goal", async (t) => {
    const run = await createGoalRunFixture(t, "goal", { chatOnly: true });
    run.reply([{ type: "text", text: "Here is an answer to your question." }]);
    assert.equal(run.boundary(), undefined);
    assert.equal((await run.finish()).revision, 1);
    const entry = run.inner.sessionManager.getEntries().at(-1);
    assert.equal(entry?.type, "custom_message");
    assert.equal(entry.customType, "meteoragent:goal-outcome");
    assert.equal(entry.display, false);
    assert.deepEqual(entry.details, { status: "untracked" });
  });
  await t.test("an extension-handled message leaves the goal waiting for the user's answer", async (t) => {
    const previousOutcome = { status: "blocked", reason: "blocked", detail: "Two projects found.", userAction: "Which project should I verify?" };
    const run = await createGoalRunFixture(t, "goal", { previousOutcome, message: "Use the project named Demo.", handled: true });
    await run.completed;
    assert.deepEqual(readSessionGoal(run.sessionFile), { ...previousOutcome, objective: "Verify the fixture", revision: 2 });
  });
});

test("goal continuation respects actual permission and approval state", async (t) => {
  const macOnly = { skip: process.platform !== "darwin" };
  const screenshotFailed = {
    toolName: "computer_use_screenshot", isError: true,
    content: [{ type: "text", text: "Screenshot failed for the main display. Screen Recording permission not granted." }],
  };
  const screenshotDenied = {
    ...screenshotFailed,
    content: [{ type: "text", text: "Screen Recording permission not granted." }],
  };
  const checkScreenPermission = (screenRecording, directCaptureStatus = "not_checked") => ({
    toolName: "computer_use_check_permissions",
    details: { screen_recording: screenRecording, accessibility: true, direct_capture_status: directCaptureStatus },
    content: [],
  });
  await t.test("an OS screen recording denial pauses even if the model omits the blocker", macOnly, async (t) => {
    const run = await createGoalRunFixture(t);
    run.toolResult(screenshotDenied);
    run.reply([{ type: "text", text: "I will try again." }]);
    assert.equal(run.boundary(), undefined);
    const goal = await run.finish();
    assert.equal(goal.status, "blocked");
    assert.equal(goal.reason, "screen_recording");
  });
  await t.test("an unconfirmed screenshot failure gets a recovery round and a capture-specific pause", macOnly, async (t) => {
    const run = await createGoalRunFixture(t);
    run.toolResult(checkScreenPermission(true));
    run.toolResult(screenshotFailed);
    run.reply([{ type: "text", text: "The screen capture failed. I will check the permission." }]);
    assert.equal(run.boundary()?.continue, true);
    run.toolResult(checkScreenPermission(true));
    run.toolResult(screenshotFailed);
    run.reply([{ type: "text", text: "The screen capture is still unavailable." }]);
    assert.equal(run.boundary(), undefined);
    const goal = await run.finish();
    assert.equal(goal.status, "paused");
    assert.equal(goal.reason, "screen_capture_failed");
    assert.equal(goal.userAction, undefined);
  });
  await t.test("a screenshot failure and a permission check confirming denial pause for the OS grant", macOnly, async (t) => {
    const run = await createGoalRunFixture(t);
    run.toolResult(screenshotFailed);
    run.toolResult(checkScreenPermission(false));
    run.reply([{ type: "text", text: "The screen capture failed and the system denied its permission." }]);
    assert.equal(run.boundary(), undefined);
    const goal = await run.finish();
    assert.equal(goal.status, "blocked");
    assert.equal(goal.reason, "screen_recording");
  });
  await t.test("a capture probe can confirm the OS denial after a screenshot failure", macOnly, async (t) => {
    const run = await createGoalRunFixture(t);
    run.toolResult(screenshotFailed);
    run.toolResult(checkScreenPermission(true, "blocked_by_screen_recording"));
    run.reply([{ type: "text", text: "The capture probe confirmed the permission problem." }]);
    assert.equal(run.boundary(), undefined);
    const goal = await run.finish();
    assert.equal(goal.status, "blocked");
    assert.equal(goal.reason, "screen_recording");
  });
  await t.test("capturing the screen clears an earlier screen recording denial", macOnly, async (t) => {
    const run = await createGoalRunFixture(t);
    run.toolResult(screenshotDenied);
    run.toolResult({ toolName: "computer_use_screenshot", content: [{ type: "image" }] });
    await run.reportTool.execute("progress", { status: "progress", detail: "Captured the screen. Inspecting the image remains." });
    run.reply([{ type: "text", text: "Captured the screen." }]);
    assert.equal(run.boundary()?.continue, true);
    await run.reportTool.execute("complete", { status: "complete", detail: "Inspected the screenshot." });
    run.reply([{ type: "text", text: "Inspected the screenshot." }]);
    assert.equal(run.boundary(), undefined);
    assert.equal((await run.finish()).status, "completed");
  });
  await t.test("a denied confirmation pauses the goal", async (t) => {
    const run = await createGoalRunFixture(t);
    let confirmation;
    run.wrapper.onEvent((event) => {
      if (event.type === "extension_ui_request") confirmation = event;
    });
    const pending = run.ui.confirm("Run task", "Allow this change?");
    assert.ok(confirmation);
    await run.wrapper.send({ type: "extension_ui_response", id: confirmation.id, confirmed: false });
    assert.equal(await pending, false);
    run.reply([{ type: "text", text: "I will try again." }]);
    assert.equal(run.boundary(), undefined);
    const goal = await run.finish();
    assert.equal(goal.status, "blocked");
    assert.equal(goal.reason, "approval_required");
  });
});

test("goal run protects queued user work and distinguishes stop, failure, and a revised goal", async (t) => {
  await t.test("queued user and extension work takes priority", async (t) => {
    const run = await createGoalRunFixture(t);
    run.reply([]);
    assert.equal(run.boundary([{ role: "user", content: "Steering" }]), undefined);
    assert.equal(run.boundary([], { continue: true }), undefined);
    assert.equal((await run.finish()).reason, "empty_reply");
  });
  await t.test("an actual Stop causes no model continuation", async (t) => {
    const run = await createGoalRunFixture(t);
    run.reply([]);
    await run.wrapper.send({ type: "abort" });
    await run.completed;
    assert.equal(run.boundary(), undefined);
    assert.equal(readSessionGoal(run.sessionFile).reason, "user_stop");
  });
  await t.test("provider failures are not continued as successful responses", async (t) => {
    const run = await createGoalRunFixture(t);
    run.reply([], "error");
    assert.equal(run.boundary(), undefined);
    assert.equal((await run.finish()).reason, "request_error");
  });
  await t.test("an output limit has its own stop reason", async (t) => {
    const run = await createGoalRunFixture(t);
    run.reply([{ type: "text", text: "Partial update" }], "length");
    assert.equal(run.boundary(), undefined);
    assert.equal((await run.finish()).reason, "output_limit");
  });
  await t.test("completed image delivery is a result", async (t) => {
    const run = await createGoalRunFixture(t);
    run.toolResult({ toolName: "image_generate", content: [{ type: "image" }] });
    run.reply([]);
    assert.equal(run.boundary(), undefined);
    assert.equal((await run.finish()).reason, "needs_review");
  });
  await t.test("a new goal revision is left active", async (t) => {
    const run = await createGoalRunFixture(t);
    run.reply([]);
    await updateSessionGoal(run.sessionFile, { action: { type: "set", objective: "New goal" }, expectedRevision: 1 });
    assert.equal(run.boundary(), undefined);
    await assert.rejects(run.reportTool.execute("stale", { status: "complete", detail: "Old goal finished." }), /active goal changed/);
    const goal = await run.finish();
    assert.equal(goal.status, "active");
    assert.equal(goal.objective, "New goal");
  });
  await t.test("a pending mode change takes priority", async (t) => {
    const run = await createGoalRunFixture(t);
    run.reply([]);
    await run.wrapper.send({ type: "set_work_mode", mode: "plan" });
    assert.equal(run.boundary(), undefined);
    assert.equal((await run.finish()).status, "active");
  });
  await t.test("ordinary mode does not run goal orchestration", async (t) => {
    const run = await createGoalRunFixture(t, "auto");
    run.reply([]);
    assert.equal(run.boundary(), undefined);
    assert.equal((await run.finish()).status, "active");
  });
});

test("the pinned Pi boundary continues a prose-only goal under the same user message", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "magent-sdk-goal-"));
  const manager = SessionManager.create(root, root);
  const sessionFile = manager.getSessionFile();
  const authPath = join(root, "auth.json");
  const modelRuntime = await ModelRuntime.create({
    authPath,
    modelsPath: null,
    refreshOnCreate: false,
  });
  await modelRuntime.setRuntimeApiKey("openai", "mock");
  const host = {};
  const services = await createAgentSessionServices({
    cwd: root,
    agentDir: root,
    modelRuntime,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
    resourceLoaderOptions: { noExtensions: true, extensionFactories: [AgentSessionWrapper.goalExtension(() => host.wrapper)] },
  });
  const model = modelRuntime.getModel("openai", "gpt-4.1");
  assert.ok(model);
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model });
  const captures = [];
  session.agent.streamFunction = (_model, context) => {
    captures.push(structuredClone(context.messages));
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "The next step is to verify the result." }],
      api: model.api, provider: model.provider, model: model.id,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now(),
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message });
    return stream;
  };
  const wrapper = new AgentSessionWrapper(session);
  host.wrapper = wrapper;
  t.after(async () => {
    await wrapper.shutdown();
    await unlink(`${sessionFile}.goal.json`);
    await unlink(sessionFile);
    await unlink(authPath);
    await rmdir(root);
  });
  wrapper.start();
  wrapper.beginExtensionBinding();
  await updateSessionGoal(sessionFile, { action: { type: "set", objective: "Check the mocked flow" }, expectedRevision: null },
    () => wrapper.persistUnflushedSession());
  await updateSessionGoalFromRun(sessionFile, 1, {
    status: "blocked", reason: "blocked", detail: "Two projects found.", userAction: "Which project should I verify?",
    evidence: "Verified a previous fixture.",
  });
  await wrapper.send({ type: "set_work_mode", mode: "goal" });

  const events = [];
  const resumedGoals = [];
  const completed = new Promise((resolve) => {
    wrapper.onEvent((event) => {
      events.push(event.type);
      if (event.type === "agent_start" && event.resumedGoal) resumedGoals.push(event.resumedGoal);
      if (event.type === "prompt_done") resolve();
    });
  });
  await wrapper.send({ type: "prompt", message: "Use the project named Demo." });
  await completed;
  assert.equal(captures.length, 2);
  assert.deepEqual(resumedGoals, [{
    status: "active", objective: "Check the mocked flow", revision: 3, evidence: "Verified a previous fixture.",
  }]);
  for (const messages of captures) {
    const system = messages.filter((message) => message.role === "system").map(getSystemMessageText).join("\n");
    assert.doesNotMatch(system, /Check the mocked flow|Verified a previous fixture/);
    assert.equal(system.split("match the latest substantive user request").length - 1, 1);
    const user = messages.find((message) => message.role === "user");
    assert.match(user.content[0].text, /Check the mocked flow/);
    assert.match(user.content[0].text, /Verified a previous fixture/);
    assert.equal(user.content[1].text, "Use the project named Demo.");
  }
  assert.ok(captures[1].some((message) => message.role === "user" && JSON.stringify(message.content).includes("Continue the current goal")));
  assert.equal(manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user").length, 1);
  assert.equal(manager.getEntries().find((entry) => entry.type === "custom_message" && entry.customType === "meteoragent:goal-continuation")?.display, false);
  const outcome = manager.getEntries().find((entry) => entry.type === "custom_message" && entry.customType === "meteoragent:goal-outcome");
  assert.equal(outcome?.display, false);
  assert.equal(outcome?.details.status, "paused");
  assert.equal(events.filter((type) => type === "agent_settled").length, 1);
  assert.equal(readSessionGoal(sessionFile).reason, "no_progress");
});

test("an explicit computer-use approval only covers the same script and arguments in the current run", async (t) => {
  const toolName = "computer_use_run_script";
  const title = "Confirm high-risk computer action";
  const args = { script: "return 1;", session: "fixture" };
  const validSource = { origin: "package", source: "npm:@amaster.ai/pi-computer-use@0.1.32", path: "/fixture/computer-use/index.js" };
  let sourceInfo = validSource;
  let receive;
  let ui;
  const inner = {
    sessionManager: SessionManager.inMemory(),
    agent: { state: {} },
    isStreaming: true,
    subscribe(listener) { receive = listener; return () => {}; },
    async bindExtensions(options) { ui = options.uiContext; },
    getAllTools: () => [{ name: toolName, sourceInfo }],
    async abort() { inner.isStreaming = false; },
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  wrapper.start();
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  const requests = [];
  wrapper.onEvent((event) => {
    if (event.type === "extension_ui_request") requests.push(event);
  });
  const start = (toolCallId, input = args, name = toolName) =>
    receive({ type: "tool_execution_start", toolCallId, toolName: name, args: input });
  const end = (toolCallId) => receive({ type: "tool_execution_end", toolCallId });
  const confirm = (input = args, options, heading = title) =>
    ui.confirm(heading, `Allow run_script with arguments ${JSON.stringify(input)}?`, options);
  const respond = async (confirmed, rememberForRun = true) =>
    wrapper.send({ type: "extension_ui_response", id: requests.at(-1).id, confirmed, rememberForRun });

  receive({ type: "agent_start" });
  start("first");
  const first = confirm();
  assert.equal(requests.at(-1).approvalScope, "computer-use-exact");
  await respond(true, false);
  assert.equal(await first, true);
  end("first");
  start("second");
  const second = confirm();
  assert.equal(requests.length, 2);
  await respond(true);
  assert.equal(await second, true);
  end("second");
  start("repeat");
  assert.equal(await confirm(), true);
  assert.equal(requests.length, 2);
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await confirm(args, { signal: aborted.signal }), false);
  end("repeat");

  const verifyRequiresConfirmation = async (input, { heading, toolArgs = input, name, eligible = false } = {}) => {
    const count = requests.length;
    start("verification", toolArgs, name);
    const pending = confirm(input, undefined, heading);
    assert.equal(requests.length, count + 1);
    assert.equal(requests.at(-1).approvalScope, eligible ? "computer-use-exact" : undefined);
    await respond(false);
    assert.equal(await pending, false);
    end("verification");
  };
  await verifyRequiresConfirmation({ ...args, script: "return 2;" }, { eligible: true });
  await verifyRequiresConfirmation({ ...args, session: "different" }, { eligible: true });
  await verifyRequiresConfirmation(args, { toolArgs: { ...args, script: "return 2;" } });
  await verifyRequiresConfirmation(args, { name: "other_extension_tool" });
  await verifyRequiresConfirmation(args, { heading: "Confirm other action" });
  sourceInfo = { ...validSource, source: "npm:@amaster.ai/pi-computer-use-copy" };
  await verifyRequiresConfirmation(args);
  sourceInfo = validSource;
  start("parallel", {}, "another_tool");
  await verifyRequiresConfirmation(args);
  end("parallel");

  inner.isStreaming = false;
  receive({ type: "agent_settled" });
  inner.isStreaming = true;
  receive({ type: "agent_start" });
  await verifyRequiresConfirmation(args, { eligible: true });
  start("after-denial");
  const pending = confirm(args, { timeout: 10 });
  assert.equal(await pending, false);
  await respond(true); // A stale click cannot grant approval.
  end("after-denial");
  await verifyRequiresConfirmation(args, { eligible: true });
  start("stopped");
  const stopped = assert.rejects(confirm(), { name: "AbortError" });
  await wrapper.send({ type: "abort" });
  await stopped;
});

test("full computer access is bound to the standalone prompt and verified actions", async (t) => {
  let receive;
  let ui;
  let finish;
  const readonly = ["read", "grep", "find", "ls"];
  const configured = ["read", "bash", "edit", "write"];
  let activeTools = configured;
  let failPreflight = false;
  const sourceInfo = { origin: "package", source: "npm:@amaster.ai/pi-computer-use", path: "/fixture/computer-use/index.js" };
  const toolNames = ["run_script", "clipboard_read", "launch_app", "install_extension", "start_recording"]
    .map((action) => `computer_use_${action}`);
  const inner = {
    sessionManager: SessionManager.inMemory(),
    agent: { state: {} },
    settingsManager: { getDefaultTools: () => configured },
    isStreaming: false,
    subscribe(listener) { receive = listener; return () => {}; },
    async bindExtensions(options) { ui = options.uiContext; },
    prompt(_message, options) {
      if (failPreflight) return Promise.reject(new Error("fixture preflight failure"));
      if (inner.isStreaming) {
        options.preflightResult("queued");
        return Promise.resolve();
      }
      inner.isStreaming = true;
      options.preflightResult("started");
      receive({ type: "agent_start" });
      return new Promise((resolve) => {
        finish = () => {
          inner.isStreaming = false;
          receive({ type: "agent_settled" });
          resolve();
        };
      });
    },
    getActiveToolNames: () => activeTools,
    setActiveToolsByName: (names) => { activeTools = names; },
    getAllTools: () => toolNames.map((name) => ({ name, sourceInfo })),
    async abort() { finish?.(); },
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  wrapper.start();
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  const requests = [];
  wrapper.onEvent((event) => {
    if (event.type === "extension_ui_request") requests.push(event);
  });
  const prompt = (policy, streamingBehavior) => wrapper.send({
    type: "prompt", message: "fixture", computerUseApprovalPolicy: policy, streamingBehavior,
  });
  const check = async (action, args, allowed, title = "Confirm high-risk computer action") => {
    const before = requests.length;
    receive({ type: "tool_execution_start", toolCallId: action, toolName: `computer_use_${action}`, args });
    const result = ui.confirm(title, `Allow ${action} with arguments ${JSON.stringify(args)}?`);
    assert.equal(requests.length, before + (allowed ? 0 : 1));
    if (!allowed) await wrapper.send({ type: "extension_ui_response", id: requests.at(-1).id, cancelled: true });
    assert.equal(await result, allowed);
    receive({ type: "tool_execution_end", toolCallId: action });
  };
  const settle = async () => {
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(wrapper.activeComputerUseApprovalPolicy, "ask");
  };
  const script = { script: "return 1;" };

  await prompt("full");
  assert.equal(wrapper.activeComputerUseApprovalPolicy, "full");
  await check("run_script", script, true);
  await check("run_script", { script: "return 2;" }, true);
  await check("clipboard_read", {}, true);
  await check("launch_app", { name: "Fixture" }, false, "Allow computer use?");
  await check("install_extension", { confirm: true }, false);
  await check("start_recording", {}, false);
  await check("run_script", script, false, "Confirm some other action");
  await prompt("ask", "steer");
  assert.equal(wrapper.activeComputerUseApprovalPolicy, "full");
  await settle();

  await prompt("ask");
  await prompt("full", "followUp");
  assert.equal(wrapper.activeComputerUseApprovalPolicy, "ask");
  await check("run_script", script, false);
  await settle();

  activeTools = readonly;
  await prompt("full");
  await check("run_script", script, false);
  await settle();
  activeTools = configured;

  failPreflight = true;
  await assert.rejects(prompt("full"), /fixture preflight failure/);
  assert.equal(wrapper.activeComputerUseApprovalPolicy, "ask");
  failPreflight = false;
  await prompt("full");
  await wrapper.send({ type: "abort" });
  assert.equal(wrapper.activeComputerUseApprovalPolicy, "ask");
});

test("Pi full access approves trusted app launches and restores confirmation when the user switches back", { timeout: 10_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "magent-launch-approval-"));
  const authPath = join(root, "auth.json");
  const modelRuntime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
  await modelRuntime.setRuntimeApiKey("openai", "mock");
  const model = modelRuntime.getModel("openai", "gpt-4.1");
  const launchName = "computer_use_launch_app";
  const title = "Allow computer use?";
  const target = "com.example.fixture";
  const message = `Allow pi-computer-use to launch and control ${target} for this session?`;
  const args = { bundle_id: target, name: "Ignored because bundle_id wins", session: "fixture" };
  const text = (value) => ({ content: [{ type: "text", text: value }], details: {} });
  let wrapper;
  const computerUseFixture = {
    name: "computer-use-fixture",
    factory(pi) {
      const pluginApprovals = new Set();
      pi.on("session_start", () => pi.registerTool({
        name: launchName,
        label: "Open app",
        description: "Fixture with the package's launch approval and session cache",
        parameters: { type: "object", properties: {
          bundle_id: { type: "string" }, name: { type: "string" }, session: { type: "string" },
        } },
        async execute(_id, params, _signal, _update, ctx) {
          const key = JSON.stringify(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)));
          const verb = params.session === "different prompt" ? "restart" : "launch";
          if (!pluginApprovals.has(key)) {
            const accepted = await ctx.ui.confirm(title, `Allow pi-computer-use to ${verb} and control ${params.bundle_id} for this session?`);
            if (!accepted) return { ...text("Permission denied"), isError: true };
            pluginApprovals.add(key);
          }
          return text("App launched");
        },
      }));
    },
  };
  const parallelFixture = (pi) => {
    const register = (name, execute) => pi.registerTool({
      name, label: name, description: name, parameters: { type: "object", properties: {} }, execute,
    });
    register("fixture_other_extension", async (_id, _args, _signal, _update, ctx) =>
      text(await ctx.ui.confirm(title, message) ? "Unrelated request approved" : "Unrelated request denied"));
    register("fixture_nested_launch", async (_id, _args, _signal, _update, ctx) =>
      (await ctx.executeTool(launchName, args)).result);
  };
  const services = await createAgentSessionServices({
    cwd: root, agentDir: root, modelRuntime,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
    resourceLoaderOptions: {
      noExtensions: true,
      extensionFactories: [computerUseFixture, parallelFixture, AgentSessionWrapper.goalExtension(() => wrapper)],
    },
  });
  const extension = services.resourceLoader.getExtensions().extensions.find(({ path }) => path === "<inline:computer-use-fixture>");
  assert.ok(extension);
  extension.sourceInfo = { origin: "package", source: "npm:@amaster.ai/pi-computer-use@0.1.32", path: extension.path, scope: "user" };
  const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(root), model });
  wrapper = new AgentSessionWrapper(session);
  t.after(async () => {
    await wrapper.shutdown();
    await unlink(authPath);
    await rmdir(root);
  });
  wrapper.start();
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();

  async function run(policy, calls, confirmed = false) {
    let next = calls;
    session.agent.streamFunction = () => {
      const stream = fixtureStream(model, next);
      next = [{ type: "text", text: "Done" }];
      return stream;
    };
    const confirmations = [];
    const results = new Map();
    let unsubscribe;
    const done = new Promise((resolve, reject) => {
      unsubscribe = wrapper.onEvent((event) => {
        if (event.type === "extension_ui_request" && event.method === "confirm") {
          confirmations.push(event.message);
          void wrapper.send({ type: "extension_ui_response", id: event.id, confirmed }).catch(reject);
        } else if (event.type === "message_end" && event.message.role === "toolResult") {
          results.set(event.message.toolCallId, event.message.content[0].text);
        } else if (event.type === "prompt_done") resolve();
      });
    });
    try {
      await wrapper.send({ type: "prompt", message: "Verify app launch", subagentMode: "off", computerUseApprovalPolicy: policy });
      await done;
      return { confirmations, results };
    } finally {
      unsubscribe();
    }
  }

  const parallel = await run("full", [
    fixtureTool("first", launchName, args),
    fixtureTool("second", launchName, args),
    fixtureTool("unrelated", "fixture_other_extension"),
    fixtureTool("unexpected", launchName, { ...args, session: "different prompt" }),
  ]);
  assert.deepEqual(parallel.confirmations.sort(), [message, message.replace("launch", "restart")].sort());
  assert.deepEqual([...parallel.results.values()], ["App launched", "App launched", "Unrelated request denied", "Permission denied"]);

  const denied = await run("ask", [fixtureTool("denied", "fixture_nested_launch")]);
  assert.deepEqual(denied.confirmations, [message]);
  assert.match(denied.results.get("denied"), /requires interactive user confirmation/);
  const approved = await run("ask", [fixtureTool("approved", launchName, { session: args.session, ...args })], true);
  assert.deepEqual(approved.confirmations, [message]);
  assert.equal(approved.results.get("approved"), "App launched");
  const remembered = await run("ask", [fixtureTool("remembered", launchName, args)]);
  assert.deepEqual(remembered.confirmations, []);
  assert.equal(remembered.results.get("remembered"), "App launched");
});

test("an unsupported reasoning choice uses the adjacent level or provider Auto and survives reopening", async () => {
  const manager = SessionManager.inMemory();
  const model = {
    id: "test-reasoning",
    provider: "fixture",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: { off: "none", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" },
  };
  const agent = {
    state: { thinkingLevel: "high" },
    async streamFunction(requestModel, _context, options) {
      const payload = { model: requestModel.id, reasoning_effort: options.reasoning ?? "none", messages: [] };
      await options.onPayload?.(payload, requestModel);
      return payload;
    },
  };
  const originalStream = agent.streamFunction;
  const createWrapper = () => new AgentSessionWrapper({
    agent,
    sessionManager: manager,
    getAvailableThinkingLevels: () => getSupportedThinkingLevels(model),
    setThinkingLevel(level) {
      agent.state.thinkingLevel = level;
      manager.appendThinkingLevelChange(level);
    },
    dispose() {},
  });
  const wrapper = createWrapper();
  try {
    assert.deepEqual(await wrapper.send({ type: "set_thinking_level", level: "medium" }), { thinkingLevel: "auto" });
    assert.equal(buildSessionContext(manager.getEntries(), manager.getLeafId()).thinkingLevel, "auto");
    assert.deepEqual(await agent.streamFunction(model, {}, { reasoning: "high" }), { model: model.id, messages: [] });
  } finally {
    wrapper.destroy();
  }

  agent.streamFunction = originalStream;
  const restored = createWrapper();
  try {
    assert.deepEqual(await agent.streamFunction(model, {}, { reasoning: "high" }), { model: model.id, messages: [] });
    assert.deepEqual(await restored.send({ type: "set_thinking_level", level: "max" }), { thinkingLevel: "max" });
    assert.equal((await agent.streamFunction(model, {}, { reasoning: "max" })).reasoning_effort, "max");
    model.thinkingLevelMap = { ...model.thinkingLevelMap, max: null, xhigh: "xhigh" };
    assert.equal((await agent.streamFunction(model, {}, { reasoning: "max" })).reasoning_effort, "xhigh");
    assert.deepEqual(await restored.send({ type: "set_thinking_level", level: "max" }), { thinkingLevel: "xhigh" });
    model.thinkingLevelMap.xhigh = null;
    assert.deepEqual(await restored.send({ type: "set_thinking_level", level: "max" }), { thinkingLevel: "auto" });
    assert.deepEqual(await agent.streamFunction(model, {}, { reasoning: "max" }), { model: model.id, messages: [] });
  } finally {
    restored.destroy();
  }
});

test("the live Pi context window restores a legacy override and changes at idle boundaries", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "magent-context-window-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  const provider = "meteor21c";
  const id = "gpt-6.2-sol";
  const modelConfig = (contextWindow, override) => ({
    providers: { [provider]: {
      api: "openai-responses", baseUrl: "https://relay.example.test/v1", apiKey: "offline-test-key",
      models: [{ id, contextWindow, maxTokens: 128_000, meteorAgentContextWindowOverride: override }],
    } },
  });
  const modelsPath = join(agentDir, "models.json");
  await writeFile(modelsPath, JSON.stringify(modelConfig(258_000, 1_000_000)));
  const modelRuntime = await ModelRuntime.create({ modelsPath, authPath: join(agentDir, "auth.json"), refreshOnCreate: false });
  const model = modelRuntime.getModel(provider, id);
  assert.equal(model.contextWindow, 258_000);
  const services = await createAgentSessionServices({
    cwd: agentDir, agentDir, modelRuntime,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true },
  });
  const { session } = await createAgentSessionFromServices({
    services, sessionManager: SessionManager.inMemory(agentDir), model, tools: [],
  });
  let startStream;
  const streamed = new Promise((resolve) => { startStream = resolve; });
  const stream = createAssistantMessageEventStream();
  session.agent.streamFunction = (requestModel) => {
    startStream(requestModel.contextWindow);
    return stream;
  };
  const wrapper = new AgentSessionWrapper(session, { chatOnly: true });
  t.after(() => {
    stream.end();
    return wrapper.shutdown();
  });
  wrapper.start();
  wrapper.beginExtensionBinding();
  const currentWindow = async () => (await wrapper.send({ type: "get_state" })).contextUsage.contextWindow;
  assert.equal(await currentWindow(), 1_000_000);

  const finished = new Promise((resolve) => wrapper.onEvent((event) => {
    if (event.type === "prompt_done") resolve();
  }));
  await wrapper.send({ type: "prompt", message: "Offline context fixture" });
  assert.equal(await streamed, 1_000_000);
  writeModelsConfig(modelConfig(258_000, 512_000));
  assert.equal(await currentWindow(), 1_000_000);
  const message = {
    role: "assistant", provider, model: id, api: "openai-responses", stopReason: "stop", timestamp: Date.now(),
    content: [{ type: "text", text: "Fixture response" }],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  stream.push({ type: "done", reason: "stop", message });
  stream.end();
  await finished;
  assert.equal(await currentWindow(), 512_000);
  writeModelsConfig(modelConfig(512_000, undefined));
  assert.equal(await currentWindow(), 272_000);
});

test("get_tools preserves the SDK tool definition fields", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const getToolsSource = source.slice(
    source.indexOf('case "get_tools"'),
    source.indexOf('case "get_commands"'),
  );

  assert.match(getToolsSource, /\.getAllTools\(\)/);
  assert.match(getToolsSource, /\.\.\.t,/);
  assert.match(getToolsSource, /active: active\.has\(t\.name\)/);
});

test("RPC session startup preloads extension-registered providers before restoring models", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(startupSource, /createAgentSessionServices\(/);
  assert.match(startupSource, /createAgentSessionFromServices\(/);
  assert.doesNotMatch(startupSource, /await createAgentSession\(/);
});

test("built-in subagents persist their selected resource policy", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const subagentSource = await readFile(new URL("./subagent-runtime.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(subagentSource, /SessionManager\.create\(parent\.cwd, undefined, \{ parentSession: parent\.sessionFile \}\)/);
  assert.match(subagentSource, /appendCustomEntry\(SUBAGENT_META_TYPE/);
  assert.match(subagentSource, /appendCustomEntry\(SUBAGENT_RESULT_TYPE/);
  assert.match(subagentSource, /dependencies\.registerSession\(inner, \{/);
  assert.match(subagentSource, /noExtensions: !loadExtensions/);
  assert.match(subagentSource, /noSkills: !loadSkills/);
  assert.match(subagentSource, /excludeTools: \[\.\.\.SUBAGENT_CONTROL_TOOL_NAMES\]/);
  assert.match(subagentSource, /withSubagentExtensionTools\(profileTools, extensionToolNames\.filter\(parentAllowsTool\)\)/);
  assert.match(subagentSource, /resourceSnapshot:/);
  assert.match(startupSource, /readSubagentSessionResources\(/);
  assert.match(startupSource, /resourceLoaderOptions: subagentResources/);
  assert.match(startupSource, /appendSystemPrompt: subagentResources\.appendSystemPrompt/);
  assert.match(startupSource, /noExtensions: !subagentResources\.loadExtensions/);
  assert.match(startupSource, /noSkills: !subagentResources\.loadSkills/);
  assert.match(startupSource, /excludeTools: \[\.\.\.SUBAGENT_CONTROL_TOOL_NAMES\]/);
  assert.match(startupSource, /let toolsOption: string\[\] \| undefined = subagentResources\?\.tools/);
  assert.match(source, /createSubagentController\(/);
  assert.match(source, /suppressCompletionNotifications: true/);
  assert.match(source, /suppressCompletionNotifications: Boolean\(subagentResources\)/);
  assert.match(startupSource, /createSubagentExtension\([\s\S]*?SUBAGENT_CONTROLLER\.extensionRuntime,[\s\S]*?\(\) => listSubagentProfiles\(sessionCwd\)/);
  assert.match(startupSource, /preferPiWebSubagentExtension\(base\)/);
});

test("running snapshots expose sessions with suppressed completion notifications", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const runningRouteSource = await readFile(new URL("../app/api/agent/running/route.ts", import.meta.url), "utf8");
  const sessionsRouteSource = await readFile(new URL("../app/api/sessions/route.ts", import.meta.url), "utf8");
  const snapshotSource = source.slice(
    source.indexOf("export function getCompletionNotificationSuppressedRpcSessionIds"),
    source.indexOf("// ----------------------------------------------------------------------------", source.indexOf("export function getCompletionNotificationSuppressedRpcSessionIds")),
  );

  assert.match(snapshotSource, /session\.isRunning\(\) && session\.hasSuppressedCompletionNotifications\(\)/);
  assert.match(runningRouteSource, /completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds\(\)/);
  assert.match(sessionsRouteSource, /completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds\(\)/);
});

test("RPC session startup resolves and passes the SDK-native enabled model scope", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const resolveIndex = startupSource.indexOf("resolveVisibleModels(");
  const createIndex = startupSource.indexOf("createAgentSessionFromServices(");

  assert.ok(resolveIndex >= 0);
  assert.ok(createIndex > resolveIndex);
  assert.match(startupSource, /selectInitialModelScope\(/);
  assert.match(startupSource, /scopedModels: \[\.\.\.scope\.scopedModels\]/);
  assert.match(startupSource, /model: startupModel/);
  assert.match(startupSource, /const sdkThinking = startupThinking \?\? initial\?\.thinkingLevel/);
  assert.match(startupSource, /thinkingLevel: sdkThinking/);
});

test("RPC session startup treats only sessions with messages as continuing", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(
    startupSource,
    /const hasExistingMessages = branch\.some\(\(entry\) => entry\.type === "message"\)/,
  );
  assert.match(startupSource, /const initial = hasExistingMessages/);
  assert.match(startupSource, /getLatestModelChange\(branch as unknown as SessionEntry\[\]\)/);
  assert.match(startupSource, /model: startupModel/);
  assert.doesNotMatch(startupSource, /const initial = sessionFile/);
  assert.doesNotMatch(startupSource, /sessionManager\.buildSessionContext\(\)/);
});

test("RPC session startup opens an existing session file only once and trusts its cwd", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const routeSource = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  const eventRouteSource = await readFile(new URL("../app/api/agent/[id]/events/route.ts", import.meta.url), "utf8");
  const autoNameRouteSource = await readFile(new URL("../app/api/sessions/[id]/auto-name/route.ts", import.meta.url), "utf8");

  assert.equal((startupSource.match(/SessionManager\.open\(/g) ?? []).length, 1);
  assert.match(startupSource, /const sessionCwd = sessionManager\.getCwd\(\)/);
  assert.match(startupSource, /projectTrustReloadOptions\(sessionCwd, agentDir\)/);
  assert.match(startupSource, /cwd: sessionCwd/);
  for (const route of [routeSource, eventRouteSource, autoNameRouteSource]) {
    assert.doesNotMatch(route, /SessionManager\.open\(/);
  }
});

test("RPC wrapper avoids per-chunk idle maintenance", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startSource = source.slice(
    source.indexOf("  start(): void"),
    source.indexOf("  beginExtensionBinding"),
  );

  assert.match(startSource, /IDLE_RESET_EVENT_TYPES\.has\(event\.type\)/);
  assert.doesNotMatch(startSource, /subscribe\(\(event: AgentEvent\) => \{\s*this\.resetIdleTimer\(\)/);
});

test("normal session teardown paths use graceful extension shutdown", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const deleteRouteSource = await readFile(new URL("../app/api/sessions/[id]/route.ts", import.meta.url), "utf8");
  const trustRouteSource = await readFile(new URL("../app/api/project-trust/route.ts", import.meta.url), "utf8");
  const idleSource = source.slice(
    source.indexOf("  private resetIdleTimer"),
    source.indexOf("  private persistBashOnlySession"),
  );
  const forkSource = source.slice(
    source.indexOf('case "fork"'),
    source.indexOf('case "clone"'),
  );
  const cloneSource = source.slice(
    source.indexOf('case "clone"'),
    source.indexOf('case "navigate_tree"'),
  );
  const replacementShutdownSource = source.slice(
    source.indexOf("  private async shutdownAfterSessionReplacement"),
    source.indexOf("  async send("),
  );

  assert.match(idleSource, /this\.shutdown\(\)/);
  assert.match(replacementShutdownSource, /await this\.shutdown\(\)/);
  assert.match(forkSource, /shutdownAfterSessionReplacement\("fork"\)/);
  assert.match(cloneSource, /shutdownAfterSessionReplacement\("clone"\)/);
  assert.match(deleteRouteSource, /await getRpcSession\(id\)\?\.shutdown\(\)/);
  assert.match(trustRouteSource, /await destroyRpcSessionsForCwd\(result\.cwd\)/);
});

test("clone copies the requested leaf into a child session", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const cloneSource = source.slice(
    source.indexOf('case "clone"'),
    source.indexOf('case "navigate_tree"'),
  );

  assert.match(cloneSource, /typeof command\.leafId === "string"/);
  assert.match(cloneSource, /branchHasAssistant/);
  assert.match(cloneSource, /createBranchedSession\(leafId\)/);
  assert.match(cloneSource, /cacheSessionPath\(newSessionId, clonedPath\)/);
  assert.match(cloneSource, /invalidateSessionListCache\(\)/);
  assert.match(cloneSource, /return \{ cancelled: false, newSessionId \}/);
});

test("fork_branch copies the selected assistant entry without replacing the source session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-quoted-branch-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  manager.appendMessage({ role: "user", content: "source prompt", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "selected response" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const selectedEntryId = manager.getLeafId();
  manager.appendMessage({ role: "user", content: "later prompt", timestamp: Date.now() });
  const sourceLeaf = manager.getLeafId();
  const sourceFile = manager.getSessionFile();
  const sourceSnapshot = await readFile(sourceFile, "utf8");
  let forkedFile;
  let disposed = false;
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: {},
    agent: { state: {} },
    dispose() { disposed = true; },
  });

  try {
    const result = await wrapper.send({ type: "fork_branch", entryId: selectedEntryId });
    const sessions = await SessionManager.list(root, sessionDir);
    const forkedInfo = sessions.find((session) => session.id === result.newSessionId);
    assert.ok(forkedInfo);
    forkedFile = forkedInfo.path;
    const forked = SessionManager.open(forkedFile, sessionDir);
    assert.equal(forked.getLeafId(), selectedEntryId);
    assert.equal(forked.getHeader().parentSession, sourceFile);
    assert.deepEqual(forked.getBranch().map((entry) => entry.id), manager.getBranch(selectedEntryId).map((entry) => entry.id));
    assert.equal(manager.getLeafId(), sourceLeaf);
    assert.equal(await readFile(sourceFile, "utf8"), sourceSnapshot);
    assert.equal(disposed, false);
  } finally {
    wrapper.destroy();
    if (forkedFile) await unlink(forkedFile);
    if (sourceFile) await unlink(sourceFile);
    await rmdir(sessionDir);
    await rmdir(root);
  }
});

test("fork before the first message persists a reopenable message-free child session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-root-fork-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  const settingsEntryId = manager.appendModelChange("test", "test-model");
  const firstEntryId = manager.appendMessage({ role: "user", content: "source prompt", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "source response" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const sourceFile = manager.getSessionFile();
  let forkedFile;
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: { emit: async () => {} },
    agent: { state: {} },
    dispose() {},
  });

  try {
    const result = await wrapper.send({ type: "fork", entryId: firstEntryId });
    const sessions = await SessionManager.list(root, sessionDir);
    const forkedInfo = sessions.find((session) => session.id === result.newSessionId);
    assert.ok(forkedInfo);
    forkedFile = forkedInfo.path;

    const forked = SessionManager.open(forkedFile, sessionDir);
    assert.equal(forked.getHeader().parentSession, sourceFile);
    assert.equal(forked.getLeafId(), settingsEntryId);
    assert.deepEqual(forked.getEntries(), [manager.getEntry(settingsEntryId)]);
  } finally {
    wrapper.destroy();
    if (forkedFile) await unlink(forkedFile);
    if (sourceFile) await unlink(sourceFile);
    await rmdir(sessionDir);
    await rmdir(root);
  }
});

test("session replacement rejects active work and clone writes one reopenable child", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-clone-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  manager.appendMessage({ role: "user", content: "clone fixture", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "fixture response" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const cloneLeafId = manager.getLeafId();
  manager.appendSessionInfo("source-only metadata");

  const sourceFile = manager.getSessionFile();
  let clonedFile;
  let releaseModelRefresh;
  let signalModelRefresh;
  const modelRefreshStarted = new Promise((resolve) => { signalModelRefresh = resolve; });
  const modelRefreshHeld = new Promise((resolve) => { releaseModelRefresh = resolve; });
  let releaseShutdown;
  let signalShutdown;
  const shutdownStarted = new Promise((resolve) => { signalShutdown = resolve; });
  const shutdownHeld = new Promise((resolve) => { releaseShutdown = resolve; });
  let finishPrompt;
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    prompt: (_message, options) => new Promise((resolve) => {
      finishPrompt = resolve;
      options.preflightResult?.("started");
    }),
    modelRuntime: {
      getModel: () => undefined,
      refresh: async () => {
        signalModelRefresh();
        await modelRefreshHeld;
      },
    },
    extensionRunner: {
      emit: async () => {
        signalShutdown();
        await shutdownHeld;
        throw new Error("fixture shutdown failure");
      },
    },
    agent: { state: {} },
    dispose() {},
  });

  try {
    const modelChange = wrapper.send({ type: "set_model", provider: "test", modelId: "missing" });
    await modelRefreshStarted;
    await assert.rejects(
      wrapper.send({ type: "clone" }),
      /Cannot clone while another session command is running/,
    );
    releaseModelRefresh();
    await assert.rejects(modelChange, /Model not found/);

    await wrapper.send({ type: "prompt", message: "keep this run active" });
    await assert.rejects(
      wrapper.send({ type: "fork", entryId: manager.getLeafId() }),
      /Cannot fork while the session is running/,
    );
    assert.ok(finishPrompt);
    finishPrompt();
    await new Promise((resolve) => setImmediate(resolve));

    const firstClone = wrapper.send({ type: "clone", leafId: cloneLeafId });
    await shutdownStarted;
    await assert.rejects(
      wrapper.send({ type: "clone" }),
      /Session is being copied to a new session/,
    );
    let shutdownErrorLog = "";
    const originalConsoleError = console.error;
    console.error = (...args) => { shutdownErrorLog = args.join(" "); };
    let result;
    try {
      releaseShutdown();
      result = await firstClone;
    } finally {
      console.error = originalConsoleError;
    }
    assert.match(shutdownErrorLog, /clone succeeded, but source session shutdown failed/);

    const sessions = await SessionManager.list(root, sessionDir);
    const clonedInfo = sessions.find((session) => session.id === result.newSessionId);
    assert.ok(clonedInfo);
    clonedFile = clonedInfo.path;

    const cloned = SessionManager.open(clonedFile, sessionDir);
    assert.equal(cloned.getHeader().parentSession, sourceFile);
    assert.equal(cloned.getLeafId(), cloneLeafId);
    assert.deepEqual(cloned.buildSessionContext().messages, manager.buildSessionContext().messages);
  } finally {
    wrapper.destroy();
    if (clonedFile) await unlink(clonedFile);
    if (sourceFile) await unlink(sourceFile);
    await rmdir(sessionDir);
    await rmdir(root);
  }
});

test("cancelled session replacement releases its lock", async () => {
  const manager = SessionManager.inMemory(tmpdir());
  let autoRetryEnabled = false;
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    setAutoRetryEnabled: (enabled) => { autoRetryEnabled = enabled; },
    extensionRunner: {},
    agent: { state: {} },
    dispose() {},
  });

  try {
    assert.deepEqual(await wrapper.send({ type: "fork", entryId: "missing" }), { cancelled: true });
    await wrapper.send({ type: "set_auto_retry", enabled: true });
    assert.equal(autoRetryEnabled, true);
  } finally {
    wrapper.destroy();
  }
});

test("clone cancels an assistant-free branch without adding to its saved source", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-clone-empty-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  manager.appendMessage({ role: "user", content: "no assistant yet", timestamp: Date.now() });
  const sourceFile = manager.getSessionFile();
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: { emit: async () => {} },
    agent: { state: {} },
    dispose() {},
  });

  try {
    const source = await readFile(sourceFile);
    assert.deepEqual(await wrapper.send({ type: "clone" }), { cancelled: true });
    assert.equal((await readdir(sessionDir)).length, 1);
    assert.deepEqual(await readFile(sourceFile), source);
  } finally {
    wrapper.destroy();
    await unlink(sourceFile);
    await rmdir(sessionDir);
    await rmdir(root);
  }
});

test("a manually saved draft appends the first user prompt on the same Pi session", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "magent-pi16-draft-"));
  const manager = SessionManager.create(directory, directory);
  const sessionFile = manager.getSessionFile();
  t.after(async () => {
    await unlink(sessionFile);
    await rmdir(directory);
  });

  manager.appendCustomEntry("meteoragent:fixture", { keep: true });
  assert.equal(persistPreparedSession(manager), sessionFile);
  assert.equal(persistPreparedSession(manager), sessionFile);
  const userId = manager.appendMessage({ role: "user", content: "First prompt", timestamp: Date.now() });

  const reopened = SessionManager.open(sessionFile, directory);
  assert.equal(reopened.getSessionId(), manager.getSessionId());
  assert.equal(reopened.getLeafId(), userId);
  assert.deepEqual(reopened.getEntries().map((entry) => entry.type), ["custom", "message"]);
  assert.equal((await readFile(sessionFile, "utf8")).split("\n").filter(Boolean).length, 3);
});

test("Pi plans declare and execute built-in tools while excluding same-name extensions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "magent-pi16-plan-"));
  const manager = SessionManager.create(directory, directory);
  const authPath = join(directory, "auth.json");
  const reportPath = join(directory, "report.txt");
  await writeFile(reportPath, "A local fixture for the built-in read tool.");
  const modelRuntime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
  await modelRuntime.setRuntimeApiKey("openai", "mock");
  const model = modelRuntime.getModel("openai", "gpt-4.1");
  const host = {};
  let extensionExecutions = 0;
  const probe = (pi) => {
    pi.registerTool({
      name: "grep",
      label: "Fixture grep",
      description: "Extension-owned grep fixture",
      parameters: { type: "object", properties: {} },
      async execute() {
        extensionExecutions += 1;
        return { content: [{ type: "text", text: "Extension fixture executed" }], details: {} };
      },
    });
  };
  const services = await createAgentSessionServices({
    cwd: directory,
    agentDir: directory,
    modelRuntime,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
    resourceLoaderOptions: { noExtensions: true, extensionFactories: [probe, AgentSessionWrapper.goalExtension(() => host.wrapper)] },
  });
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model });
  let calls = 0;
  const captures = [];
  session.agent.streamFunction = (_model, context) => {
    captures.push(context.messages);
    const first = calls++ === 0;
    const message = {
      role: "assistant",
      content: first ? [
        { type: "toolCall", id: "read-probe", name: "read", arguments: { path: reportPath } },
        { type: "toolCall", id: "grep-probe", name: "grep", arguments: {} },
      ] : [{ type: "text", text: "Finished" }],
      api: model.api, provider: model.provider, model: model.id,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: first ? "toolUse" : "stop", timestamp: Date.now(),
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: message.stopReason, message });
    return stream;
  };
  const wrapper = new AgentSessionWrapper(session);
  host.wrapper = wrapper;
  t.after(async () => {
    await wrapper.shutdown();
    await unlink(manager.getSessionFile()).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await unlink(authPath);
    await unlink(reportPath);
    await rmdir(directory);
  });
  wrapper.start();
  wrapper.beginExtensionBinding();
  wrapper.setActiveToolSelection(["read", "grep"], true);
  assert.ok(session.getActiveToolNames().includes("grep"));
  await wrapper.send({ type: "set_work_mode", mode: "plan" });
  assert.ok(session.getActiveToolNames().includes("read"));
  assert.equal(session.getActiveToolNames().includes("grep"), false);
  const done = new Promise((resolve) => wrapper.onEvent((event) => {
    if (event.type === "prompt_done") resolve();
  }));
  await wrapper.send({ type: "prompt", message: "Inspect the test fixtures" });
  await done;
  assert.equal(extensionExecutions, 0);
  const definitions = getCurrentTools(captures[0]).map(({ name }) => name);
  assert.ok(definitions.includes("read"));
  assert.equal(definitions.includes("grep"), false);
  const results = captures[1].filter((message) => message.role === "toolResult");
  assert.equal(results.find((message) => message.toolCallId === "read-probe").content[0].text,
    "A local fixture for the built-in read tool.");
  assert.equal(results.find((message) => message.toolCallId === "grep-probe").isError, true);
});

test("Plan's nested tool hook checks the selected tool's origin", async (t) => {
  const agent = { state: {} };
  const getAllTools = () => [
    { name: "read", sourceInfo: { source: "builtin", path: "builtin:read" } },
    { name: "grep", sourceInfo: { source: "extension", path: "<test-extension>" } },
  ];
  const wrapper = new AgentSessionWrapper({ agent, getAllTools, dispose() {} },
    { promptSelection: { version: 2, preset: null, mode: "plan" } });
  t.after(() => wrapper.destroy());
  let handleToolCall;
  await AgentSessionWrapper.goalExtension(() => wrapper).factory({
    on(name, handler) { if (name === "tool_call") handleToolCall = handler; },
    registerTool() {},
  });
  assert.equal(handleToolCall({ toolName: "read", parentToolCallId: "fixture" }), undefined);
  assert.equal(handleToolCall({ toolName: "grep", parentToolCallId: "fixture" }).block, true);
  assert.equal((await agent.beforeToolCall({ toolCall: { name: "grep" } })).block, true);
});

test("new-session route applies model scope during construction instead of follow-up commands", async () => {
  const source = await readFile(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");

  assert.match(source, /initialModel: \{ provider, modelId \}/);
  assert.match(source, /thinkingLevel: explicitThinkingLevel/);
  assert.doesNotMatch(source, /session\.send\(\{ type: "set_model"/);
  assert.doesNotMatch(source, /session\.send\(\{ type: "set_thinking_level"/);
  assert.match(source, /model: state\.model/);
  assert.match(source, /thinkingLevel: state\.thinkingLevel/);
});

test("prompt routes mark only preflight failures as rejected", async () => {
  const existingRoute = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  const newRoute = await readFile(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");

  for (const source of [existingRoute, newRoute]) {
    assert.match(source, /let promptAccepted = false/);
    assert.match(source, /await .*\.send\(/);
    assert.match(source, /promptAccepted = .*\.type === "prompt"/);
    assert.match(source, /commandType === "prompt" && !promptAccepted/);
  }
});

test("exact prompts are applied to provider context without mutating SDK transcript state", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const promptSource = source.slice(
    source.indexOf('case "prompt"'),
    source.indexOf('case "abort"'),
  );
  const exactPromptSource = source.slice(
    source.indexOf("private installExactSystemPromptContinuation"),
    source.indexOf("setActiveToolSelection"),
  );

  assert.match(promptSource, /preflightResult: \(disposition\) => \{[\s\S]*?if \(disposition === "started"\)[\s\S]*?acceptPreflight\(\)/);
  assert.match(exactPromptSource, /systemPrompt: this\.exactSystemPrompt!\(\)/);
  assert.doesNotMatch(source, /agent\.state\.systemPrompt\s*=/);
  assert.doesNotMatch(promptSource, /requestedToolNames/);
});

test("RPC session startup persists explicit preferences without replaying setters", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(startupSource, /persistExplicitStartupPreferences\(/);
  assert.match(startupSource, /modelDefaultChanged\) invalidateModelsCache\(\)/);
});

test("custom extension UI receives the fixed headless terminal facade", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const customUiSource = source.slice(
    source.indexOf("private requestExtensionCustomUi"),
    source.indexOf("private requestExtensionUi"),
  );

  assert.match(customUiSource, /createHeadlessCustomUiTui\(/);
  assert.match(customUiSource, /width,/);
});

test("reloading a session invalidates the models cache", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const reloadSource = source.slice(
    source.indexOf('case "reload"'),
    source.indexOf('case "abort_compaction"'),
  );

  assert.match(reloadSource, /await this\.inner\.reload\(\)/);
  assert.match(reloadSource, /invalidateModelsCache\(\)/);
});

test("session reload waits for an idle conversation and excludes new mutations while it applies settings", async (t) => {
  const sessionManager = SessionManager.inMemory();
  const queued = [];
  let calls = 0;
  let finishReload;
  let announceReload;
  const started = new Promise((resolve) => { announceReload = resolve; });
  const awaitingReload = new Promise((resolve) => { finishReload = resolve; });
  const inner = {
    sessionManager,
    agent: { state: {} },
    isBashRunning: true,
    getSteeringMessages: () => [],
    getFollowUpMessages: () => queued,
    getActiveToolNames: () => [],
    settingsManager: { setProjectTrusted() {} },
    extensionRunner: {},
    async reload() {
      calls++;
      announceReload();
      await awaitingReload;
    },
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner, { chatOnly: true });
  t.after(() => { finishReload(); wrapper.destroy(); });
  const reload = () => wrapper.send({ type: "reload" });
  await assert.rejects(reload(), /当前任务/);
  inner.isBashRunning = false;
  queued.push("pending");
  await assert.rejects(reload(), /排队消息/);
  queued.pop();
  assert.equal(calls, 0);

  const pending = reload();
  await started;
  assert.equal(wrapper.isRunning(), true);
  await assert.rejects(wrapper.send({ type: "prompt", message: "hello" }), /正在重新加载/);
  await assert.rejects(reload(), /正在重新加载/);
  finishReload();
  assert.deepEqual(await pending, { success: true });
  assert.equal(wrapper.isRunning(), false);
});

test("Computer Use observes the read-only preset and keeps deferred tools out of the default loadout", async (t) => {
  const tool = "computer_use_launch_app";
  const deferred = "computer_use_run_script";
  const readOnly = ["read", "grep", "find", "ls"];
  let active = [];
  const inner = {
    sessionManager: SessionManager.inMemory(),
    agent: { state: {} },
    settingsManager: { getDefaultTools: () => readOnly },
    getAllTools: () => [
      ...[...readOnly, tool, "research"].map((name) => ({ name })),
      { name: deferred, exposure: "deferred" },
    ],
    getActiveToolNames: () => active,
    setActiveToolsByName(names) { active = names; },
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const full = [...readOnly, "bash", "edit", "write"];
  wrapper.setActiveToolSelection(full);
  assert.ok(active.includes(tool));
  assert.ok(!active.includes(deferred));
  active.push(deferred);
  wrapper.setActiveToolSelection(full);
  assert.ok(active.includes(deferred));
  wrapper.setActiveToolSelection(readOnly);
  assert.deepEqual(active, [...readOnly, "research"]);
  assert.equal((await inner.agent.beforeToolCall({ toolCall: { name: tool } })).block, true);
  let nestedCall;
  AgentSessionWrapper.goalExtension(() => wrapper).factory({
    on(event, callback) { if (event === "tool_call") nestedCall = callback; },
    registerTool() {},
  });
  assert.equal(nestedCall({ parentToolCallId: "parent", toolName: tool }).block, true);
});

test("normal sessions restore persisted tool selections before loading resources", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const registrationSource = source.slice(
    source.indexOf("function registerRpcWrapper"),
    source.indexOf("const SUBAGENT_CONTROLLER"),
  );

  assert.match(startupSource, /readSessionToolSelection\(sessionManager\.getEntries\(\)/);
  assert.match(startupSource, /const selectedToolNames = subagentResources\?\.tools \?\? persistedToolNames \?\? requestedToolNames/);
  assert.match(startupSource, /appendSessionToolSelection\(sessionManager, requestedToolNames\)/);
  assert.ok(startupSource.indexOf("const chatOnly") < startupSource.indexOf("createAgentSessionServices("));
  assert.match(startupSource, /chatOnly\s*\? \{ \.\.\.CHAT_ONLY_RESOURCE_LOADER_OPTIONS, extensionFactories: \[createRelaySummaryPolicyExtension\(\)\] \}/);
  assert.match(startupSource, /const trustReloadOptions = subagentResources[\s\S]*?subagentLoadsResources[\s\S]*?projectTrustReloadOptions\(sessionCwd, agentDir\)/);
  assert.match(registrationSource, /if \(!wrapper\.isChatOnly\(\)\) wrapper\.beginExtensionBinding\(\)/);
});

test("crossing the Chat-only boundary persists and rebuilds the wrapper", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const switchSource = source.slice(
    source.indexOf("export async function setRpcSessionTools"),
    source.indexOf("export function getRunningRpcSessionIds"),
  );

  assert.match(switchSource, /!hasCurrentResourcePolicy\s*\|\| existing\.isChatOnly\(\) !== \(toolNames\.length === 0\)/);
  assert.match(switchSource, /appendSessionToolSelection\(existing\.inner\.sessionManager, toolNames\)/);
  assert.match(switchSource, /await existing\.shutdown\(\)/);
  assert.match(switchSource, /__recreate__\$\{randomUUID\(\)\}/);
  assert.match(switchSource, /sessionId: started\.realSessionId/);
});
