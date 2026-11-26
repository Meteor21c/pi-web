import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { formatSessionForkTitle, prepareSessionForkOrigin } = await jiti.import("./session-fork-store.ts");
const { isSessionForkDivider, SESSION_FORK_ORIGIN_TYPE } = await jiti.import("./session-fork-origin.ts");
const { buildSessionContext } = await jiti.import("./session-reader.ts");

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "magent-fork-"));
  const countsPath = join(directory, "fork-counters.json");
  return { directory, countsPath };
}

function appendMarker(manager, origin) {
  manager.appendSessionInfo(formatSessionForkTitle(origin.titleBase, origin.number));
  return manager.appendCustomEntry(SESSION_FORK_ORIGIN_TYPE, { ...origin, sessionId: manager.getSessionId() });
}

test("fork names are unique across sibling and nested branches without changing the original", async () => {
  const { directory, countsPath } = fixture();
  const source = SessionManager.create(directory, directory);
  source.appendSessionInfo("讨论方案");
  const origins = await Promise.all(Array.from({ length: 2 }, () => prepareSessionForkOrigin(source, countsPath)));
  assert.deepEqual(origins.map(({ titleBase, number }) => formatSessionForkTitle(titleBase, number)).sort(), ["讨论方案（1）", "讨论方案（2）"]);
  const child = SessionManager.create(directory, directory);
  appendMarker(child, origins[0]);
  const nested = await prepareSessionForkOrigin(child, countsPath);
  assert.equal(formatSessionForkTitle(nested.titleBase, nested.number), "讨论方案（3）");
  child.appendSessionInfo("我重新命名的分支");
  const renamed = await prepareSessionForkOrigin(child, countsPath);
  assert.equal(formatSessionForkTitle(renamed.titleBase, renamed.number), "我重新命名的分支（4）");
  assert.equal(source.getSessionName(), "讨论方案");
});

test("only the current fork's divider appears between the copied reply and new history, including pagination", () => {
  const { directory } = fixture();
  const session = SessionManager.create(directory, directory);
  const base = { familyId: "root", titleBase: "讨论方案", number: 2 };
  session.appendMessage({ role: "user", content: "继承的提问", timestamp: 1 });
  const inherited = session.appendCustomEntry(SESSION_FORK_ORIGIN_TYPE, { ...base, number: 1, sessionId: "ancestor" });
  const reply = session.appendMessage({ role: "assistant", content: [{ type: "text", text: "继承的回复" }], timestamp: 2 });
  const divider = appendMarker(session, base);
  const newQuestion = session.appendMessage({ role: "user", content: "分支里的新提问", timestamp: 3 });
  const reopened = SessionManager.open(session.getSessionFile());
  const options = { sessionId: reopened.getSessionId() };
  assert.equal(reopened.getSessionName(), "讨论方案（2）");
  const context = buildSessionContext(reopened.getEntries(), newQuestion, options);
  assert.deepEqual(context.entryIds.slice(-3), [reply, divider, newQuestion]);
  assert.deepEqual(context.entryIds.filter((_, index) => isSessionForkDivider(context.messages[index])), [divider]);
  assert.ok(!context.entryIds.includes(inherited));
  assert.equal(reopened.buildSessionContext().messages.length, 3);
  const newestPage = buildSessionContext(reopened.getEntries(), newQuestion, { ...options, tail: 1 });
  const olderPage = buildSessionContext(reopened.getEntries(), newestPage.oldestEntryId, { ...options, tail: 2, excludeLeaf: true });
  assert.deepEqual(newestPage.entryIds, [newQuestion]);
  assert.deepEqual(olderPage.entryIds, [divider]);
});
