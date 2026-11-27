import { isValidSessionId } from "@/lib/session-file-references-core";

export const SIDE_QUESTION_TABS_KEY = "meteoragent-side-question-tabs-v1";

export function sideQuestionTabId(sessionId: string): string {
  return `side-chat:${sessionId}`;
}

export function restoreSideQuestionTabs(raw: string | null): {
  sessionIds: string[];
  activeId: string | null;
  open: boolean;
} {
  const empty = { sessionIds: [], activeId: null, open: false };
  if (!raw) return empty;
  try {
    const value = JSON.parse(raw) as { sessionIds?: unknown; activeId?: unknown; open?: unknown } | null;
    if (!value || !Array.isArray(value.sessionIds)) return empty;
    const sessionIds = [...new Set(value.sessionIds.filter(
      (id): id is string => typeof id === "string" && isValidSessionId(id),
    ))];
    const activeId = sessionIds.some((id) => sideQuestionTabId(id) === value.activeId) ? value.activeId as string : null;
    return { sessionIds, activeId, open: activeId !== null && value.open === true };
  } catch {
    return empty;
  }
}
