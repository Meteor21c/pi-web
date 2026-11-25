import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("anchors the reasoning popover within the composer controls on narrow screens", () => {
  assert.match(source, /className="composer-controls"[\s\S]*?<ReasoningControl/);
  assert.match(css, /\.composer-controls \{\s*position: relative/);
  assert.match(
    css,
    /\.reasoning-popover \{\s*position: absolute;\s*inset-inline-end: 0;[\s\S]*?width: min\(286px, 100%\)/,
  );
});
