import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { jsonResponse } = await jiti.import("./json-response.ts");

test("leaves large JSON uncompressed for the HTTP server", async () => {
  const value = "large payload ".repeat(200);
  const response = jsonResponse({ value });

  assert.equal(response.headers.get("Content-Encoding"), null);
  assert.match(response.headers.get("Content-Type") ?? "", /^application\/json\b/);
  assert.deepEqual(await response.json(), { value });
});

test("keeps session responses uncached and preserves status and other headers", async () => {
  const response = jsonResponse({ error: "Session not found" }, {
    status: 404,
    headers: { "Cache-Control": "max-age=60", "X-Request-Id": "session-test" },
  });

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-Request-Id"), "session-test");
  assert.deepEqual(await response.json(), { error: "Session not found" });
});
