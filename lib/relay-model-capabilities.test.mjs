import assert from "node:assert/strict";
import test from "node:test";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { resolveMixedRelayModels } = await jiti.import("./relay-models.ts");
const { STANDARD_THINKING_LEVEL_MAP } = await jiti.import("./model-capabilities.ts");
const { withProviderDefaultThinking } = await jiti.import("./model-auto-reasoning.ts");

function byId(models, id) {
  const model = models.find((entry) => entry.id === id);
  assert.ok(model, `missing model ${id}`);
  return model;
}

test("known common relay models receive exact SDK capabilities", () => {
  const models = resolveMixedRelayModels([
    "grok-4.5",
    "grok-4.6",
    "gemini-3.5-flash",
    "gemma-4-31b-it",
    "deepseek-v4-flash",
    "deepseek-v4-flash-0731",
    "deepseek-v4-flash-vision-exp",
    "deepseek-v4.1-flash",
  ], "https://relay.example.test");

  assert.deepEqual(
    { reasoning: byId(models, "grok-4.5").reasoning, input: byId(models, "grok-4.5").input },
    { reasoning: true, input: ["text", "image"] },
  );
  assert.deepEqual(byId(models, "gemini-3.5-flash").input, ["text", "image"]);
  assert.equal(byId(models, "gemma-4-31b-it").reasoning, true);
  assert.deepEqual(byId(models, "deepseek-v4-flash").input, ["text"]);
  assert.deepEqual(byId(models, "deepseek-v4-flash-0731").input, ["text"]);
  assert.deepEqual(getSupportedThinkingLevels(byId(models, "deepseek-v4-flash-0731")), ["high", "max"]);
  assert.deepEqual(byId(models, "deepseek-v4-flash-vision-exp").input, ["text", "image"]);
  assert.deepEqual(byId(models, "deepseek-v4.1-flash").input, ["text", "image"]);
  assert.deepEqual(getSupportedThinkingLevels(byId(models, "deepseek-v4.1-flash")), ["low", "high", "max"]);
  assert.equal(byId(models, "grok-4.5").thinkingLevelMap.xhigh, "xhigh");
  assert.equal(byId(models, "grok-4.6").thinkingLevelMap.xhigh, "xhigh");
});

test("known GPT and Claude relay models preserve extended reasoning levels", () => {
  const models = resolveMixedRelayModels([
    "gpt-5.4",
    "gpt-5.6-sol",
    "gpt-6-astra",
    "claude-opus-4-8",
    "claude-sonnet-4-6",
    "claude-fable-5.1",
    "claude-fable-5-1",
  ], "https://relay.example.test");

  assert.equal(byId(models, "gpt-5.4").thinkingLevelMap.xhigh, "xhigh");
  assert.equal(byId(models, "gpt-5.6-sol").thinkingLevelMap.max, "max");
  assert.equal(byId(models, "gpt-6-astra").thinkingLevelMap.xhigh, "xhigh");
  assert.equal(byId(models, "claude-opus-4-8").thinkingLevelMap.xhigh, "xhigh");
  assert.equal(byId(models, "claude-sonnet-4-6").thinkingLevelMap.xhigh, undefined);
  assert.equal(byId(models, "claude-sonnet-4-6").thinkingLevelMap.max, "max");
  assert.equal(byId(models, "claude-fable-5.1").thinkingLevelMap.xhigh, "xhigh");
  assert.equal(byId(models, "claude-fable-5.1").thinkingLevelMap.max, "max");
  assert.equal(byId(models, "claude-fable-5-1").thinkingLevelMap.xhigh, "xhigh");
  assert.equal(byId(models, "claude-fable-5-1").thinkingLevelMap.max, "max");
});

test("an exact legacy DeepSeek ID remains text-only unless the relay reports vision", () => {
  const id = "deepseek-v4-flash";
  const [legacy] = resolveMixedRelayModels([id], "https://relay.example.test");
  const [vision] = resolveMixedRelayModels([id], "https://relay.example.test", new Map([[id, { input: ["text", "image"] }]]));
  assert.deepEqual(legacy.input, ["text"]);
  assert.equal(legacy.reasoning, true);
  assert.deepEqual(vision.input, ["text", "image"]);
});

test("Fable fallback prices use the official card for both relay id spellings", () => {
  const models = resolveMixedRelayModels([
    "claude-fable-5.1",
    "claude-fable-5-1",
    "claude-fable-5",
  ], "https://relay.example.test");

  assert.deepEqual(byId(models, "claude-fable-5.1").cost, {
    input: 10,
    output: 50,
    cacheRead: 0.25,
    cacheWrite: 12.5,
  });
  assert.deepEqual(byId(models, "claude-fable-5-1").cost, {
    input: 10,
    output: 50,
    cacheRead: 0.25,
    cacheWrite: 12.5,
  });
  assert.deepEqual(byId(models, "claude-fable-5").cost, {
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheWrite: 12.5,
  });
});

test("unknown relay aliases allow images and delegate thinking effort to the provider", () => {
  const [model] = resolveMixedRelayModels(["vendor-private-chat-v9"], "https://relay.example.test");
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.input, ["text", "image"]);
  assert.deepEqual(Object.values(model.thinkingLevelMap), Array(7).fill(null));
  assert.deepEqual(getSupportedThinkingLevels(model), []);
  const payload = { model: model.id, reasoning_effort: "high", thinking: { type: "disabled" } };
  const options = withProviderDefaultThinking(model, {});
  options.onPayload(payload, model);
  assert.deepEqual(payload, { model: model.id });
});

test("the manual preset exposes five distinct thinking levels", () => {
  const model = { reasoning: true, thinkingLevelMap: STANDARD_THINKING_LEVEL_MAP };
  assert.deepEqual(getSupportedThinkingLevels(model), ["low", "medium", "high", "xhigh", "max"]);
});
