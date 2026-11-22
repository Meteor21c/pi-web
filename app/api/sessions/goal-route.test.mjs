import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { GET, PUT } = await jiti.import("./[id]/goal/route.ts");
const { deleteSessionWithGoal, readSessionGoal, updateSessionGoalFromRun } = await jiti.import("@/lib/session-goal");
const { cacheSessionPath, invalidateSessionPathCache } = await jiti.import("@/lib/session-reader");

function sessionFixture(t, { transient = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "meteoragent-goal-"));
  const id = "session-goal-" + directory.split("-").at(-1);
  const path = join(directory, "session.jsonl");
  const forkPath = join(directory, "fork.jsonl");
  const url = `http://localhost/api/sessions/${id}/goal`;
  const context = { params: Promise.resolve({ id }) };
  const writeSession = () => writeFileSync(path, JSON.stringify({ type: "session", id }) + "\n");
  cacheSessionPath(id, path);
  if (!transient) writeSession();
  t.after(async () => {
    invalidateSessionPathCache(id);
    await deleteSessionWithGoal(path);
    if (existsSync(forkPath)) unlinkSync(forkPath);
    rmdirSync(directory);
  });
  return {
    id, path, forkPath, writeSession,
    get: () => GET(new Request(url), context),
    put: (action, expectedRevision, headers = {}) => PUT(new Request(url, {
      method: "PUT",
      headers: { host: "localhost", "content-type": "application/json", ...headers },
      body: JSON.stringify({ action, expectedRevision }),
    }), context),
  };
}

test("goal updates accept local JSON and reject cross-origin requests and other media types", async (t) => {
  const session = sessionFixture(t);
  const action = { type: "set", objective: "Prepare the report" };
  assert.equal((await session.put(action, null, { origin: "https://untrusted.invalid" })).status, 403);
  assert.equal((await session.put(action, null, { "content-type": "text/plain" })).status, 415);
  assert.deepEqual(await (await session.get()).json(), { goal: null });
  assert.equal((await session.put(action, null, { origin: "http://localhost" })).status, 200);
});

test("one session goal survives reads, edits, and terminal actions without joining the chat log", async (t) => {
  const session = sessionFixture(t);
  const initial = await session.get();
  assert.equal(initial.headers.get("cache-control"), "no-store");
  assert.deepEqual(await initial.json(), { goal: null });
  const originalJsonl = readFileSync(session.path, "utf8");

  const set = await session.put({ type: "set", objective: "  Prepare the report  " }, null);
  assert.equal(set.status, 200);
  assert.deepEqual(await set.json(), { goal: { objective: "Prepare the report", status: "active", revision: 1 } });
  const edited = await session.put({ type: "set", objective: "Review the report" }, 1);
  assert.deepEqual(await edited.json(), { goal: { objective: "Review the report", status: "active", revision: 2 } });
  const completed = await session.put({ type: "complete" }, 2);
  assert.equal(completed.status, 200);
  assert.deepEqual(await completed.json(), { goal: { objective: "Review the report", status: "completed", revision: 3 } });
  assert.equal((await session.put({ type: "cancel" }, 3)).status, 409);
  const replacement = await session.put({ type: "set", objective: "Share the report" }, 3);
  assert.equal(replacement.status, 200);
  assert.equal((await session.put({ type: "cancel" }, 4)).status, 200);
  assert.deepEqual(await (await session.get()).json(), { goal: { objective: "Share the report", status: "cancelled", revision: 5 } });
  assert.equal(readFileSync(session.path, "utf8"), originalJsonl);

  writeFileSync(session.forkPath, originalJsonl);
  assert.equal(readSessionGoal(session.forkPath), null);
});

test("two simultaneous edits with the same revision let exactly one update the goal", async (t) => {
  const session = sessionFixture(t);
  assert.equal((await session.put({ type: "set", objective: " " }, null)).status, 400);
  assert.equal((await session.put({ type: "set", objective: "a".repeat(2_001) }, null)).status, 400);
  const [first, second] = await Promise.all([
    session.put({ type: "set", objective: "Draft the plan" }, null),
    session.put({ type: "set", objective: "Review the plan" }, null),
  ]);
  const winner = first.status === 200 ? first : second;
  const rejected = first.status === 200 ? second : first;
  assert.equal(winner.status, 200);
  assert.equal(rejected.status, 409);
  const { goal } = await winner.json();
  assert.deepEqual(await rejected.json(), { error: "Session goal has changed", code: "goal_conflict", goal });
  assert.deepEqual(await (await session.get()).json(), { goal });

  await Promise.all([
    deleteSessionWithGoal(session.path),
    session.put({ type: "set", objective: "After deletion" }, 1),
  ]);
  assert.equal(existsSync(session.path), false);
  assert.equal(readSessionGoal(session.path), null);
  assert.equal((await session.get()).status, 404);
});

test("a suspended goal can resume with its evidence, and stale runs cannot finish it", async (t) => {
  const session = sessionFixture(t);
  assert.equal((await session.put({ type: "set", objective: "Validate the report" }, null)).status, 200);
  const paused = await updateSessionGoalFromRun(session.path, 1, {
    status: "paused", reason: "empty_reply", evidence: "Report exported to report.pdf",
  });
  assert.deepEqual(paused, {
    objective: "Validate the report", status: "paused", revision: 2, reason: "empty_reply", evidence: "Report exported to report.pdf",
  });
  assert.deepEqual(await (await session.get()).json(), { goal: paused });
  const resumed = await session.put({ type: "resume" }, 2);
  assert.deepEqual(await resumed.json(), {
    goal: { objective: "Validate the report", status: "active", revision: 3, evidence: "Report exported to report.pdf" },
  });
  assert.equal(await updateSessionGoalFromRun(session.path, 1, { status: "completed", evidence: "Old report" }), null);
  assert.equal(await updateSessionGoalFromRun(session.path, 3, { status: "completed", evidence: " " }), null);
  const completed = await updateSessionGoalFromRun(session.path, 3, { status: "completed", evidence: "Opened report.pdf and verified all sections." });
  assert.equal(completed.status, "completed");
  assert.equal(completed.evidence, "Opened report.pdf and verified all sections.");
});

test("a paused or blocked goal still permits user completion or cancellation", async (t) => {
  const session = sessionFixture(t);
  assert.equal((await session.put({ type: "set", objective: "Export the report" }, null)).status, 200);
  assert.deepEqual(await (await session.put({ type: "pause" }, 1)).json(), {
    goal: { objective: "Export the report", status: "paused", revision: 2, reason: "user_stop" },
  });
  assert.equal((await session.put({ type: "complete" }, 2)).status, 200);
  assert.equal((await session.put({ type: "set", objective: "Publish the report" }, 3)).status, 200);
  const blocked = await updateSessionGoalFromRun(session.path, 4, {
    status: "blocked", reason: "blocked", detail: "Waiting for access to the project.",
  });
  assert.equal(blocked.detail, "Waiting for access to the project.");
  assert.equal((await session.put({ type: "cancel" }, 5)).status, 200);
});

test("saving a goal on a prepared session persists it before the first chat message", async (t) => {
  const session = sessionFixture(t, { transient: true });
  const registry = globalThis.__piSessions ??= new Map();
  registry.set(session.id, {
    sessionFile: session.path,
    isAlive: () => true,
    persistUnflushedSession: session.writeSession,
  });
  t.after(() => registry.delete(session.id));

  assert.deepEqual(await (await session.get()).json(), { goal: null });
  assert.equal(existsSync(session.path), false);
  const result = await session.put({ type: "set", objective: "Start the report" }, null);
  assert.equal(result.status, 200);
  assert.equal(existsSync(session.path), true);
  registry.delete(session.id);
  assert.deepEqual(await (await session.get()).json(), {
    goal: { objective: "Start the report", status: "active", revision: 1 },
  });
});
