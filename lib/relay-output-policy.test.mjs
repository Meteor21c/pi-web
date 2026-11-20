import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);
const { installRelayResponseRepair } = await jiti.import("./relay-responses.ts");
const { resolveMixedRelayModels } = await jiti.import("./relay-models.ts");
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
