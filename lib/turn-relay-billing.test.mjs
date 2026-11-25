import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { summarizeTurnRelayBilling } = await jiti.import("./turn-relay-billing.ts");

function assistant(stopReason, input, cost = 0) {
  return {
    role: "assistant",
    provider: "meteor21c-k20",
    model: "gpt-6.2-sol",
    content: [],
    stopReason,
    usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: cost } },
  };
}

test("settles a turn with matched charges even when a failed or aborted attempt recorded no usage", () => {
  const messages = [
    assistant("toolUse", 100),
    assistant("error", 0),
    assistant("aborted", 0),
    assistant("stop", 200),
  ];
  const ids = ["tool", "error", "aborted", "final"];
  const billing = summarizeTurnRelayBilling(messages, ids, 0, 3, {
    tool: { actualCost: 0 },
    final: { actualCost: 1.033264976 },
  });
  assert.deepEqual(billing, {
    requestCount: 2,
    matchedCount: 2,
    matchedCost: 1.033264976,
    estimatedCost: undefined,
  });
});

test("keeps metered failed requests in the total and leaves incomplete estimates absent", () => {
  const messages = [assistant("error", 100, 0.04), assistant("stop", 200)];
  const ids = ["metered-error", "final"];
  const billing = summarizeTurnRelayBilling(messages, ids, 0, 1, { final: { actualCost: 0.02 } });
  assert.deepEqual(billing, {
    requestCount: 2,
    matchedCount: 1,
    matchedCost: 0.02,
    estimatedCost: undefined,
  });
});
