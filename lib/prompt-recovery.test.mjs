import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { reconcileDeliveredUserMessage } = await createJiti(import.meta.url).import("./prompt-recovery.ts");

function textMessage(content, timestamp = 1) {
  return { role: "user", content, timestamp };
}

test("one user message survives the Pi system update sent before its acknowledgement", () => {
  const optimistic = textMessage("请完成上方的目标。");
  const system = { role: "system", content: "", sections: { rules: "Use Goal mode" }, timestamp: 2 };
  const delivered = { ...textMessage([{ type: "text", text: optimistic.content }], 3), turnWorkMode: "goal" };
  const messages = [optimistic, system];

  assert.deepEqual(reconcileDeliveredUserMessage(messages, optimistic, delivered), [system, delivered]);
  assert.deepEqual(messages, [optimistic, system]);
});

test("identical earlier and queued user messages are preserved", () => {
  const previous = textMessage("Continue", 1);
  const optimistic = textMessage("Continue", 2);
  const delivered = textMessage("Continue", 3);
  const queued = textMessage("Continue", 4);

  const messages = reconcileDeliveredUserMessage([previous, optimistic], optimistic, delivered);
  assert.deepEqual(reconcileDeliveredUserMessage(messages, null, queued), [previous, delivered, queued]);
  assert.deepEqual(reconcileDeliveredUserMessage([previous], optimistic, delivered), [previous, delivered]);
});

test("preserves the message content and attachments acknowledged by the SDK", () => {
  const optimistic = textMessage([
    { type: "text", text: "inspect" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
  ]);
  const delivered = textMessage([
    { type: "text", text: "inspect" },
    { type: "image", mimeType: "image/png", data: "BAUG" },
  ], 2);

  assert.deepEqual(reconcileDeliveredUserMessage([optimistic], optimistic, delivered), [delivered]);
});
