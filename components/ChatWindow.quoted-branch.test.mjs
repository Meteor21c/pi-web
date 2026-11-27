import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("offers compact quoting controls and sends branch questions through the main chat", async () => {
  const chatSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  const shellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

  assert.match(chatSource, /onPointerUp=\{captureQuotedSelection\}/);
  assert.match(chatSource, /closest<HTMLElement>\("\[data-message-role=/);
  assert.match(chatSource, /chatInputRef\?\.current\?\.insertText\(buildQuotedSelection/);
  assert.match(chatSource, /quoteDestination === "side-chat" \? onAskInSideChat : onAskInNewChat/);
  assert.match(chatSource, /await ask\(\s*prompt,\s*sourceSessionId,\s*quotedSelection\.sourceEntryId/);
  assert.match(shellSource, /type: "fork_branch"/);
  assert.match(shellSource, /initialPrompt=\{pendingQuotePrompt\?\.sessionId === selectedSession\?\.id/);
  assert.match(shellSource, /onAskInNewChat=\{handleAskInNewChat\}/);
  assert.match(chatSource, /onInitialPromptConsumed\?\.\(\);\s*void handleSend\(initialPrompt\)/);
  assert.match(chatSource, /role=\{quoteInputOpen \? "dialog" : "toolbar"\}/);
});

test("selected-text context actions work with the floating toolbar turned off", async () => {
  const chatSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  const contextHandler = chatSource.slice(chatSource.indexOf("const openQuoteContextMenu"), chatSource.indexOf("const copyQuotedSelection"));
  assert.match(chatSource, /onContextMenu=\{openQuoteContextMenu\}/);
  assert.doesNotMatch(contextHandler, /quoteSelectionEnabled/);
  assert.match(contextHandler, /event\.defaultPrevented/);
  assert.match(chatSource, /await copyText\(quotedSelection\.text\)/);
  assert.match(chatSource, /setQuoteDestination\(quotedSelection\.contextMenu \? "side-chat" : "new-chat"\)/);
  assert.match(chatSource, /if \(previewOnly \|\| sidePanel\) return;\s*registerAbortHandler/);
});
