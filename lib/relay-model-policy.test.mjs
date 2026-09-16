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
