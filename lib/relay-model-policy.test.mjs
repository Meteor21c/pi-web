import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  RELAY_GPT_DEFAULT_CONTEXT_WINDOW,
  resolveRelayContextWindow,
} = await jiti.import("./relay-model-policy.ts");
const { resolveMixedRelayModels } = await jiti.import("./relay-models.ts");
const { canonicalModelContextWindow } = await jiti.import("./model-capability-catalog.ts");
const { flattenModelsDevCatalog } = await jiti.import("./model-catalog.ts");
const { relayModelNeedsResponseRepair } = await jiti.import("./relay-config.ts");

test("Auto reads the exact route configuration before the model family default", () => {
  const id = "gpt-6.2-sol";
  const catalog = flattenModelsDevCatalog({
    openai: { models: { [id]: { limit: { context: 1_050_000 } } } },
    azure: { models: { [id]: { limit: { context: 1_500_000 } } } },
  });
  assert.equal(canonicalModelContextWindow(id, "openai-responses", "codex_特惠", catalog), 500_000);
  assert.equal(canonicalModelContextWindow(id, "openai-responses", undefined, catalog), 1_050_000);
  const [declared] = resolveMixedRelayModels([id], "https://relay.example.test",
    new Map([[id, { contextWindow: 800_000 }]]), catalog, "codex_特惠");
  assert.equal(declared.contextWindow, 800_000);
  assert.equal(declared.meteorAgentUpstreamContextWindow, 800_000);
  const [unknown] = resolveMixedRelayModels(["gpt-unknown-future"], "https://relay.example.test", new Map(), catalog);
  assert.equal(unknown.contextWindow, RELAY_GPT_DEFAULT_CONTEXT_WINDOW);
});

test("the first pricing tier is an Auto default and manual windows use the chosen value", () => {
  assert.equal(resolveRelayContextWindow("gpt-6.2-sol", 1_000_000), 1_000_000);
  assert.equal(resolveRelayContextWindow("gpt-6.2-sol", 512_000, 272_000), 512_000);
  assert.equal(resolveRelayContextWindow("gpt-6.2-sol", 128_000), 128_000);
  assert.equal(resolveRelayContextWindow("gpt-6.2-sol", undefined, 272_000), 272_000);
  assert.equal(resolveRelayContextWindow("gpt-6.2-sol", 0), 258_000);
  assert.equal(resolveRelayContextWindow("some-new-model"), 128_000);
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
