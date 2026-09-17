import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const billing = await jiti.import("./relay-image-billing.ts");
const imageGeneration = await jiti.import("./relay-image-generation.ts");

const providerId = "meteor21c-k143";
const remoteModel = "gpt-image-2";
const providerLabel = `${imageGeneration.relayImageProviderName(providerId)} (custom)`;
const modelAlias = imageGeneration.relayImageModelAlias(providerId, remoteModel);
const groups = [{
  providerId,
  groupName: "绘图",
  keyName: "绘图",
  imageModels: [remoteModel],
}];

function imageEntries() {
  const user = {
    type: "message",
    id: "user-1",
    parentId: null,
    timestamp: "2026-09-16T07:49:00.000Z",
    message: { role: "user", content: "生成图片" },
  };
  const toolCall = {
    type: "message",
    id: "assistant-tool-1",
    parentId: user.id,
    timestamp: "2026-09-16T07:49:10.000Z",
    message: {
      role: "assistant",
      provider: providerId,
      model: "grok-4.6",
      content: [{ type: "toolCall", toolCallId: "image-call-1", toolName: "image_generate", input: {} }],
    },
  };
  const result = {
    type: "message",
    id: "tool-result-1",
    parentId: toolCall.id,
    timestamp: "2026-09-16T07:50:46.387Z",
    message: {
      role: "toolResult",
      toolCallId: "image-call-1",
      toolName: "image_generate",
      content: [{ type: "text", text: "Generated" }],
      details: {
        model: modelAlias,
        provider: providerLabel,
        images: [{ path: "/tmp/generated.png", mimeType: "image/png" }],
      },
      isError: false,
    },
  };
  const finalAnswer = {
    type: "message",
    id: "assistant-final-1",
    parentId: result.id,
    timestamp: "2026-09-16T07:50:50.000Z",
    message: {
      role: "assistant",
      provider: providerId,
      model: "grok-4.6",
      content: [{ type: "text", text: "已生成" }],
    },
  };
  const laterCuratedResult = {
    type: "custom",
    id: "curated-result-1",
    parentId: finalAnswer.id,
    timestamp: "2026-09-16T07:51:00.000Z",
    customType: "web-search-results",
    data: {},
  };
  const laterAssistant = {
    type: "message",
    id: "assistant-later-1",
    parentId: laterCuratedResult.id,
    timestamp: "2026-09-16T07:51:01.000Z",
    message: {
      role: "assistant",
      provider: providerId,
      model: "grok-4.6",
      content: [{ type: "text", text: "后续无关回复" }],
    },
  };
  return [user, toolCall, result, finalAnswer, laterCuratedResult, laterAssistant];
}

test("parses only successful image results and resolves the managed provider/model", () => {
  const entries = imageEntries();
  const candidate = billing.parseRelayImageBillingCandidate(entries[2], groups);
  assert.deepEqual(candidate, {
    toolCallId: "image-call-1",
    providerId,
    modelId: remoteModel,
    modelAlias,
    imageCount: 1,
    completedAt: Date.parse("2026-09-16T07:50:46.387Z"),
  });

  const failed = {
    ...entries[2],
    id: "tool-result-failed",
    message: { ...entries[2].message, isError: true },
  };
  assert.equal(billing.parseRelayImageBillingCandidate(failed, groups), null);
});

test("discovers a legacy image charge and anchors it to the visible final answer", () => {
  const discovered = billing.discoverRelayImageBillingEntries(imageEntries(), groups);
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].entryId, "image:tool-result-1");
  assert.equal(discovered[0].data.anchorEntryId, "assistant-final-1");
  assert.equal(discovered[0].data.modelId, remoteModel);
});

test("does not duplicate a persisted marker for the same tool call", () => {
  const entries = imageEntries();
  const marker = {
    type: "custom",
    id: "marker-1",
    parentId: entries.at(-1).id,
    timestamp: "2026-09-16T07:50:51.000Z",
    customType: billing.RELAY_IMAGE_BILLING_TYPE,
    data: {
      version: 1,
      toolCallId: "image-call-1",
      anchorEntryId: "assistant-final-1",
      providerId,
      modelId: remoteModel,
      modelAlias,
      imageCount: 1,
      completedAt: Date.parse("2026-09-16T07:50:46.387Z"),
    },
  };
  const managerEntries = [...entries, marker];
  const appended = [];
  const count = billing.appendRelayImageBillingEntries({
    getEntries: () => managerEntries,
    appendCustomEntry: (customType, data) => appended.push({ customType, data }),
  }, groups);
  assert.equal(count, 0);
  assert.deepEqual(appended, []);
});
