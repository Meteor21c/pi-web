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
});

test("unknown relay aliases retain conservative defaults", () => {
  const [model] = resolveMixedRelayModels(["vendor-private-chat-v9"], "https://relay.example.test");
  assert.equal(model.reasoning, false);
  assert.deepEqual(model.input, ["text"]);
});
