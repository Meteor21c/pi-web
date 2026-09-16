import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "./types";

/**
 * A session-local plugin selection is persisted as a custom session entry.
 *
 * Keep this separate from the package manager settings: settings describe what
 * is installed and its default activation policy, while this entry describes
 * the immutable (until explicitly changed) selection for one conversation.
 */
export const PLUGIN_SELECTION_TYPE = "pi-web:plugin-selection";

export type SessionPluginScope = "global" | "project";

export interface SessionPluginSelection {
  source: string;
  scope: SessionPluginScope;
  enabled: boolean;
}

export interface SessionPluginSelectionData {
  version: 1;
  plugins: SessionPluginSelection[];
}

function parseSelectionData(data: unknown): SessionPluginSelection[] | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const candidate = data as { version?: unknown; plugins?: unknown };
  if (candidate.version !== 1 || !Array.isArray(candidate.plugins)) return undefined;

  const byKey = new Map<string, SessionPluginSelection>();
  for (const item of candidate.plugins) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
    const plugin = item as { source?: unknown; scope?: unknown; enabled?: unknown };
    if (
      typeof plugin.source !== "string"
      || plugin.source.trim() === ""
      || (plugin.scope !== "global" && plugin.scope !== "project")
      || typeof plugin.enabled !== "boolean"
    ) return undefined;
    const normalized: SessionPluginSelection = {
      source: plugin.source.trim(),
      scope: plugin.scope,
      enabled: plugin.enabled,
    };
    // Last occurrence wins, matching the newest-entry-wins behavior of this
    // file format while making malformed duplicate data deterministic.
    byKey.set(selectionKey(normalized.source, normalized.scope), normalized);
  }
  return [...byKey.values()];
}

export function selectionKey(source: string, scope: SessionPluginScope): string {
  return `${scope}\0${source}`;
}

/**
 * Return the newest valid session plugin selection. Undefined means that the
 * session predates this feature (and therefore has no explicit local policy).
 */
export function readSessionPluginSelection(
  entries: readonly SessionEntry[],
): SessionPluginSelection[] | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== PLUGIN_SELECTION_TYPE) continue;
    const parsed = parseSelectionData(entry.data);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

export function validateSessionPluginSelection(value: unknown): SessionPluginSelection[] {
  const parsed = parseSelectionData({ version: 1, plugins: value });
  if (parsed === undefined) {
    throw new Error("plugins must contain { source, scope, enabled } entries");
  }
  return parsed;
}

export function appendSessionPluginSelection(
  sessionManager: Pick<SessionManager, "appendCustomEntry">,
  plugins: readonly SessionPluginSelection[],
): void {
  const normalized = validateSessionPluginSelection(plugins);
  sessionManager.appendCustomEntry(PLUGIN_SELECTION_TYPE, {
    version: 1,
    plugins: normalized,
  } satisfies SessionPluginSelectionData);
}
