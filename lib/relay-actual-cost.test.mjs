import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { matchRelayImageUsageRecords, matchRelayUsageRecords, queryRelayActualCosts } = await jiti.import("./relay-actual-cost.ts");

const turn = (overrides = {}) => ({
  entryId: "entry-1",
  providerId: "meteor21c-k143",
  model: "grok-4.6",
  sessionId: "session-local",
  completedAt: Date.parse("2026-09-16T07:50:46.387Z"),
  inputTokens: 1021,
  outputTokens: 896,
  cacheReadTokens: 192,
  cacheWriteTokens: 0,
  estimatedCost: 0.007514,
  ...overrides,
});

const record = (overrides = {}) => ({
  id: 1,
  requestId: "request-1",
  model: "grok-4.6",
  createdAt: Date.parse("2026-09-16T07:50:46.389Z"),
  inputTokens: 1021,
  outputTokens: 896,
  cacheReadTokens: 192,
  cacheWriteTokens: 0,
  totalCost: 0.007514,
  actualCost: 0.0007514,
  rateMultiplier: 0.1,
  ...overrides,
});

test("matches the authoritative charge using the complete usage tuple and completion time", () => {
  assert.deepEqual(matchRelayUsageRecords([turn()], [record()]), {
    "entry-1": {
      actualCost: 0.0007514,
      totalCost: 0.007514,
      rateMultiplier: 0.1,
      matchedBy: "usage-and-time",
    },
  });
});

test("prefers the same session and rejects a record owned by another session", () => {
  const matching = record({ id: 2, sessionId: "session-local", createdAt: turn().completedAt + 20 });
  const other = record({ id: 3, sessionId: "session-other", createdAt: turn().completedAt + 1 });
  assert.equal(matchRelayUsageRecords([turn()], [other, matching])["entry-1"].matchedBy, "session");
  assert.deepEqual(matchRelayUsageRecords([turn()], [other]), {});
});

test("does not reuse one upstream charge for two local turns", () => {
  const result = matchRelayUsageRecords([
    turn(),
    turn({ entryId: "entry-2", completedAt: turn().completedAt + 1000 }),
  ], [record()]);
  assert.deepEqual(Object.keys(result), ["entry-1"]);
});

const imageCharge = (overrides = {}) => ({
  entryId: "image-marker-1",
  data: {
    version: 1,
    toolCallId: "image-call-1",
    anchorEntryId: "final-answer-1",
    providerId: "meteor21c-k143",
    modelId: "gpt-image-2",
    modelAlias: "meteor-gpt-image-2-abcd1234",
    imageCount: 1,
    completedAt: Date.parse("2026-09-16T07:50:46.387Z"),
    ...overrides,
  },
});

const imageRecord = (overrides = {}) => ({
  id: 21,
  requestId: "image-request-1",
  model: "gpt-image-2",
  createdAt: Date.parse("2026-09-16T07:50:49.000Z"),
  inputTokens: 9813,
  outputTokens: 16384,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalCost: 0.12,
  actualCost: 0.12,
  ...overrides,
});

test("matches an image charge by model and completion time", () => {
  const result = matchRelayImageUsageRecords([imageCharge()], [imageRecord()]);
  assert.equal(result["image-marker-1"].actualCost, 0.12);
  assert.equal(result["image-marker-1"].totalCost, 0.12);
});

test("returns image charges separately from text charges", async () => {
  const result = await queryRelayActualCosts([], {
    resolveProviderAccess: async () => ({
      accessToken: "jwt-secret",
      apiKeyId: "143",
      baseUrl: "https://relay.example.test",
    }),
    fetch: async () => new Response(JSON.stringify({ data: {
      items: [{
        id: 21,
        request_id: "image-request-1",
        model: "gpt-image-2",
        created_at: "2026-09-16T15:50:49.000+08:00",
        input_tokens: 9813,
        output_tokens: 16384,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        total_cost: 0.12,
        actual_cost: 0.12,
      }],
      pages: 1,
    } }), { status: 200 }),
  }, [imageCharge()]);

  assert.equal(result.actualRelayCost, 0);
  assert.equal(result.actualImageCost, 0.12);
  assert.equal(result.matchedImageChargeCount, 1);
  assert.equal(result.imageCharges[0].anchorEntryId, "final-answer-1");
  assert.equal(result.imageCharges[0].actualCost, 0.12);
  assert.equal(result.complete, true);
});

test("does not reuse one image ledger row for two requests", () => {
  const first = imageCharge();
  const second = imageCharge({
    toolCallId: "image-call-2",
    anchorEntryId: "final-answer-2",
    completedAt: first.data.completedAt + 1_000,
  });
  const result = matchRelayImageUsageRecords([first, second], [imageRecord()]);
  assert.equal(Object.keys(result).length, 1);
});

test("leaves equally-close duplicate image requests unmatched instead of guessing", () => {
  const first = imageCharge();
  const second = { ...imageCharge({ toolCallId: "image-call-2" }), entryId: "image-marker-2" };
  const result = matchRelayImageUsageRecords([first, second], [imageRecord()]);
  assert.deepEqual(result, {});
});

test("queries the JWT user usage endpoint and returns actual rather than catalogue cost", async () => {
  const calls = [];
  const result = await queryRelayActualCosts([turn()], {
    resolveProviderAccess: async () => ({
      accessToken: "jwt-secret",
      apiKeyId: "143",
      baseUrl: "https://relay.example.test",
    }),
    fetch: async (input, init) => {
      const url = new URL(input);
      calls.push({ url, authorization: init.headers.Authorization });
      return new Response(JSON.stringify({
        code: 0,
        data: {
          items: [{
            id: 1,
            request_id: "request-1",
            model: "grok-4.6",
            created_at: "2026-09-16T15:50:46.389+08:00",
            input_tokens: 1021,
            output_tokens: 896,
            cache_read_tokens: 192,
            cache_creation_tokens: 0,
            total_cost: 0.007514,
            actual_cost: 0.0007514,
            rate_multiplier: 0.1,
          }],
          page: 1,
          page_size: 100,
          pages: 1,
          total: 1,
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/api/v1/usage");
  assert.equal(calls[0].url.searchParams.get("api_key_id"), "143");
  assert.equal(calls[0].url.searchParams.get("timezone"), "Asia/Shanghai");
  assert.equal(calls[0].authorization, "Bearer jwt-secret");
  assert.equal(result.costs["entry-1"].actualCost, 0.0007514);
  assert.equal(result.actualRelayCost, 0.0007514);
  assert.equal(result.estimatedRelayCost, 0.007514);
  assert.equal(result.complete, true);
});

test("can reconcile a legacy provider through the account ledger without a key filter", async () => {
  let queriedUrl;
  const legacyTurn = turn({ providerId: "meteor21c-claude", model: "claude-sonnet-4-6" });
  const result = await queryRelayActualCosts([legacyTurn], {
    resolveProviderAccess: async () => ({
      accessToken: "jwt-secret",
      baseUrl: "https://relay.example.test",
    }),
    fetch: async (input) => {
      queriedUrl = new URL(input);
      return new Response(JSON.stringify({ data: { items: [{
        ...record({ model: "claude-sonnet-4-6" }),
        request_id: "legacy-request",
        created_at: "2026-09-16T15:50:46.389+08:00",
        input_tokens: 1021,
        output_tokens: 896,
        cache_read_tokens: 192,
        cache_creation_tokens: 0,
        total_cost: 0.007514,
        actual_cost: 0.0007514,
        rate_multiplier: 0.1,
      }], pages: 1 } }), { status: 200 });
    },
  });

  assert.equal(queriedUrl.searchParams.has("api_key_id"), false);
  assert.equal(result.costs["entry-1"].actualCost, 0.0007514);
  assert.equal(result.complete, true);
});
