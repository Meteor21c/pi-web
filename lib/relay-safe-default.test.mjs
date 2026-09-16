import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { defaultToolPreset, getPreferredToolPreset } = await jiti.import("./tool-preset-preference.ts");
test("brand default is chat-only without changing an explicit user choice", () => {
  assert.equal(defaultToolPreset("1"), "none");
  assert.equal(defaultToolPreset("0"), "default");
  assert.equal(getPreferredToolPreset({ getItem: () => "full" }), "full");
});
