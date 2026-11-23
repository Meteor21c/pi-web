import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("keeps activity details closed until the user opens them", () => {
  assert.match(source, /const \[open, setOpen\] = useState\(false\)/);
  assert.match(source, /onToggle=\{\(\) => setOpen\(\(value\) => !value\)\}/);
  assert.doesNotMatch(source, /revealProcess|defaultExpanded/);
});

test("a hidden Goal outcome belongs to the previous assistant reply within the same user turn", () => {
  assert.match(source, /if \(msg\.role === "user"\) \{\s*lastAssistantIdx = -1;[\s\S]*?else if \(lastAssistantIdx !== -1 && isGoalOutcomeMessage\(msg\)\)/);
  assert.match(source, /const goalOutcome = goalOutcomeByAssistant\.get\(finalAssistantIdx\)/);
  assert.match(source, /if \(message\.role === "toolResult" \|\| isGoalOutcomeMessage\(message\)/);
});

test("keeps live run timing above the composer and shows recorded duration after settlement", () => {
  const composer = source.slice(source.indexOf('<div className="relative shrink-0">'));
  assert.match(composer, /<AgentActivityCard[\s\S]*?startedAt=\{activeRunStartedAt\}[\s\S]*?lastActivityAt=\{runLastActivityAt\}[\s\S]*?\{chatInputElement\}/);
  assert.match(source, /message\.customType === TURN_TIMING_TYPE\) \{\s*turnDurationMs = readTurnDurationMs\(message\.details\)/);
  assert.match(source, /if \(!isLiveTurn && turnDurationMs !== undefined\) \{[\s\S]*?t\("chat\.turnElapsed"/);
});

test("uses one stable activity disclosure for a full user turn, including compaction", () => {
  assert.match(source, /const isLiveTurn = \(agentRunning \|\| streamState\.isStreaming\) && userIdx === lastUserIdx/);
  assert.match(source, /while \(endIdx < timelineMessages\.length && timelineMessages\[endIdx\]\.role !== "user"\)/);
  assert.match(source, /textMode: messageIdx === finalAssistantIdx && \(isLiveTurn \|\| canShowFinal\) \? "final" : "activity"/);
  assert.match(source, /key=\{"turn-activity-" \+ turnKey\}/);
  assert.match(source, /<TurnProcessSection[\s\S]*?open=\{live \|\| open\}/);
  assert.match(source, /inert=\{!open\} aria-hidden=\{!open\}/);
});

test("uses a completion notification to update the existing child row when the launch is visible", () => {
  assert.match(source, /latestLaunchBySession\.get\(message\.details\.sessionId\)/);
  assert.match(source, /map\.set\(toolCallId, \{ \.\.\.launch, details: message\.details \}\)/);
  assert.match(source, /pairedSubagentNotifications\.has\(message\)\) continue/);
});
