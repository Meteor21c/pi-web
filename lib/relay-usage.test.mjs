import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { queryRelayUsage } = await jiti.import("./relay-usage.ts");

function localDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status });
}

const API_KEY = "sk-test-key";

test("(a) normal payload -> ready with correct today/topModels mapping (cross-day array uses only today)", async () => {
  const today = localDate(0);
  const yesterday = localDate(-1);
  const tomorrow = localDate(1);

  const payload = {
    balance: 143.98,
    remaining: 143.98,
    isValid: true,
    mode: "unrestricted",
    planName: "Sub2API",
    unit: "USD",
    daily_usage: [
      { date: yesterday, requests: 1, input_tokens: 10, output_tokens: 20, cache_read_tokens: 30, cache_write_tokens: 40, total_tokens: 100, cost: 0.1 },
      { date: today, requests: 4, input_tokens: 4, output_tokens: 7, cache_read_tokens: 0, cache_write_tokens: 17, total_tokens: 28, cost: 0.0006 },
      { date: tomorrow, requests: 9, input_tokens: 90, output_tokens: 80, cache_read_tokens: 70, cache_write_tokens: 60, total_tokens: 300, cost: 0.9 },
    ],
    model_stats: [
      { model: "gpt-5.6-sol", requests: 53, total_tokens: 8015986, cost: 30.52 },
      { model: "model-b", requests: 12, total_tokens: 5000, cost: 2.0 },
      { model: "model-c", requests: 8, total_tokens: 4000, cost: 1.5 },
      { model: "model-d", requests: 6, total_tokens: 3000, cost: 1.0 },
      { model: "model-e", requests: 4, total_tokens: 2000, cost: 0.5 },
      { model: "model-f", requests: 2, total_tokens: 1000, cost: 0.25 },
    ],
  };

  let calledUrl;
  const mockFetch = async (url, init) => {
    calledUrl = url;
    assert.equal(init.headers.Authorization, `Bearer ${API_KEY}`);
    return jsonResponse(200, payload);
  };

  const result = await queryRelayUsage({ getApiKey: () => API_KEY, fetch: mockFetch });

  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.report.balanceUsd, 143.98);
  assert.equal(result.report.mode, "unrestricted");

  assert.equal(result.report.today.date, today);
  assert.equal(result.report.today.requests, 4);
  assert.equal(result.report.today.inputTokens, 4);
  assert.equal(result.report.today.outputTokens, 7);
  assert.equal(result.report.today.cacheReadTokens, 0);
  assert.equal(result.report.today.cacheWriteTokens, 17);
  assert.equal(result.report.today.cost, 0.0006);

  assert.equal(result.report.topModels.length, 5);
  assert.equal(result.report.topModels[0].model, "gpt-5.6-sol");
  assert.equal(result.report.topModels[0].totalTokens, 8015986);
  assert.equal(result.report.topModels[0].cost, 30.52);
  assert.equal(result.report.topModels[0].requests, 53);
  assert.deepEqual(result.report.topModels.map((m) => m.model), [
    "gpt-5.6-sol", "model-b", "model-c", "model-d", "model-e",
  ]);

  assert.ok(calledUrl.endsWith("/v1/usage"));
});

test("(b) HTTP 401 -> query-failed with key-invalid hint", async () => {
  const mockFetch = async () => jsonResponse(401, { error: "unauthorized" });
  const result = await queryRelayUsage({ getApiKey: () => API_KEY, fetch: mockFetch });
  assert.equal(result.status, "query-failed");
  if (result.status !== "query-failed") return;
  assert.match(result.message, /invalid|unauthorized/i);
});

test("(c) fetch throws network error -> query-failed", async () => {
  const mockFetch = async () => {
    throw new Error("network down");
  };
  const result = await queryRelayUsage({ getApiKey: () => API_KEY, fetch: mockFetch });
  assert.equal(result.status, "query-failed");
  if (result.status !== "query-failed") return;
  assert.match(result.message, /network|proxy/i);
});

test("(d) daily_usage without a today entry -> today is all zero", async () => {
  const payload = {
    balance: 12.34,
    mode: "unrestricted",
    daily_usage: [
      { date: localDate(-2), requests: 5, input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4, total_tokens: 10, cost: 0.5 },
      { date: localDate(3), requests: 7, input_tokens: 9, output_tokens: 8, cache_read_tokens: 7, cache_write_tokens: 6, total_tokens: 30, cost: 0.7 },
    ],
    model_stats: [],
  };

  const result = await queryRelayUsage({
    getApiKey: () => API_KEY,
    fetch: async () => jsonResponse(200, payload),
  });

  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.report.balanceUsd, 12.34);
  assert.equal(result.report.today.date, "");
  assert.equal(result.report.today.requests, 0);
  assert.equal(result.report.today.inputTokens, 0);
  assert.equal(result.report.today.outputTokens, 0);
  assert.equal(result.report.today.cacheReadTokens, 0);
  assert.equal(result.report.today.cacheWriteTokens, 0);
  assert.equal(result.report.today.cost, 0);
  assert.deepEqual(result.report.topModels, []);
});

test("(e) missing apiKey -> auth-unavailable", async () => {
  const result = await queryRelayUsage({ getApiKey: () => undefined });
  assert.equal(result.status, "auth-unavailable");
});
