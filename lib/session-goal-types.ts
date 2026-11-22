export const MAX_SESSION_GOAL_LENGTH = 2_000;
export const GOAL_CONTINUATION_TYPE = "meteoragent:goal-continuation";
export const GOAL_OUTCOME_TYPE = "meteoragent:goal-outcome";

export const SESSION_GOAL_REASONS = [
  "empty_reply", "budget", "user_stop", "request_error", "blocked", "needs_review",
  "no_progress", "output_limit", "screen_recording", "screen_capture_failed", "accessibility", "approval_required",
] as const;

export type SessionGoalReason = typeof SESSION_GOAL_REASONS[number];

export interface SessionGoal {
  objective: string;
  status: "active" | "paused" | "blocked" | "completed" | "cancelled";
  revision: number;
  reason?: SessionGoalReason;
  detail?: string;
  evidence?: string;
  userAction?: string;
}

export type SessionGoalAction =
  | { type: "set"; objective: string }
  | { type: "complete" }
  | { type: "cancel" }
  | { type: "pause" }
  | { type: "resume" };

export interface SessionGoalUpdate {
  action: SessionGoalAction;
  expectedRevision: number | null;
}
