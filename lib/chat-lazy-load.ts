import type { SessionContext } from "./types";

export const CHAT_SCROLL_TAIL_TOLERANCE = 8;
export const CHAT_SCROLL_REATTACH_TOLERANCE = 96;

export function mergeLoadedSessionContext(loaded: SessionContext, latest: SessionContext): SessionContext {
  if (!latest.hasMore || latest.entryIds.length === 0) return latest;
  const overlap = loaded.entryIds.indexOf(latest.entryIds[0]);
  // Retain the prefix only when the new page continues the entire loaded suffix.
  // A common ancestor alone can also occur after switching branches.
  if (overlap < 0 || !loaded.entryIds.slice(overlap).every((id, index) => id === latest.entryIds[index])) return latest;
  return {
    ...latest,
    messages: [...loaded.messages.slice(0, overlap), ...latest.messages],
    entryIds: [...loaded.entryIds.slice(0, overlap), ...latest.entryIds],
    oldestEntryId: loaded.oldestEntryId,
    hasMore: loaded.hasMore,
  };
}

export function isScrollAtTail(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  tolerance = CHAT_SCROLL_TAIL_TOLERANCE,
): boolean {
  return scrollTop + clientHeight >= scrollHeight - tolerance;
}

export function getLiveFollowAttached(
  wasAttached: boolean,
  previousScrollTop: number,
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  reattachTolerance = CHAT_SCROLL_REATTACH_TOLERANCE,
): boolean {
  if (isScrollAtTail(scrollTop, clientHeight, scrollHeight)) return true;
  if (scrollTop < previousScrollTop) return false;
  if (
    !wasAttached
    && scrollTop > previousScrollTop
    && isScrollAtTail(scrollTop, clientHeight, scrollHeight, reattachTolerance)
  ) return true;
  return wasAttached;
}

export function getPromptAnchorSpacerHeight(
  targetTop: number,
  contentEnd: number,
  clientHeight: number,
): number {
  const clampedTargetTop = Math.max(0, targetTop);
  if (clampedTargetTop === 0) return 0;

  return Math.max(0, Math.ceil(
    clampedTargetTop + clientHeight - Math.max(0, contentEnd),
  ));
}
