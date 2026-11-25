import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { createJiti } from "jiti";

const { AgentInputQueue } = await createJiti(import.meta.url).import("./agent-input-queue.ts");

function fixture() {
  const agent = new Agent({ streamFn() { throw new Error("A queue mutation must not request a model"); } });
  const steering = [];
  const followUp = [];
  const queue = new AgentInputQueue({
    agent,
    getSteeringMessages: () => steering,
    getFollowUpMessages: () => followUp,
  });
  return { agent, queue, steering, followUp };
}

test("moves and recalls one exact pending message with its images even when messages share text", () => {
  const { agent, queue, followUp, steering } = fixture();
  const first = { type: "image", data: "AQID", mimeType: "image/png" };
  const second = { type: "image", data: "BAUG", mimeType: "image/png" };
  const path = "/attachments/images/原图.png";
  const firstMessage = { role: "user", content: [{ type: "text", text: "duplicate" }, first], timestamp: 1 };
  const secondMessage = { role: "user", content: [{ type: "text", text: "duplicate" }, second], timestamp: 2 };
  queue.rememberDraft([second], "Use this icon", [path]);
  followUp.push("duplicate", "duplicate");
  agent.followUp(firstMessage);
  agent.followUp(secondMessage);
  assert.equal(queue.isSteeringInput(secondMessage), false);

  const [firstItem, secondItem] = queue.snapshot().items;
  assert.notEqual(firstItem.id, secondItem.id);
  assert.deepEqual(secondItem, { id: secondItem.id, kind: "followUp", text: "Use this icon", imageCount: 1 });
  assert.throws(() => queue.update(secondItem.id, "steer", false), /no longer available/);

  // Pi can drain a message before its session removes the matching text entry.
  assert.equal(agent.followUpQueue.drain()[0], firstMessage);
  assert.throws(() => queue.update(firstItem.id, "recall", true), /no longer waiting/);
  queue.update(secondItem.id, "steer", true);
  assert.equal(agent.peekQueuedMessages()[0], secondMessage);
  assert.equal(queue.isSteeringInput(firstMessage), false);
  assert.equal(queue.isSteeringInput(secondMessage), true);
  assert.deepEqual(followUp, ["duplicate"]);
  assert.deepEqual(steering, ["duplicate"]);
  assert.equal(queue.snapshot().items[0].id, secondItem.id);

  assert.deepEqual(queue.update(secondItem.id, "recall", true), {
    value: "Use this icon",
    images: [{ data: second.data, mimeType: second.mimeType, filePath: path }],
  });
  assert.deepEqual(steering, []);
  assert.deepEqual(queue.snapshot().items, []);
  assert.throws(() => queue.update(secondItem.id, "recall", true), /no longer waiting/);
});

test("recalls a follow-up with the original Pi image blocks even without saved image metadata", () => {
  const { agent, queue, followUp } = fixture();
  const image = { type: "image", data: "AQID", mimeType: "image/png" };
  followUp.push("Only this message");
  agent.followUp({ role: "user", content: [{ type: "text", text: followUp[0] }, image], timestamp: 1 });
  const [item] = queue.snapshot().items;
  assert.deepEqual(queue.update(item.id, "recall", false), {
    value: "Only this message",
    images: [{ data: image.data, mimeType: image.mimeType, filePath: undefined }],
  });
  assert.equal(agent.hasQueuedMessages(), false);
});

test("marks SDK steering by identity even when its text matches a follow-up", () => {
  const { agent, queue } = fixture();
  const followUp = { role: "user", content: "Same message", timestamp: 1 };
  const steering = { ...followUp };
  agent.followUp(followUp);
  agent.steer(steering);

  assert.equal(queue.isSteeringInput(agent.steeringQueue.drain()[0]), true);
  assert.equal(queue.isSteeringInput(agent.followUpQueue.drain()[0]), false);
});
