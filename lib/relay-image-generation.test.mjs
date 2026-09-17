import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const imageGeneration = await jiti.import("./relay-image-generation.ts");

function group(overrides = {}) {
  return {
    accountId: "account-1",
    providerId: "meteor21c-aaccount1-k23",
    keyId: "23",
    keyName: "image绘图",
    maskedKey: "sk-abc...1234",
    imageModels: ["image"],
    syncedAt: 1,
    ...overrides,
  };
}

test("detects provider-neutral image model families without swallowing chat models", () => {
  for (const id of [
    "image",
    "gpt-image-2",
    "gemini-3.1-flash-image",
    "grok-2-image-1212",
    "grok-imagine-1.0",
    "qwen-image-3.0",
    "doubao-seedream-5-0",
    "flux-1.1-pro",
    "imagen-4",
  ]) {
    assert.equal(imageGeneration.isRelayImageGenerationModel(id), true, id);
  }
  for (const id of ["grok-4.5", "gemini-3-flash", "gpt-5.6", "claude-sonnet-4-6"]) {
    assert.equal(imageGeneration.isRelayImageGenerationModel(id), false, id);
  }
});

test("partitions mixed relay catalogs into chat and image endpoints", () => {
  assert.deepEqual(imageGeneration.partitionRelayModelIds([
    "gpt-5.6",
    "image",
    "gemini-3.1-flash-image",
    "gpt-5.6",
  ]), {
    chatModelIds: ["gpt-5.6"],
    imageModelIds: ["image", "gemini-3.1-flash-image"],
  });
});

test("writes extensible relay image providers without copying API keys into settings", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "magent-image-settings-"));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    theme: "dark",
    "pi-image-gen": {
      customProviders: {
        external: { api: "gemini", baseUrl: "https://example.test" },
      },
    },
  }));
  imageGeneration.syncRelayImageGenerationSettings([
    group({ imageModels: ["image", "grok-2-image-1212", "gemini-3.1-flash-image"] }),
  ], agentDir);

  const raw = readFileSync(join(agentDir, "settings.json"), "utf8");
  const settings = JSON.parse(raw);
  assert.equal(settings.theme, "dark");
  assert.ok(settings["pi-image-gen"].customProviders.external);
  const managed = Object.entries(settings["pi-image-gen"].customProviders)
    .find(([name]) => name.startsWith("magent-relay-"))[1];
  assert.equal(managed.api, "openai");
  assert.equal(managed.baseUrl, "https://api.meteor21c.fun/v1");
  assert.deepEqual(managed.models.map((model) => model.id), [
    "image",
    "grok-2-image-1212",
    "gemini-3.1-flash-image",
  ]);
  assert.match(managed.apiKey, /^\$MAGENT_RELAY_IMAGE_KEY_[A-F0-9]+$/);
  assert.equal(raw.includes("sk-live-secret"), false);
  assert.equal(settings["pi-image-gen"].defaultModel, "$MAGENT_RELAY_IMAGE_MODEL");
  assert.ok(settings["pi-image-gen"].magentDefaultModel.startsWith("meteor-image-"));
});

test("hydrates the plugin key from private auth storage and exposes only safe status", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "magent-image-auth-"));
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
    "meteor21c-aaccount1-k23": { type: "api_key", key: "sk-live-secret" },
  }));
  const groups = [group()];
  imageGeneration.syncRelayImageGenerationSettings(groups, agentDir);
  imageGeneration.hydrateRelayImageGenerationEnvironment(groups, agentDir);
  const envName = imageGeneration.relayImageKeyEnvironmentName("meteor21c-aaccount1-k23");
  assert.equal(process.env[envName], "sk-live-secret");
  const status = imageGeneration.getRelayImageGenerationStatus(groups, agentDir);
  assert.equal(JSON.stringify(status).includes("sk-live-secret"), false);
  assert.equal(status.models[0].modelId, "image");
  assert.equal(status.models[0].isDefault, true);
  imageGeneration.hydrateRelayImageGenerationEnvironment([], agentDir);
  assert.equal(process.env[envName], undefined);
});

test("switches the default across future image providers while preserving their remote ids", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "magent-image-default-"));
  const groups = [
    group({ imageModels: ["image", "grok-2-image-1212", "gemini-3.1-flash-image"] }),
  ];
  imageGeneration.syncRelayImageGenerationSettings(groups, agentDir);
  const selected = imageGeneration.setDefaultRelayImageModel(
    groups[0].providerId,
    "gemini-3.1-flash-image",
    groups,
    agentDir,
  );
  assert.equal(selected.modelId, "gemini-3.1-flash-image");
  assert.equal(imageGeneration.getRelayImageGenerationStatus(groups, agentDir).models
    .find((model) => model.modelId === "gemini-3.1-flash-image").isDefault, true);
  imageGeneration.syncRelayImageGenerationSettings(groups, agentDir);
  assert.equal(imageGeneration.getRelayImageGenerationStatus(groups, agentDir).models
    .find((model) => model.modelId === "gemini-3.1-flash-image").isDefault, true);
});
