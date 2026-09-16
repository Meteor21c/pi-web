import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { queryRelayBilling } = await jiti.import("./relay-billing.ts");
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("billing returns only allowlisted live multiplier fields", async () => {
  let authorization;
  const result = await queryRelayBilling("meteor21c-aaccount-k7", {
    getApiKey: () => "sk-private",
    baseUrl: "https://relay.example.test",
    now: () => 123,
    fetch: async (_url, init) => {
      authorization = init.headers.Authorization;
      return response({ data: { effective_rate_multiplier: "0.25", rate_multiplier: 0.5, group_name: "fast", key: "must-not-leak" } });
    },
  });
  assert.equal(authorization, "Bearer sk-private");
  assert.deepEqual(result, {
    status: "ready",
    billing: {
      billing_scope: undefined,
      billing_type: undefined,
      group_rate_multiplier: undefined,
      rate_multiplier: 0.5,
      resolved_rate_multiplier: undefined,
      effective_rate_multiplier: 0.25,
      observed_at: undefined,
      group_name: "fast",
      platform: undefined,
      long_context_pricing_enabled: undefined,
    },
    capturedAt: 123,
  });
  assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
});

test("billing hides upstream failures and empty payloads", async () => {
  const deps = { getApiKey: () => "sk-private", baseUrl: "https://relay.example.test" };
  assert.deepEqual(await queryRelayBilling("meteor21c-aaccount-k7", { ...deps, fetch: async () => response({}, 503) }), { status: "unavailable" });
  assert.deepEqual(await queryRelayBilling("meteor21c-aaccount-k7", { ...deps, fetch: async () => response({ data: { key: "secret" } }) }), { status: "unavailable" });
});
