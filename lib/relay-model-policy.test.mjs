import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  RELAY_GPT_FIRST_TIER_CONTEXT_WINDOW,
  clampRelayContextWindow,
  relayContextWindowLimit,
} = await jiti.import("./relay-model-policy.ts");
const { resolveMixedRelayModels } = await jiti.import("./relay-models.ts");
const { relayModelNeedsResponseRepair } = await jiti.import("./relay-config.ts");

test("relay GPT and Codex models stay inside the first pricing tier", () => {
  const models = resolveMixedRelayModels([
    "gpt-5.6",
    "gpt-5.3-codex-spark",
    "codex-auto-review",
    "gpt-unknown-future",
  ], "https://relay.example.test");
  assert.equal(models.length, 4);
  for (const model of models) {
    assert.equal(model.contextWindow, RELAY_GPT_FIRST_TIER_CONTEXT_WINDOW);
  }
});

test("relay context policy clamps imported values but preserves lower choices", () => {
  assert.equal(clampRelayContextWindow("gpt-5.6", 400_000), 258_000);
  assert.equal(clampRelayContextWindow("gpt-5.6", 128_000), 128_000);
  assert.equal(clampRelayContextWindow("claude-sonnet", 1_000_000), 200_000);
  assert.equal(relayContextWindowLimit("some-new-model"), 128_000);
});

test("dedicated image endpoints never enter the conversational model registry", () => {
  const models = resolveMixedRelayModels([
    "image",
    "gpt-image-2",
    "grok-2-image-1212",
    "gemini-3.1-flash-image",
    "grok-4.5",
    "gemini-3-flash",
  ], "https://relay.example.test");
  assert.deepEqual(models.map((model) => model.id), ["grok-4.5", "gemini-3-flash"]);
});

test("relay GPT/Codex models retain the Responses protocol", () => {
  const models = resolveMixedRelayModels(["gpt-5.6", "gpt-6-astra"], "https://relay.example.test");
  assert.equal(models.find((model) => model.id === "gpt-5.6").api, "openai-responses");
  assert.equal(models.find((model) => model.id === "gpt-6-astra").api, "openai-responses");
  assert.equal(models.find((model) => model.id === "gpt-6-astra").baseUrl, "https://relay.example.test/v1");
});

test("all relay GPT/Codex models use the Responses repair compatibility", () => {
  assert.equal(relayModelNeedsResponseRepair("gpt-5.6-sol"), true);
  assert.equal(relayModelNeedsResponseRepair("gpt-6-astra"), true);
  assert.equal(relayModelNeedsResponseRepair("codex-auto-review"), true);
  assert.equal(relayModelNeedsResponseRepair("claude-sonnet-4-6"), false);
  assert.equal(relayModelNeedsResponseRepair("grok-4.6"), false);
});
