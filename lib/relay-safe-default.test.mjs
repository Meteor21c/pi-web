import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { getPreferredToolPreset } = await jiti.import("./tool-preset-preference.ts");
test("uses all tools by default and preserves an explicit chat-only choice", () => {
  assert.equal(getPreferredToolPreset(null), "full");
  assert.equal(getPreferredToolPreset({ getItem: () => "none" }), "none");
});
