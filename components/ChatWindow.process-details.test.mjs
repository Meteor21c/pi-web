import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("keeps activity details closed until the user opens them", () => {
  assert.match(source, /const \[open, setOpen\] = useState\(false\)/);
  assert.match(source, /onClick=\{\(\) => setOpen\(\(value\) => !value\)\}/);
  assert.doesNotMatch(source, /revealProcess|defaultExpanded/);
});

test("a hidden Goal outcome belongs to the previous assistant reply within the same user turn", () => {
  assert.match(source, /if \(msg\.role === "user"\) lastAssistantIdx = -1;\s*else if \(msg\.role === "assistant"\) lastAssistantIdx = idx;\s*else if \(lastAssistantIdx !== -1 && isGoalOutcomeMessage\(msg\)\)/);
  assert.match(source, /const goalOutcome = goalOutcomeByAssistant\.get\(finalAssistantIdx\)/);
  assert.match(source, /if \(message\.role === "toolResult" \|\| isGoalOutcomeMessage\(message\)/);
});

test("keeps live run timing above the composer and shows recorded duration after settlement", () => {
  const composer = source.slice(source.indexOf('<div className="relative shrink-0">'));
  assert.match(composer, /<AgentActivityCard[\s\S]*?startedAt=\{activeRunStartedAt\}[\s\S]*?lastActivityAt=\{runLastActivityAt\}[\s\S]*?\{chatInputElement\}/);
  assert.match(source, /message\.customType === TURN_TIMING_TYPE\) \{\s*turnDurationMs = readTurnDurationMs\(message\.details\)/);
  assert.match(source, /if \(!isLiveTail && turnDurationMs !== undefined\) \{[\s\S]*?t\("chat\.turnElapsed"/);
});
