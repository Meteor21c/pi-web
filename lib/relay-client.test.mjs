import test from "node:test";
import assert from "node:assert/strict";
import { syncRelayConfig } from "./relay-client.ts";

test("sync shares requests within account generation and emits configuration update", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  let calls = 0;
  let updates = 0;
  const target = new EventTarget();
  target.addEventListener("relay-config-updated", () => updates++);
  globalThis.window = target;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ ok: true, totalModelCount: 7, providers: [] });
  };
  try {
    const [a, b] = await Promise.all([syncRelayConfig(1), syncRelayConfig(1)]);
    assert.equal(calls, 1);
    assert.equal(updates, 1);
    assert.equal(a.totalModelCount, 7);
    assert.deepEqual(a, b);
    await syncRelayConfig(2);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
  }
});
