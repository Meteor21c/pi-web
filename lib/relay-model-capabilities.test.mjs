import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { resolveMixedRelayModels } = await jiti.import("./relay-models.ts");

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
    "deepseek-v4-flash-vision-exp",
  ], "https://relay.example.test");

  assert.deepEqual(
    { reasoning: byId(models, "grok-4.5").reasoning, input: byId(models, "grok-4.5").input },
    { reasoning: true, input: ["text", "image"] },
  );
  assert.deepEqual(byId(models, "gemini-3.5-flash").input, ["text", "image"]);
  assert.equal(byId(models, "gemma-4-31b-it").reasoning, true);
  assert.deepEqual(byId(models, "deepseek-v4-flash").input, ["text"]);
  assert.deepEqual(byId(models, "deepseek-v4-flash-vision-exp").input, ["text", "image"]);
  assert.equal(byId(models, "grok-4.5").thinkingLevelMap.xhigh, null);
  assert.equal(byId(models, "grok-4.6").thinkingLevelMap.xhigh, "xhigh");
});

test("known GPT and Claude relay models preserve extended reasoning levels", () => {
  const models = resolveMixedRelayModels([
    "gpt-5.4",
    "gpt-5.6-sol",
    "gpt-6-astra",
    "claude-opus-4-8",
    "claude-sonnet-4-6",
  ], "https://relay.example.test");

  assert.equal(byId(models, "gpt-5.4").thinkingLevelMap.xhigh, "xhigh");
  assert.equal(byId(models, "gpt-5.6-sol").thinkingLevelMap.max, "max");
  assert.equal(byId(models, "gpt-6-astra").thinkingLevelMap.xhigh, "xhigh");
  assert.equal(byId(models, "claude-opus-4-8").thinkingLevelMap.xhigh, "xhigh");
  assert.equal(byId(models, "claude-sonnet-4-6").thinkingLevelMap.xhigh, undefined);
  assert.equal(byId(models, "claude-sonnet-4-6").thinkingLevelMap.max, "max");
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

test("unknown relay aliases retain conservative defaults", () => {
  const [model] = resolveMixedRelayModels(["vendor-private-chat-v9"], "https://relay.example.test");
  assert.equal(model.reasoning, false);
  assert.deepEqual(model.input, ["text"]);
});
