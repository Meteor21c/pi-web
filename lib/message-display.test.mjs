import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./message-display.ts");
}

function assistant(content) {
  return {
    role: "assistant",
    provider: "test",
    model: "test-model",
    content,
  };
}

test("bounds thinking previews to the first nonblank line without splitting Unicode characters", async () => {
  const { getThinkingPreview } = await loadSubject();
  assert.equal(getThinkingPreview(" \r\n **First line** \r\nSecond line"), "**First line**");
  assert.equal(getThinkingPreview("First\rSecond"), "First");
  assert.equal(getThinkingPreview(" \n\t"), "");
  assert.equal(getThinkingPreview("\u{1F4A1}".repeat(300)), "\u{1F4A1}".repeat(240));
});

test("splits trailing final answer blocks from process blocks", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "work through it" },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
    { type: "text", text: "Final answer" },
    { type: "image", source: { type: "url", url: "https://example.com/final.png" } },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });

  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text", "image"]);
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["thinking", "toolCall"]);
});

test("keeps pre-tool text in process blocks", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "text", text: "I will inspect the repo first." },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
    { type: "text", text: "Final answer" },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });

  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text"]);
  assert.equal(result.answerBlocks[0].text, "Final answer");
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["text", "toolCall"]);
});

test("does not expose text before a trailing tool call as final answer", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "work through it" },
    { type: "text", text: "I need to call a tool." },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });

  assert.deepEqual(result.answerBlocks, []);
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["thinking", "text", "toolCall"]);
});

test("drops empty thinking blocks after completion", async () => {
  const { getDisplayableAssistantBlocks, splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "" },
    { type: "text", text: "Final answer" },
  ]);

  assert.deepEqual(
    getDisplayableAssistantBlocks(message, { isStreaming: false }).map((block) => block.type),
    ["text"],
  );

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });
  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text"]);
  assert.deepEqual(result.processBlocks, []);
});

test("keeps empty thinking while streaming", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "" },
    { type: "text", text: "Partial answer" },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: true });

  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text"]);
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["thinking"]);
});

test("keeps deferred historical thinking placeholders", async () => {
  const { getDisplayableAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "", deferred: true },
    { type: "text", text: "Final answer" },
  ]);

  assert.deepEqual(
    getDisplayableAssistantBlocks(message, { isStreaming: false }).map((block) => block.type),
    ["thinking", "text"],
  );
});

test("returns completed provider errors even when the message has no content", async () => {
  const { getAssistantErrorMessage } = await loadSubject();
  const message = {
    ...assistant([]),
    stopReason: "error",
    errorMessage: "OpenAI API error (403): request forbidden",
  };

  assert.equal(
    getAssistantErrorMessage(message),
    "OpenAI API error (403): request forbidden",
  );
  assert.equal(getAssistantErrorMessage(message, { isStreaming: true }), null);
});

test("falls back when a provider error has no message", async () => {
  const { getAssistantErrorMessage } = await loadSubject();

  assert.equal(
    getAssistantErrorMessage({ ...assistant([]), stopReason: "error" }),
    "Unknown provider error",
  );
  assert.equal(
    getAssistantErrorMessage({ ...assistant([]), stopReason: "stop" }),
    null,
  );
});

test("flags a normal stop with no final reply, including reasoning-only stops", async () => {
  const { stoppedWithoutFinalAnswer } = await loadSubject();
  assert.equal(stoppedWithoutFinalAnswer({ ...assistant([]), stopReason: "stop" }), true);
  assert.equal(stoppedWithoutFinalAnswer({
    ...assistant([{ type: "thinking", thinking: "preview", deferred: true }, { type: "text", text: " \n" }]),
    stopReason: "stop",
  }), true);
  for (const stopReason of ["error", "aborted", "length", "toolUse", undefined]) {
    assert.equal(stoppedWithoutFinalAnswer({ ...assistant([]), stopReason }), false);
  }
});

test("does not flag a normal stop with an answer or a tool call", async () => {
  const { stoppedWithoutFinalAnswer } = await loadSubject();
  for (const block of [
    { type: "text", text: "Final reply" },
    { type: "image", source: { type: "url", url: "https://example.com/image.png" } },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
  ]) {
    assert.equal(stoppedWithoutFinalAnswer({ ...assistant([block]), stopReason: "stop" }), false);
  }
});

test("recognizes truncated Responses stream errors", async () => {
  const { isTruncatedResponseError } = await loadSubject();

  assert.equal(isTruncatedResponseError("Unexpected end of JSON input"), true);
  assert.equal(isTruncatedResponseError("OpenAI Responses stream ended before a terminal response event"), true);
  assert.equal(isTruncatedResponseError("OpenAI Responses stream ended without a stop reason"), true);
  assert.equal(isTruncatedResponseError("OpenAI API error (403): forbidden"), false);
});

test("treats compaction summaries as turn anchors", async () => {
  const { isMessageGroupAnchor } = await loadSubject();

  assert.equal(isMessageGroupAnchor({ role: "user", content: "prompt" }), true);
  assert.equal(isMessageGroupAnchor({
    role: "custom",
    customType: "compaction",
    content: "summary",
    display: true,
  }), true);
  assert.equal(isMessageGroupAnchor(assistant([])), false);
});

test("keeps Goal progress folded while preserving delivered images and other visible tool results", async () => {
  const { getAssistantTimelineSegments } = await loadSubject();
  const message = {
    ...assistant([
      { type: "text", text: "I will check the OS settings now." },
      { type: "toolCall", toolCallId: "1", toolName: "computer_use_get_window_state", input: {} },
      { type: "image", source: { type: "url", url: "https://example.com/final.png" } },
      { type: "toolCall", toolCallId: "2", toolName: "image_generate", input: {} },
      { type: "text", text: "Checking again..." },
    ]),
    stopReason: "stop",
  };
  const visibleToolResult = (block) => block.toolName === "image_generate";
  assert.deepEqual(getAssistantTimelineSegments(message, { textMode: "activity", isVisibleToolResult: visibleToolResult }), [
    { kind: "activity", blockIndices: [0, 1] },
    { kind: "output", blockIndices: [2, 3] },
    { kind: "activity", blockIndices: [4] },
  ]);
  assert.deepEqual(getAssistantTimelineSegments(message, { isVisibleToolResult: visibleToolResult }), [
    { kind: "output", blockIndices: [0] },
    { kind: "activity", blockIndices: [1] },
    { kind: "output", blockIndices: [2, 3, 4] },
  ]);
});

test("keeps stopped Goal turns folded after their tracker changes or history reloads", async () => {
  const { readGoalOutcomeStatus, shouldShowSettledGoalFinal } = await loadSubject();
  for (const status of ["paused", "blocked"]) {
    const outcome = readGoalOutcomeStatus({ status });
    assert.equal(outcome, status);
    assert.equal(shouldShowSettledGoalFinal({ outcome, latest: true, goalUnavailable: true }), false);
    assert.equal(shouldShowSettledGoalFinal({ outcome, latest: false, goalStatus: "completed" }), false);
  }
  assert.equal(shouldShowSettledGoalFinal({ outcome: readGoalOutcomeStatus({ status: "completed" }), latest: false, goalStatus: "paused" }), true);
  const untracked = readGoalOutcomeStatus({ status: "untracked" });
  assert.equal(untracked, "untracked");
  assert.equal(shouldShowSettledGoalFinal({ outcome: untracked, latest: true, goalStatus: "blocked" }), true);
  assert.equal(shouldShowSettledGoalFinal({ outcome: untracked, latest: true, goalStatus: "active" }), true);
  assert.equal(readGoalOutcomeStatus({ status: "active" }), undefined);
  assert.equal(readGoalOutcomeStatus(null), undefined);
});

test("waits for current Goal status while retaining readable legacy final answers", async () => {
  const { shouldShowSettledGoalFinal } = await loadSubject();
  assert.equal(shouldShowSettledGoalFinal({ latest: true, goalUnavailable: true }), false);
  for (const goalStatus of ["active", "paused", "blocked", "cancelled"]) {
    assert.equal(shouldShowSettledGoalFinal({ latest: true, goalStatus }), false);
  }
  assert.equal(shouldShowSettledGoalFinal({ latest: true, goalStatus: "completed" }), true);
  assert.equal(shouldShowSettledGoalFinal({ latest: true }), true);
  assert.equal(shouldShowSettledGoalFinal({ latest: false, goalUnavailable: true }), true);
});

test("shows clean final Goal text but keeps tool syntax and unfinished prose in details", async () => {
  const { getAssistantTimelineSegments } = await loadSubject();
  const message = {
    ...assistant([
      { type: "text", text: "I am going to test both builds." },
      { type: "thinking", thinking: "Review the results first." },
      { type: "text", text: "Let me check.</ | DSML | parameter>" },
      { type: "text", text: "<｜DSML｜invoke name=\"read\">" },
      { type: "text", text: "已检查两份安装包，均通过校验。" },
    ]),
    stopReason: "stop",
  };
  assert.deepEqual(getAssistantTimelineSegments(message, { textMode: "final" }), [
    { kind: "activity", blockIndices: [0, 1, 2, 3] },
    { kind: "output", blockIndices: [4] },
  ]);
  for (const stopReason of ["length", "error", "aborted", "toolUse"]) {
    assert.deepEqual(getAssistantTimelineSegments({ ...message, stopReason }, { textMode: "final" }), [
      { kind: "activity", blockIndices: [0, 1, 2, 3, 4] },
    ]);
  }
  assert.deepEqual(getAssistantTimelineSegments(message, { textMode: "final", isStreaming: true }), [
    { kind: "activity", blockIndices: [0, 1, 2, 3, 4] },
  ]);
});

test("shows live stage explanations while keeping thinking, commands, and tool markup inside activity", async () => {
  const { getAssistantTimelineSegments } = await loadSubject();
  const message = {
    ...assistant([
      { type: "thinking", thinking: "Internal notes" },
      { type: "text", text: "两版安装包已编译，正在校验。" },
      { type: "toolCall", toolCallId: "run", toolName: "bash", input: {} },
      { type: "text", text: "<｜DSML｜invoke name=\"read\">" },
    ]),
    stopReason: "toolUse",
  };
  assert.deepEqual(getAssistantTimelineSegments(message, { textMode: "live" }), [
    { kind: "activity", blockIndices: [0] },
    { kind: "output", blockIndices: [1] },
    { kind: "activity", blockIndices: [2, 3] },
  ]);
  assert.deepEqual(getAssistantTimelineSegments(message, { textMode: "activity" }), [
    { kind: "activity", blockIndices: [0, 1, 2, 3] },
  ]);
});

test("keeps progress and child status in the same fold while the final answer streams separately", async () => {
  const { getAssistantTimelineSegments } = await loadSubject();
  const message = assistant([
    { type: "text", text: "Preparing the test fixtures." },
    { type: "toolCall", toolCallId: "run", toolName: "bash", input: {} },
    { type: "toolCall", toolCallId: "child", toolName: "Agent", input: {} },
    { type: "text", text: "Verified both builds." },
  ]);
  const options = {
    textMode: "final",
    showProgress: true,
    isProgressToolResult: (block) => block.toolName === "Agent",
  };
  const expected = [
    { kind: "progress", blockIndices: [0] },
    { kind: "activity", blockIndices: [1] },
    { kind: "progress", blockIndices: [2] },
    { kind: "output", blockIndices: [3] },
  ];
  assert.deepEqual(getAssistantTimelineSegments({ ...message, stopReason: "stop" }, options), expected);
  assert.deepEqual(getAssistantTimelineSegments({ ...message, stopReason: "stop" }, {
    ...options, isStreaming: true, allowStreamingFinal: true,
  }), expected);
});
