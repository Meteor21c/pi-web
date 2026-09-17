import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const selection = await jiti.import("./session-image-model-selection.ts");
const imageGeneration = await jiti.import("./relay-image-generation.ts");

test("persists and reads the newest session-local image model", () => {
  const entries = [];
  const manager = {
    appendCustomEntry(customType, data) {
      entries.push({ type: "custom", customType, data });
      return String(entries.length);
    },
  };
  selection.appendSessionImageModelSelection(manager, {
    providerId: "group-a",
    modelId: "image",
    alias: "meteor-image-a",
  });
  selection.appendSessionImageModelSelection(manager, {
    providerId: "group-b",
    modelId: "gemini-3.1-flash-image",
    alias: "meteor-gemini-b",
  });
  assert.deepEqual(selection.readSessionImageModelSelection(entries), {
    version: 1,
    providerId: "group-b",
    modelId: "gemini-3.1-flash-image",
    alias: "meteor-gemini-b",
  });
});

test("a session load resolves the plugin placeholder to its own image model", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "magent-image-session-"));
  const group = {
    accountId: "account-1",
    providerId: "provider-1",
    keyId: "1",
    keyName: "image",
    maskedKey: "sk-...",
    imageModels: ["image", "gemini-3.1-flash-image"],
    syncedAt: 1,
  };
  imageGeneration.syncRelayImageGenerationSettings([group], agentDir);
  const models = imageGeneration.getRelayImageGenerationStatus([group], agentDir).models;
  const globalAlias = models.find((model) => model.modelId === "image").alias;
  const sessionAlias = models.find((model) => model.modelId === "gemini-3.1-flash-image").alias;
  const entries = [{
    type: "custom",
    customType: selection.IMAGE_MODEL_SELECTION_TYPE,
    data: { version: 1, providerId: "provider-1", modelId: "gemini-3.1-flash-image", alias: sessionAlias },
  }];

  await imageGeneration.withRelayImageGenerationSession(
    { getEntries: () => entries },
    async () => assert.equal(process.env.MAGENT_RELAY_IMAGE_MODEL, sessionAlias),
    [group],
    agentDir,
  );

  assert.equal(process.env.MAGENT_RELAY_IMAGE_MODEL, globalAlias);
});
