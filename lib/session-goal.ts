import { existsSync, readFileSync, unlinkSync } from "node:fs";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file";
import {
  MAX_SESSION_GOAL_LENGTH, SESSION_GOAL_REASONS, type SessionGoal, type SessionGoalReason, type SessionGoalUpdate,
} from "./session-goal-types";

export type { SessionGoal, SessionGoalAction, SessionGoalUpdate } from "./session-goal-types";

export class SessionGoalError extends Error {
  constructor(message: string, readonly status: 400 | 404) {
    super(message);
  }
}

const UNFINISHED_STATUSES = new Set<SessionGoal["status"]>(["active", "paused", "blocked"]);
const GOAL_STATUSES = new Set<SessionGoal["status"]>([...UNFINISHED_STATUSES, "completed", "cancelled"]);
const GOAL_REASONS = new Set<SessionGoalReason>(SESSION_GOAL_REASONS);
const MAX_GOAL_REPORT_LENGTH = 2_000;

type GoalReportFields = Pick<SessionGoal, "reason" | "detail" | "evidence" | "userAction">;
type SessionGoalOutcome = GoalReportFields & {
  status: "paused" | "blocked" | "completed";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseObjective(value: unknown): string | undefined {
  const objective = typeof value === "string" ? value.trim() : "";
  return objective.length > 0 && objective.length <= MAX_SESSION_GOAL_LENGTH ? objective : undefined;
}

export function parseSessionGoalUpdate(value: unknown): SessionGoalUpdate {
  if (!isRecord(value) || !isRecord(value.action)
    || (value.expectedRevision !== null && !isRevision(value.expectedRevision))) {
    throw new SessionGoalError("Invalid session goal update", 400);
  }
  const { action, expectedRevision } = value;
  if (action.type === "set") {
    const objective = parseObjective(action.objective);
    if (!objective) throw new SessionGoalError(`Enter a goal of 1–${MAX_SESSION_GOAL_LENGTH} characters`, 400);
    return { action: { type: "set", objective }, expectedRevision };
  }
  if (action.type === "complete" || action.type === "cancel" || action.type === "pause" || action.type === "resume") {
    return { action: { type: action.type }, expectedRevision };
  }
  throw new SessionGoalError("Invalid session goal action", 400);
}

function goalPath(sessionFile: string): string {
  return `${sessionFile}.goal.json`;
}

/** Goals live beside the session so Pi can append to, branch, or copy its JSONL independently. */
export function readSessionGoal(sessionFile: string): SessionGoal | null {
  if (!sessionFile) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(goalPath(sessionFile), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (isRecord(value) && value.version === 1 && isRevision(value.revision)
    && GOAL_STATUSES.has(value.status as SessionGoal["status"])) {
    const objective = parseObjective(value.objective);
    if (objective) {
      return {
        objective,
        status: value.status as SessionGoal["status"],
        revision: value.revision,
        ...goalReportFields(value),
      };
    }
  }
  throw new Error("Invalid session goal metadata");
}

function goalReportFields(value: Record<string, unknown>): GoalReportFields {
  const report: GoalReportFields = {};
  if (GOAL_REASONS.has(value.reason as SessionGoalReason)) report.reason = value.reason as SessionGoalReason;
  if (typeof value.detail === "string" && value.detail.trim()) report.detail = value.detail.trim().slice(0, MAX_GOAL_REPORT_LENGTH);
  if (typeof value.evidence === "string" && value.evidence.trim()) report.evidence = value.evidence.trim().slice(0, MAX_GOAL_REPORT_LENGTH);
  if (typeof value.userAction === "string" && value.userAction.trim()) report.userAction = value.userAction.trim().slice(0, MAX_GOAL_REPORT_LENGTH);
  return report;
}

function writeGoal(sessionFile: string, goal: SessionGoal): SessionGoal {
  writePrivateFileAtomicSync(goalPath(sessionFile), JSON.stringify({ version: 1, ...goal }));
  return goal;
}

async function withSessionGoalLock<T>(sessionFile: string, run: () => T): Promise<T> {
  const release = await lockfile.lock(goalPath(sessionFile), {
    realpath: false,
    retries: { retries: 8, minTimeout: 20, maxTimeout: 200 },
  });
  try {
    return run();
  } finally {
    await release();
  }
}

export async function updateSessionGoal(
  sessionFile: string,
  { action, expectedRevision }: SessionGoalUpdate,
  persistSession?: () => void,
): Promise<{ goal: SessionGoal | null; conflict?: true }> {
  return withSessionGoalLock(sessionFile, () => {
    const current = readSessionGoal(sessionFile);
    const unfinished = current !== null && UNFINISHED_STATUSES.has(current.status);
    if ((current?.revision ?? null) !== expectedRevision || (action.type !== "set" && !unfinished)) {
      return { goal: current, conflict: true };
    }

    // A freshly prepared runtime has a path but Pi may still hold the JSONL in memory.
    if (!existsSync(sessionFile)) persistSession?.();
    if (!existsSync(sessionFile)) throw new SessionGoalError("Session not found", 404);

    if (action.type === "set") {
      if (unfinished && current.objective === action.objective) return { goal: current };
      const status = current?.status === "paused" || current?.status === "blocked" ? "paused" : "active";
      return { goal: writeGoal(sessionFile, { objective: action.objective, status, revision: (current?.revision ?? 0) + 1 }) };
    }
    if (!current) return { goal: current, conflict: true };
    const statuses = { complete: "completed", cancel: "cancelled", pause: "paused", resume: "active" } as const;
    const status = statuses[action.type];
    if (current.status === status) return { goal: current };
    return { goal: writeGoal(sessionFile, {
      objective: current.objective,
      status,
      revision: current.revision + 1,
      ...(action.type === "pause" ? { reason: "user_stop" as const } : {}),
      ...(current.evidence ? { evidence: current.evidence } : {}),
    }) };
  });
}

/** The run can only finish the goal revision that the user actually started. */
export async function updateSessionGoalFromRun(
  sessionFile: string,
  expectedRevision: number,
  outcome: SessionGoalOutcome,
): Promise<SessionGoal | null> {
  return withSessionGoalLock(sessionFile, () => {
    if (!existsSync(sessionFile)) return null;
    const current = readSessionGoal(sessionFile);
    if (current?.revision !== expectedRevision || current.status !== "active") return null;
    const report = goalReportFields(outcome);
    if (outcome.status === "completed" && !report.evidence) return null;
    return writeGoal(sessionFile, {
      objective: current.objective,
      status: outcome.status,
      revision: current.revision + 1,
      ...(current.evidence ? { evidence: current.evidence } : {}),
      ...report,
    });
  });
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Share the mutation lock so a late goal save cannot recreate metadata after deletion. */
export async function deleteSessionWithGoal(sessionFile: string): Promise<void> {
  try {
    await withSessionGoalLock(sessionFile, () => {
      unlinkIfPresent(sessionFile);
      unlinkIfPresent(goalPath(sessionFile));
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
