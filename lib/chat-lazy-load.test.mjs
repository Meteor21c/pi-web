import test from "node:test";
import assert from "node:assert/strict";

async function loadSubject() {
  return import("./chat-lazy-load.ts");
}

function history(entryIds, overrides = {}) {
  return {
    entryIds,
    messages: entryIds.map((id) => ({ role: "user", content: id })),
    oldestEntryId: entryIds[0] ?? null,
    hasMore: true,
    thinkingLevel: "auto",
    model: null,
    ...overrides,
  };
}

test("retains older pages and their cursor when a refresh extends the branch", async () => {
  const { mergeLoadedSessionContext } = await loadSubject();
  const loaded = history(["a", "b", "c"], { oldestEntryId: "hidden-root", hasMore: false });
  const latest = history(["b", "c", "d"], { thinkingLevel: "high" });
  const merged = mergeLoadedSessionContext(loaded, latest);
  assert.deepEqual(merged.entryIds, ["a", "b", "c", "d"]);
  assert.deepEqual(merged.messages, [loaded.messages[0], ...latest.messages]);
  assert.equal(merged.oldestEntryId, "hidden-root");
  assert.equal(merged.hasMore, false);
  assert.equal(merged.thinkingLevel, "high");
});

test("keeps the refreshed context when there is no proven continuation", async () => {
  const { mergeLoadedSessionContext } = await loadSubject();
  const loaded = history(["a", "b", "c"]);
  for (const latest of [history(["b", "other"]), history(["b"]), history(["elsewhere"]), history([])]) {
    assert.equal(mergeLoadedSessionContext(loaded, latest), latest);
  }
  const complete = history(["a", "b", "c"], { hasMore: false });
  assert.equal(mergeLoadedSessionContext(loaded, complete), complete);
});

test("treats only the real message tail as live-follow attached", async () => {
  const {
    CHAT_SCROLL_REATTACH_TOLERANCE,
    CHAT_SCROLL_TAIL_TOLERANCE,
    getLiveFollowAttached,
    isScrollAtTail,
  } = await loadSubject();

  assert.equal(CHAT_SCROLL_TAIL_TOLERANCE, 8);
  assert.equal(CHAT_SCROLL_REATTACH_TOLERANCE, 96);
  assert.deepEqual(
    [392, 391.99, 400].map((scrollTop) => isScrollAtTail(scrollTop, 600, 1000)),
    [true, false, true],
  );
  assert.equal(isScrollAtTail(0, 600, 400), true);

  // Layout growth alone must not detach a view that was already following.
  assert.equal(getLiveFollowAttached(true, 400, 400, 600, 1040), true);
  // Any upward movement outside the strict tail tolerance detaches, even inside
  // the wider downward-only reattach window.
  assert.equal(getLiveFollowAttached(true, 400, 380, 600, 1000), false);
  assert.equal(getLiveFollowAttached(false, 380, 370, 600, 1000), false);
  // A detached view stays detached until downward movement enters the reattach window.
  assert.equal(getLiveFollowAttached(false, 280, 303, 600, 1000), false);
  assert.equal(getLiveFollowAttached(false, 303, 304, 600, 1000), true);
  // Reaching the old tail still reattaches after one to four new rendered lines.
  for (const lines of [1, 2, 3, 4]) {
    assert.equal(getLiveFollowAttached(false, 380, 400, 600, 1000 + lines * 24), true);
  }
  assert.equal(getLiveFollowAttached(false, 380, 400, 600, 1120), false);
  // Streaming growth without downward user movement must not reattach.
  assert.equal(getLiveFollowAttached(false, 400, 400, 600, 1096), false);
  assert.equal(getLiveFollowAttached(false, 391, 392, 600, 1000), true);
});

test("prompt anchor spacer uses the rendered content end", async () => {
  const { getPromptAnchorSpacerHeight } = await loadSubject();
  const initial = getPromptAnchorSpacerHeight(400, 700, 600);
  const afterRender = getPromptAnchorSpacerHeight(400, 700, 600);

  assert.equal(initial, 300);
  assert.equal(afterRender, initial);
});

test("prompt anchor spacer includes the viewport deficit for short conversations", async () => {
  const { getPromptAnchorSpacerHeight } = await loadSubject();
  const targetTop = 168;
  const clientHeight = 579;

  let contentHeight = 411;
  let spacerHeight = getPromptAnchorSpacerHeight(targetTop, contentHeight, clientHeight);
  assert.equal(spacerHeight, 336);
  assert.equal(contentHeight + spacerHeight - clientHeight, targetTop);

  contentHeight += 24;
  spacerHeight = getPromptAnchorSpacerHeight(targetTop, contentHeight, clientHeight);
  assert.equal(spacerHeight, 312);
  assert.equal(contentHeight + spacerHeight - clientHeight, targetTop);
});

test("prompt anchor spacer clamps at zero once content can reach the target", async () => {
  const { getPromptAnchorSpacerHeight } = await loadSubject();
  assert.equal(getPromptAnchorSpacerHeight(100, 750, 600), 0);
  assert.equal(getPromptAnchorSpacerHeight(-20, 200, 600), 0);
});

test("prompt anchor spacer rounds fractional layout measurements up", async () => {
  const { getPromptAnchorSpacerHeight } = await loadSubject();
  assert.equal(getPromptAnchorSpacerHeight(400.25, 700, 600), 301);
});

test("streaming content consumes the prompt anchor before advancing the tail", async () => {
  const { getPromptAnchorSpacerHeight } = await loadSubject();
  const targetTop = 400;
  const clientHeight = 600;

  let contentHeight = 700;
  let spacerHeight = getPromptAnchorSpacerHeight(targetTop, contentHeight, clientHeight);
  assert.equal(spacerHeight, 300);
  assert.equal(contentHeight + spacerHeight - clientHeight, targetTop);

  contentHeight += 120;
  spacerHeight = getPromptAnchorSpacerHeight(targetTop, contentHeight, clientHeight);
  assert.equal(spacerHeight, 180);
  assert.equal(contentHeight + spacerHeight - clientHeight, targetTop);

  contentHeight += 180;
  spacerHeight = getPromptAnchorSpacerHeight(targetTop, contentHeight, clientHeight);
  assert.equal(spacerHeight, 0);
  assert.equal(contentHeight - clientHeight, targetTop);

  contentHeight += 40;
  spacerHeight = getPromptAnchorSpacerHeight(targetTop, contentHeight, clientHeight);
  assert.equal(spacerHeight, 0);
  assert.equal(contentHeight - clientHeight, targetTop + 40);
});
