import { isModelThinkingLevel, type ThinkingLevelOption } from "./model-capabilities";
import type { SessionEntry } from "./types";

export const THINKING_SELECTION_TYPE = "meteoragent:thinking-selection";

export function readSessionThinkingSelection(branch: readonly SessionEntry[]): ThinkingLevelOption | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type === "thinking_level_change") return undefined;
    if (entry.type !== "custom" || entry.customType !== THINKING_SELECTION_TYPE) continue;
    if (entry.data === "auto" || isModelThinkingLevel(entry.data)) return entry.data;
  }
}
