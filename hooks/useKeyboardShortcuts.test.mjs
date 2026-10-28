import assert from "node:assert/strict";
import test from "node:test";
import { isNewSessionShortcut } from "./useKeyboardShortcuts.ts";

test("new-session shortcut handles macOS dead keys and preserves Windows AltGr input", () => {
  const check = (overrides) => isNewSessionShortcut({ key: "n", code: "KeyN", ctrlKey: true, altKey: true, ...overrides });
  assert.equal(check({}), true);
  assert.equal(check({ key: "N" }), true);
  assert.equal(check({ key: "Dead" }), true);
  assert.equal(check({ key: "ń" }), false);
  assert.equal(check({ key: "}" }), false);
  assert.equal(check({ key: "Dead", code: "KeyM" }), false);
  assert.equal(check({ ctrlKey: false }), false);
  assert.equal(check({ altKey: false }), false);
  assert.equal(check({ code: null }), true);
});
