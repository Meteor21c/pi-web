import type { AgentMessage, SessionEntry } from "./types";

export const SESSION_FORK_ORIGIN_TYPE = "meteoragent-fork-origin-v1";

export interface SessionForkOrigin {
  sessionId: string;
  familyId: string;
  titleBase: string;
  number: number;
}

export function readSessionForkOrigin(entry: SessionEntry): SessionForkOrigin | undefined {
  if (entry.type !== "custom" || entry.customType !== SESSION_FORK_ORIGIN_TYPE) return;
  const data = entry.data as Partial<SessionForkOrigin> | undefined;
  if (typeof data?.sessionId !== "string" || typeof data.familyId !== "string"
    || typeof data.titleBase !== "string" || typeof data.number !== "number"
    || !Number.isSafeInteger(data.number) || data.number < 1) return;
  return data as SessionForkOrigin;
}

export function isSessionForkDivider(message: AgentMessage): boolean {
  return message.role === "custom" && message.customType === SESSION_FORK_ORIGIN_TYPE;
}
