import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  applyPlazaContextWindows,
  contextWindowsForModels,
  firstTierContextWindow,
  officialCostForModel,
  officialCostsForModels,
  parseRelayModelPlaza,
} = await jiti.import("./relay-model-plaza.ts");

const payload = {
  data: {
    groups: [{
      id: 13,
      name: "codex_pro",
      long_context_pricing_enabled: true,
      models: [{
        name: "gpt-5.6-luna",
        platform: "openai",
        pricing: {
          billing_mode: "token",
          intervals: [
            { min_tokens: 272000, max_tokens: null, tier_label: ">272K" },
            { min_tokens: 0, max_tokens: 272000, tier_label: "≤272K" },
          ],
        },
        official_pricing: {
          input_price: 0.000005,
          output_price: 0.00003,
          cache_read_price: 0.0000005,
          cache_write_price: 0.00000625,
        },
      }],
    }],
  },
};

test("extracts the exact first-tier max for a group and model", () => {
  const plaza = parseRelayModelPlaza(payload);
  assert.equal(firstTierContextWindow(plaza, "13", "GPT-5.6-LUNA"), 272_000);
  assert.deepEqual(contextWindowsForModels(plaza, 13, ["gpt-5.6-luna", "missing"]), {
    "gpt-5.6-luna": 272_000,
  });
});

test("does not invent a tier when the group disables long-context pricing", () => {
  const plaza = parseRelayModelPlaza(payload);
  plaza.groups[0].long_context_pricing_enabled = false;
  assert.equal(firstTierContextWindow(plaza, 13, "gpt-5.6-luna"), undefined);
});

test("converts exact official catalog prices to USD per million tokens", () => {
  const plaza = parseRelayModelPlaza(payload);
  assert.deepEqual(officialCostForModel(plaza, 13, "GPT-5.6-LUNA"), {
    input: 5,
    output: 30,
    cacheRead: 0.5,
    cacheWrite: 6.25,
  });
  assert.deepEqual(officialCostsForModels(plaza, 13, ["gpt-5.6-luna", "missing"]), {
    "gpt-5.6-luna": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
  });
});

test("applies synchronized limits while preserving conservative fallbacks", () => {
  const models = applyPlazaContextWindows([
    { id: "gpt-5.6-luna", contextWindow: 258_000 },
    { id: "other", contextWindow: 128_000 },
  ], { "gpt-5.6-luna": 272_000 }, {
    "gpt-5.6-luna": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
  });
  assert.equal(models[0].contextWindow, 272_000);
  assert.deepEqual(models[0].cost, { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 });
  assert.equal(models[1].contextWindow, 128_000);
});
