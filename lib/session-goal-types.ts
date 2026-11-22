export const MAX_SESSION_GOAL_LENGTH = 2_000;
export const GOAL_CONTINUATION_TYPE = "meteoragent:goal-continuation";

export type SessionGoalReason = "empty_reply" | "budget" | "user_stop" | "request_error" | "blocked" | "needs_review";

export interface SessionGoal {
  objective: string;
  status: "active" | "paused" | "blocked" | "completed" | "cancelled";
  revision: number;
  reason?: SessionGoalReason;
  detail?: string;
  evidence?: string;
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
