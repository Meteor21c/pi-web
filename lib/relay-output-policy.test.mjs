import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);
const { createRelaySummaryPolicyExtension, installRelayResponseRepair } = await jiti.import("./relay-responses.ts");
const { resolveMixedRelayModels } = await jiti.import("./relay-models.ts");
const { withProviderDefaultThinking } = await jiti.import("./model-auto-reasoning.ts");
const { preserveRelayProtocolSelections } = await jiti.import("./relay-config-save.ts");
const { readModelsConfig, writeModelsConfig } = await jiti.import("./models-config-store.ts");
const { upstreamRelayOutputTokenLimit } = await jiti.import("./relay-output-policy.ts");
const providerId = "meteor21c";
const messages = [{ role: "user", content: "Offline request fixture", timestamp: 1 }];

test("explicit output metadata wins over exact catalog limits; ambiguous max_tokens is ignored", () => {
  assert.equal(upstreamRelayOutputTokenLimit({ max_tokens: 4096, context_window: 32000 }), undefined);
  assert.equal(upstreamRelayOutputTokenLimit({ max_output_tokens: 96000, capabilities: { maxOutputTokens: 64000 } }), 64000);
  assert.equal(upstreamRelayOutputTokenLimit({ max_output_tokens: 0, limit: { output: 1.5 } }), undefined);
  const [model] = resolveMixedRelayModels(["claude-opus-4-8"], "https://relay.example.test",
    new Map([["claude-opus-4-8", { maxOutputTokens: 32768 }]]));
  assert.equal(model.meteorAgentMaxOutputTokensLimit, 32768);
  assert.equal(model.meteorAgentMaxOutputTokensSource, "relay");
  assert.equal(model.maxTokens, 32768);
});

test("saved Claude relay models use the thinking format supported by the actual SDK adapter", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "meteor-claude-thinking-test-"));
  const modelsPath = join(agentDir, "models.json");
  const opus = "claude-opus-5-5";
  const sonnet = "claude-sonnet-5-5";
  const legacy = "claude-sonnet-4-5";
  const models = resolveMixedRelayModels([opus, sonnet, legacy], "https://relay.example.test");
  const provider = {
    api: "anthropic-messages",
    baseUrl: "https://relay.example.test",
    // Simulate settings saved before the relay copied the SDK's compatibility flag.
    models: models.map((model) => ({ ...model, compat: { sendSessionAffinityHeaders: true } })),
  };
  writeModelsConfig({ providers: { [providerId]: provider } }, modelsPath);
  const runtime = await ModelRuntime.create({
    modelsPath, authPath: join(agentDir, "auth.json"), refreshOnCreate: false,
  });
  installRelayResponseRepair(runtime);

  for (const [id, effort, auto] of [
    [opus, "max", false],
    [opus, "low", false],
    [opus, undefined, true],
    [sonnet, "xhigh", false],
    [legacy, "high", false],
  ]) {
    const model = runtime.getModel(providerId, id);
    assert.ok(model);
    assert.equal(model.compat.forceAdaptiveThinking, undefined);
    const requests = [];
    const options = {
      apiKey: "offline-test-key",
      reasoning: effort,
      cacheRetention: "none",
      maxRetries: 0,
      fetch: async (url, init) => {
        const endpoint = new URL(url);
        assert.equal(endpoint.origin + endpoint.pathname, "https://relay.example.test/v1/messages");
        const request = JSON.parse(init.body);
        requests.push(request);
        if (id !== legacy && request.thinking && request.thinking.type !== "adaptive") {
          return Response.json({
            type: "error",
            error: { type: "invalid_request_error", message: `${id} requires adaptive thinking` },
          }, { status: 400 });
        }
        const frames = [
          { type: "message_start", message: {
            id: "msg_fixture", type: "message", role: "assistant", content: [], model: id,
            stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 },
          } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
          { type: "message_stop" },
        ];
        return new Response(frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""), {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    };
    const result = await runtime.completeSimple(model, { messages }, withProviderDefaultThinking(model, options, auto));
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.deepEqual(result.content, [{ type: "text", text: "OK" }]);
    assert.equal(requests.length, 1);
    const [body] = requests;
    if (id === legacy) {
      assert.equal(body.thinking.type, "enabled");
      assert.ok(body.thinking.budget_tokens > 0);
      assert.equal(body.output_config, undefined);
    } else if (auto) {
      assert.equal(body.thinking, undefined);
      assert.equal(body.output_config, undefined);
    } else {
      assert.equal(body.thinking.type, "adaptive");
      assert.equal(body.thinking.budget_tokens, undefined);
      assert.deepEqual(body.output_config, { effort });
    }
  }
});

test("output auto, manual and bounded protocols through the actual pinned SDK request body", async (t) => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(join(tmpdir(), "meteor-relay-output-test-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  });
  const modelsPath = join(agentDir, "models.json");
  const legacy = { id: "deepseek-v4.1-flash", maxTokens: 16384 };
  const autoOnly = resolveMixedRelayModels(["vendor-private-responses"], "https://relay.example.test")[0];
  const responseModel = { ...autoOnly, id: "gpt-private-responses", api: "openai-responses", maxTokens: 25_000 };
  const anthropic = { id: "claude-private-anthropic", api: "anthropic-messages", baseUrl: "https://relay.example.test" };
  const fixture = (relayModels) => ({
    providers: {
      [providerId]: { baseUrl: "https://relay.example.test/v1", api: "openai-completions", models: relayModels },
      other: { baseUrl: "https://other.example.test/v1", api: "openai-completions", models: [{ id: "other-chat", maxTokens: 4096 }] },
    },
  });
  writeModelsConfig(fixture([legacy, responseModel, anthropic]));
  const runtime = await ModelRuntime.create({ modelsPath, authPath: join(agentDir, "auth.json") });
  installRelayResponseRepair(runtime);
  const capture = async (id, opts = {}, provider = providerId, mode = "simple") => {
    const model = runtime.getModel(provider, id);
    assert.ok(model);
    const requests = [];
    const requestOptions = {
      apiKey: "offline-test-key",
      cacheRetention: "none",
      maxRetries: 0,
      ...opts,
      fetch: async (_url, init) => {
        requests.push(JSON.parse(init.body));
        // Stop before any external I/O. A mock stream is unnecessary for
        // verifying what was already serialized into the HTTP request.
        throw new Error("Offline test captured request");
      },
    };
    const result = await (mode === "simple"
      ? runtime.completeSimple(model, { messages }, requestOptions)
      : runtime.stream(model, { messages }, requestOptions).result());
    assert.equal(requests.length, 1, result.errorMessage);
    return requests[0];
  };
  const assertAuto = (body) => {
    for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
      assert.equal(Object.hasOwn(body, field), false, field);
    }
  };
  const completionLimit = (body) => body.max_tokens ?? body.max_completion_tokens;

  assertAuto(await capture(legacy.id));
  const responsesAuto = await capture(responseModel.id, {
    reasoning: "high",
    onPayload: (payload) => ({ ...payload, metadata: { existing: "hook preserved" } }),
  });
  assertAuto(responsesAuto);
  assert.equal(responsesAuto.reasoning, undefined);
  assert.deepEqual(responsesAuto.metadata, { existing: "hook preserved" });
  assertAuto(await capture(responseModel.id, {}, providerId, "raw"));
  assert.equal(completionLimit(await capture(legacy.id, { maxTokens: 24 })), 24);
  assert.equal((await capture(responseModel.id, { maxTokens: 24 })).max_output_tokens, 24);
  assert.equal(completionLimit(await capture("other-chat", {}, "other")), 4096);
  assert.equal((await capture(anthropic.id)).max_tokens, 16_384);

  const synchronized = resolveMixedRelayModels([legacy.id], "https://relay.example.test",
    new Map([[legacy.id, { maxOutputTokens: 32256 }]]));
  const previous = { models: [{
    ...legacy,
    meteorAgentMaxOutputTokensOverride: 48000,
    meteorAgentContextWindowOverride: 30000,
  }] };
  const refreshed = preserveRelayProtocolSelections(synchronized, previous);
  assert.equal(refreshed[0].meteorAgentMaxOutputTokensOverride, 48000);
  const responseManual = { ...responseModel, meteorAgentMaxOutputTokensOverride: 32768 };
  const anthropicLimit = { ...anthropic, meteorAgentMaxOutputTokensLimit: 24000, meteorAgentMaxOutputTokensSource: "relay" };
  writeModelsConfig(fixture([...refreshed, responseManual, anthropicLimit]));
  const stored = readModelsConfig().providers[providerId].models;
  assert.equal(stored[0].maxTokens, 30000); // Metadata cannot exceed total context.
  assert.equal(stored[0].meteorAgentMaxOutputTokensOverride, 48000);
  await runtime.refresh({ allowNetwork: false });
  const completionManual = completionLimit(await capture(legacy.id));
  assert.ok(completionManual < 30000 && completionManual > 24000); // Actual token estimate + safety reserve.
  assert.equal((await capture(responseModel.id)).max_output_tokens, 32768);
  assert.equal((await capture(anthropic.id)).max_tokens, 24000);
  assert.equal((await capture(anthropic.id, { maxTokens: 4096 })).max_tokens, 4096);

  writeModelsConfig(fixture([{ ...stored[0], meteorAgentMaxOutputTokensOverride: undefined }]));
  const cleared = readModelsConfig().providers[providerId].models[0];
  assert.equal(cleared.meteorAgentMaxOutputTokensOverride, undefined);
  assert.equal(preserveRelayProtocolSelections(synchronized, { models: [cleared] })[0].meteorAgentMaxOutputTokensOverride, undefined);
  assertAuto(await capture(legacy.id));
});

test("relay summaries follow the SDK model ceiling while adjacent chat requests retain Auto output", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "meteor-relay-summary-test-"));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  });

  const modelId = "gpt-test-summary";
  const modelConfig = (override) => ({ providers: {
    [providerId]: {
      api: "openai-responses", baseUrl: "https://relay.example.test/v1",
      models: [{ id: modelId, contextWindow: 16_384, maxTokens: 8192, meteorAgentMaxOutputTokensOverride: override }],
    },
  } });
  writeModelsConfig(modelConfig());
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), refreshOnCreate: false,
  });
  await modelRuntime.setRuntimeApiKey(providerId, "offline-test-key");
  installRelayResponseRepair(modelRuntime);
  const model = modelRuntime.getModel(providerId, modelId);
  assert.ok(model);

  const requests = [];
  let nextInputUsage;
  let failNextRequest = false;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://relay.example.test/v1/responses");
    requests.push(JSON.parse(init.body));
    if (failNextRequest) {
      failNextRequest = false;
      return Response.json({ error: { code: "context_length_exceeded", message: "Maximum context length exceeded" } }, { status: 400 });
    }
    const promptTokens = nextInputUsage ?? 20;
    nextInputUsage = undefined;
    const response = { id: "resp_fixture", status: "in_progress", output: [] };
    const content = { type: "output_text", text: "Fixture summary or answer", annotations: [] };
    const message = { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [content] };
    const frames = [
      { type: "response.created", response },
      { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
      { type: "response.content_part.added", output_index: 0, content_index: 0, part: { ...content, text: "" } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: content.text },
      { type: "response.output_item.done", output_index: 0, item: message },
      { type: "response.completed", response: { ...response, status: "completed", output: [message], usage: {
        input_tokens: promptTokens, output_tokens: 4, total_tokens: promptTokens + 4,
      } } },
    ];
    return new Response(frames.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  };

  const services = await createAgentSessionServices({
    cwd: agentDir, agentDir, modelRuntime,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 64 },
      branchSummary: { reserveTokens: 1000 },
      retry: { enabled: false },
    }),
    resourceLoaderOptions: { noExtensions: true, extensionFactories: [createRelaySummaryPolicyExtension()] },
  });

  async function startSession(testCase) {
    const sessionManager = SessionManager.inMemory(agentDir);
    const { session } = await createAgentSessionFromServices({ services, sessionManager, model, tools: [] });
    testCase.after(() => session.dispose());
    await session.bindExtensions({ mode: "rpc" });
    await session.prompt("First topic with enough text to contribute to the kept context. ".repeat(5));
    await session.prompt("Second topic with enough text to contribute to the kept context. ".repeat(5));
    return { session, sessionManager };
  }

  await t.test("manual compaction and branch summary use the SDK's default", async (testCase) => {
    const { session, sessionManager } = await startSession(testCase);
    assert.equal(requests.at(-1).max_output_tokens, undefined);
    const firstUser = sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user");
    assert.ok(firstUser);

    await session.compact();
    assert.equal(requests.at(-1).max_output_tokens, model.maxTokens);
    await session.prompt("Continue the conversation after summarization.");
    assert.equal(requests.at(-1).max_output_tokens, undefined);

    const navigation = await session.navigateTree(firstUser.id, { summarize: true });
    assert.equal(navigation.cancelled, false);
    assert.equal(requests.at(-1).max_output_tokens, model.maxTokens);
  });

  await t.test("automatic threshold compaction also uses the SDK's default", async (testCase) => {
    const { session } = await startSession(testCase);
    const events = [];
    session.subscribe((event) => events.push(event));
    const before = requests.length;
    nextInputUsage = model.contextWindow - 500;
    await session.prompt("A request near the context window threshold.");
    assert.ok(events.some((event) => event.type === "compaction_start" && event.reason === "threshold"));
    assert.deepEqual(requests.slice(before).map((body) => body.max_output_tokens), [undefined, model.maxTokens]);
  });

  await t.test("overflow recovery uses the SDK default for the summary and leaves the chat retry in Auto", async (testCase) => {
    const { session } = await startSession(testCase);
    const events = [];
    session.subscribe((event) => events.push(event));
    const before = requests.length;
    failNextRequest = true;
    await session.prompt("A request whose first attempt exceeds the provider context.");
    assert.ok(events.some((event) => event.type === "compaction_start" && event.reason === "overflow"));
    assert.deepEqual(requests.slice(before).map((body) => body.max_output_tokens), [undefined, model.maxTokens, undefined]);
  });

  await t.test("a manually configured limit takes effect for the summary in an already open session", async (testCase) => {
    const { session } = await startSession(testCase);
    writeModelsConfig(modelConfig(1200));
    await session.compact();
    assert.equal(requests.at(-1).max_output_tokens, 1200);
  });
});
