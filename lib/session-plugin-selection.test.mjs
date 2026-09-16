import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  PLUGIN_SELECTION_TYPE,
  appendSessionPluginSelection,
  readSessionPluginSelection,
  selectionKey,
  validateSessionPluginSelection,
} = await createJiti(import.meta.url).import("./session-plugin-selection.ts");

function entry(data, customType = PLUGIN_SELECTION_TYPE) {
  return {
    type: "custom",
    customType,
    data,
    id: Math.random().toString(16),
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

test("missing plugin selection identifies a legacy session", () => {
  assert.equal(readSessionPluginSelection([]), undefined);
  assert.equal(readSessionPluginSelection([entry({ version: 1, plugins: [] }, "other")]), undefined);
});

test("an empty selection is distinct from a missing selection", () => {
  assert.deepEqual(readSessionPluginSelection([entry({ version: 1, plugins: [] })]), []);
});

test("newest valid selection wins and duplicate keys use the last value", () => {
  const entries = [
    entry({ version: 1, plugins: [{ source: "npm:a", scope: "global", enabled: true }] }),
    entry({ version: 2, plugins: [] }),
    entry({ version: 1, plugins: [{ source: "npm:b", scope: "project", enabled: true }] }),
    entry({ version: 1, plugins: [
      { source: "npm:a", scope: "global", enabled: false },
      { source: "npm:a", scope: "global", enabled: true },
    ] }),
  ];
  assert.deepEqual(readSessionPluginSelection(entries), [{ source: "npm:a", scope: "global", enabled: true }]);
  assert.equal(selectionKey("npm:a", "global"), "global\0npm:a");
});

test("malformed newer entries do not shadow an older valid snapshot", () => {
  const entries = [
    entry({ version: 1, plugins: [{ source: "npm:a", scope: "global", enabled: true }] }),
    entry({ version: 1, plugins: [{ source: "npm:b", scope: "bad", enabled: true }] }),
    entry({ version: 1, plugins: [{ source: "npm:c", scope: "project", enabled: "yes" }] }),
  ];
  assert.deepEqual(readSessionPluginSelection(entries), [{ source: "npm:a", scope: "global", enabled: true }]);
});

test("validation normalizes source and deduplicates entries", () => {
  assert.deepEqual(validateSessionPluginSelection([
    { source: " npm:a ", scope: "global", enabled: false },
    { source: "npm:a", scope: "global", enabled: true },
  ]), [{ source: "npm:a", scope: "global", enabled: true }]);
  assert.throws(() => validateSessionPluginSelection(undefined), /source, scope, enabled/);
});

test("appending a selection writes a versioned custom entry", () => {
  const calls = [];
  appendSessionPluginSelection({ appendCustomEntry: (...args) => calls.push(args) }, [
    { source: "npm:a", scope: "global", enabled: true },
  ]);
  assert.deepEqual(calls, [[PLUGIN_SELECTION_TYPE, {
    version: 1,
    plugins: [{ source: "npm:a", scope: "global", enabled: true }],
  }]]);
});
