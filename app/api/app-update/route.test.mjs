import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("manual update checks bypass the in-memory release cache", () => {
  assert.match(source, /export async function GET\(request: Request\)/);
  assert.match(source, /searchParams\.get\("refresh"\) === "1"/);
  assert.match(source, /loadUpdateStatus\(forceRefresh\)/);
  assert.match(source, /if \(forceRefresh\) \{[\s\S]*?await fetchLatestVersion\(\)/);
});
