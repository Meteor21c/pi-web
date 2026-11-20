import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { isWorkMode, readSessionPromptSelection, type WorkMode } from "./prompt-presets";
import type { SessionEntry } from "./types";

const SESSION_WORK_MODE_TYPE = "meteoragent:work-mode";

export interface SessionWorkMode {
  workMode: WorkMode;
  pendingWorkMode: WorkMode | null;
  workModeRevision: number;
}

/** Session-wide, independent of the immutable prompt snapshot and currently selected branch. */
export function readSessionWorkMode(entries: readonly SessionEntry[], defaultMode?: WorkMode): SessionWorkMode {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== SESSION_WORK_MODE_TYPE) continue;
    const data = entry.data as Partial<SessionWorkMode> | null;
    if (data && isWorkMode(data.workMode)
      && (data.pendingWorkMode === null || isWorkMode(data.pendingWorkMode))
      && typeof data.workModeRevision === "number" && Number.isSafeInteger(data.workModeRevision)
      && data.workModeRevision > 0) {
      return {
        workMode: data.workMode,
        pendingWorkMode: data.pendingWorkMode,
        workModeRevision: data.workModeRevision,
      };
    }
  }
  return {
    workMode: defaultMode ?? readSessionPromptSelection(entries)?.mode ?? "auto",
    pendingWorkMode: null,
    workModeRevision: 0,
  };
}

export function appendSessionWorkMode(manager: SessionManager, state: SessionWorkMode): void {
  manager.appendCustomEntry(SESSION_WORK_MODE_TYPE, state);
}

/** Forks inherit the active policy, but a pending change belongs to the original conversation. */
export function inheritSessionWorkMode(manager: SessionManager, workMode: WorkMode): void {
  const copied = readSessionWorkMode(manager.getEntries() as unknown as SessionEntry[]);
  if (copied.workMode === workMode && copied.pendingWorkMode === null) return;
  appendSessionWorkMode(manager, { workMode, pendingWorkMode: null, workModeRevision: copied.workModeRevision + 1 });
}
