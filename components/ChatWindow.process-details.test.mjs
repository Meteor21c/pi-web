import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("keeps activity details closed until the user opens them", () => {
  assert.match(source, /const \[open, setOpen\] = useState\(false\)/);
  assert.match(source, /onClick=\{\(\) => setOpen\(\(value\) => !value\)\}/);
  assert.doesNotMatch(source, /revealProcess|defaultExpanded/);
});
