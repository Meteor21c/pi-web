import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "./types";

export const IMAGE_MODEL_SELECTION_TYPE = "magent:image-model-selection";

export interface SessionImageModelSelection {
  version: 1;
  providerId: string;
  modelId: string;
  alias: string;
}

function parse(value: unknown): SessionImageModelSelection | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (item.version !== 1) return undefined;
  if (typeof item.providerId !== "string" || !item.providerId.trim()) return undefined;
  if (typeof item.modelId !== "string" || !item.modelId.trim()) return undefined;
  if (typeof item.alias !== "string" || !item.alias.trim()) return undefined;
  return {
    version: 1,
    providerId: item.providerId.trim(),
    modelId: item.modelId.trim(),
    alias: item.alias.trim(),
  };
}

export function readSessionImageModelSelection(entries: readonly SessionEntry[]): SessionImageModelSelection | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== IMAGE_MODEL_SELECTION_TYPE) continue;
    const selection = parse(entry.data);
    if (selection) return selection;
  }
  return undefined;
}

export function appendSessionImageModelSelection(
  sessionManager: Pick<SessionManager, "appendCustomEntry">,
  selection: Omit<SessionImageModelSelection, "version">,
): SessionImageModelSelection {
  const normalized = parse({ version: 1, ...selection });
  if (!normalized) throw new Error("Invalid image model selection");
  sessionManager.appendCustomEntry(IMAGE_MODEL_SELECTION_TYPE, normalized);
  return normalized;
}
