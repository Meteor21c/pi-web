import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { parseRelayAccountUsage, queryRelayAccountUsage } = await jiti.import("./relay-account-usage.ts");
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });

const session = (accessToken) => ({
  accountId: "account-a",
  email: "user@example.test",
  accessToken,
  accessTokenExpiresAt: Date.now() + 60_000,
  updatedAt: Date.now(),
});

test("account usage parser allowlists authoritative dashboard counters", () => {
  const parsed = parseRelayAccountUsage({ data: {
    today_requests: 216,
    today_actual_cost: "4.28150276",
    today_tokens: 25_901_947,
    total_requests: 415,
    total_actual_cost: 12.496282305,
    access_token: "must-not-leak",
  } });
  assert.deepEqual(parsed, {
    todayRequests: 216,
    todayActualCost: 4.28150276,
    todayTokens: 25_901_947,
    totalRequests: 415,
    totalActualCost: 12.496282305,
  });
  assert.equal(JSON.stringify(parsed).includes("must-not-leak"), false);
});

test("account usage rejects incomplete or invalid counters", () => {
  assert.equal(parseRelayAccountUsage({ data: { today_requests: 1 } }), null);
  assert.equal(parseRelayAccountUsage({ data: {
    today_requests: -1,
    today_actual_cost: 0,
    today_tokens: 0,
    total_requests: 0,
    total_actual_cost: 0,
  } }), null);
});

test("account usage reads the user dashboard with the account JWT", async () => {
  let authorization;
  const result = await queryRelayAccountUsage("account-a", {
    baseUrl: "https://relay.example.test/",
    now: () => 123,
    readSession: async () => session("fake-jwt"),
    fetch: async (url, init) => {
      assert.equal(url, "https://relay.example.test/api/v1/usage/dashboard/stats");
      authorization = init.headers.Authorization;
      return response({ data: {
        today_requests: 2,
        today_actual_cost: 0.25,
        today_tokens: 300,
        total_requests: 4,
        total_actual_cost: 0.5,
      } });
    },
  });
  assert.equal(authorization, "Bearer fake-jwt");
  assert.deepEqual(result, {
    status: "ready",
    usage: { todayRequests: 2, todayActualCost: 0.25, todayTokens: 300, totalRequests: 4, totalActualCost: 0.5 },
    capturedAt: 123,
  });
});

test("account usage refreshes a rejected JWT once without exposing failures", async () => {
  let current = session("expired");
  let checks = 0;
  const seenTokens = [];
  const result = await queryRelayAccountUsage("account-a", {
    readSession: async () => current,
    checkSession: async () => {
      checks += 1;
      current = session("fresh");
      return { ok: true };
    },
    fetch: async (_url, init) => {
      seenTokens.push(init.headers.Authorization);
      if (seenTokens.length === 1) return response({}, 401);
      return response({ data: {
        today_requests: 3,
        today_actual_cost: 1,
        today_tokens: 10,
        total_requests: 5,
        total_actual_cost: 2,
      } });
    },
  });
  assert.equal(checks, 1);
  assert.deepEqual(seenTokens, ["Bearer expired", "Bearer fresh"]);
  assert.equal(result.status, "ready");
});
