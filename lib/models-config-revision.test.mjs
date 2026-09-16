import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { readModelsConfig, writeModelsConfig, modelsConfigRevision, writeModelsConfigIfCurrent } = await jiti.import("./models-config-store.ts");

test("stale model configuration snapshot cannot replace newly synchronized channels", () => {
  // Deliberately retained: no recursive cleanup is permitted in this workspace.
  const path = join(mkdtempSync(join(tmpdir(), "meteor-config-test-")), "models.json");
  const original = { providers: { custom: { baseUrl: "https://example.invalid" } } };
  writeModelsConfig(original, path);
  const revision = modelsConfigRevision(readModelsConfig(path));
  const synchronized = { providers: { ...original.providers, "meteor21c-k123": { api: "openai-responses" } } };
  writeModelsConfig(synchronized, path);
  assert.equal(writeModelsConfigIfCurrent(original, revision, path), null);
  assert.deepEqual(readModelsConfig(path), synchronized);
  const fresh = modelsConfigRevision(synchronized);
  const updated = { ...synchronized, userSetting: true };
  assert.equal(writeModelsConfigIfCurrent(updated, fresh, path), modelsConfigRevision(updated));
  assert.deepEqual(readModelsConfig(path), updated);
});
