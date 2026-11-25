import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { isWorkMode, PROMPT_SELECTION_TYPE, readSessionPromptSelection, type WorkMode } from "./prompt-presets";
import type { SessionEntry, UserMessage } from "./types";

const SESSION_WORK_MODE_TYPE = "meteoragent:work-mode";
const TURN_WORK_MODE_TYPE = "meteoragent:turn-work-mode";

export interface SessionWorkMode {
  workMode: WorkMode;
  pendingWorkMode: WorkMode | null;
  workModeRevision: number;
}

function readWorkModeEntry(entry: SessionEntry): SessionWorkMode | undefined {
  if (entry.type !== "custom" || entry.customType !== SESSION_WORK_MODE_TYPE) return;
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

/** Session-wide, independent of the immutable prompt snapshot and currently selected branch. */
export function readSessionWorkMode(entries: readonly SessionEntry[], defaultMode?: WorkMode): SessionWorkMode {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const state = readWorkModeEntry(entries[index]);
    if (state) return state;
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

export function appendUserTurnMetadata(manager: SessionManager, mode: WorkMode, isSteering: boolean): void {
  manager.appendCustomEntry(TURN_WORK_MODE_TYPE, isSteering ? { mode, isSteering: true } : mode);
}

function readUserTurnMarker(data: unknown): { mode: WorkMode; isSteering?: true } | undefined {
  if (isWorkMode(data)) return { mode: data };
  if (data && typeof data === "object" && "mode" in data && isWorkMode(data.mode)) {
    return { mode: data.mode, isSteering: "isSteering" in data && data.isSteering === true ? true : undefined };
  }
}

/** Read per-message markers, and use the saved mode at the time of older entries. */
export function readUserTurnMetadata(entries: readonly SessionEntry[], userIds: ReadonlySet<string>) {
  const metadata = new Map<string, Pick<UserMessage, "turnWorkMode" | "isSteering">>();
  if (userIds.size === 0) return metadata;
  let sessionMode: SessionWorkMode | undefined;
  let presetMode: WorkMode = "auto";
  let previous: SessionEntry | undefined;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === PROMPT_SELECTION_TYPE && !sessionMode) {
      presetMode = readSessionPromptSelection([entry])?.mode ?? presetMode;
    }
    const explicitMode = readWorkModeEntry(entry);
    if (explicitMode) sessionMode = explicitMode;
    if (userIds.has(entry.id)) {
      const marker = previous?.id === entry.parentId && previous.type === "custom"
        && previous.customType === TURN_WORK_MODE_TYPE ? readUserTurnMarker(previous.data) : undefined;
      const mode = marker?.mode ?? sessionMode?.workMode ?? presetMode;
      if (mode !== "auto" || marker?.isSteering) {
        metadata.set(entry.id, { turnWorkMode: mode === "auto" ? undefined : mode, isSteering: marker?.isSteering });
      }
    }
    previous = entry;
  }
  return metadata;
}

/** Forks inherit the active policy, but a pending change belongs to the original conversation. */
export function inheritSessionWorkMode(manager: SessionManager, workMode: WorkMode): void {
  const copied = readSessionWorkMode(manager.getEntries() as unknown as SessionEntry[]);
  if (copied.workMode === workMode && copied.pendingWorkMode === null) return;
  appendSessionWorkMode(manager, { workMode, pendingWorkMode: null, workModeRevision: copied.workModeRevision + 1 });
}
