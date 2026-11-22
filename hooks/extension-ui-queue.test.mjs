import assert from "node:assert/strict";
import test from "node:test";
import { extensionUiQueueReducer } from "./extension-ui-queue.ts";

const request = (id, method, fields = {}) => ({ type: "extension_ui_request", id, method, ...fields });
const push = (queue, next) => extensionUiQueueReducer(queue, { type: "request", request: next });
const close = (queue, id) => extensionUiQueueReducer(queue, { type: "closed", id });
const snapshot = (queue, ids) => extensionUiQueueReducer(queue, { type: "snapshot", ids });

test("overlapping approvals and custom screens wait behind the active request", () => {
  const approval = request("a", "confirm", { title: "Allow this action?" });
  const custom = request("b", "custom", { lines: ["Choose an option"] });
  const input = request("c", "input", { title: "Enter a name" });
  let queue = push(push(push(new Map(), approval), custom), input);
  assert.deepEqual([...queue.values()], [approval, custom, input]);

  const redraw = { ...custom, lines: ["A new option"] };
  queue = push(queue, redraw);
  assert.deepEqual([...queue.values()], [approval, redraw, input]);
  assert.deepEqual([...close(queue, "a").values()], [redraw, input]);
});

test("closing a queued request or stopping all requests leaves no stale dialogs", () => {
  const first = request("first", "select", { title: "First question", options: ["A"] });
  const second = request("second", "custom", { lines: ["Second question"] });
  const queue = push(push(new Map(), first), second);

  assert.strictEqual(close(queue, "already closed"), queue);
  const remaining = close(queue, "second");
  assert.deepEqual([...remaining.values()], [first]);
  assert.equal(close(remaining, "first").size, 0);
});

test("reconnect discards missed closures and keeps active, replayed dialogs in place", () => {
  const expired = request("old", "confirm", { title: "Expired prompt" });
  const input = request("input", "input", { title: "Continue typing" });
  const missed = request("new", "editor", { title: "Another prompt" });
  let queue = push(push(new Map(), expired), input);
  queue = snapshot(queue, [input.id, missed.id]);
  assert.deepEqual([...queue.values()], [input]);
  assert.strictEqual(push(queue, { ...input }), queue);
  queue = push(queue, missed);
  assert.deepEqual([...queue.values()], [input, missed]);
  assert.equal(snapshot(queue, []).size, 0);
});
