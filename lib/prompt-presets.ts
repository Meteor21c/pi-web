import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "./types";

export const WORK_MODES = ["auto", "plan", "goal"] as const;
export type WorkMode = typeof WORK_MODES[number];
export const MAX_PROMPT_PRESETS = 100;
export const MAX_PRESET_NAME_LENGTH = 80;
export const MAX_PRESET_CONTENT_LENGTH = 120_000;
export const PROMPT_SELECTION_TYPE = "meteoragent:prompt-selection";
export const METEORAGENT_DEFAULT_PROMPT_ID = "meteoragent-default-prompt";
export const PLAN_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);

export interface PromptPreset {
  id: string;
  name: string;
  content: string;
}

export interface PromptPresetSettings {
  version: 2;
  presets: PromptPreset[];
  selectedPresetId: string | null;
  mode: WorkMode;
  defaultSystemPrompt: string | null;
}

export interface SessionPromptSelection {
  version: 1 | 2;
  mode: WorkMode;
  preset: PromptPreset | null;
}

export class PromptPresetValidationError extends Error {}

export function isWorkMode(value: unknown): value is WorkMode {
  return typeof value === "string" && WORK_MODES.includes(value as WorkMode);
}

export function validatePromptPreset(value: unknown): PromptPreset {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PromptPresetValidationError("Invalid prompt preset");
  }
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id)) {
    throw new PromptPresetValidationError("Invalid preset id");
  }
  if (typeof item.name !== "string" || !item.name.trim() || item.name.trim().length > MAX_PRESET_NAME_LENGTH) {
    throw new PromptPresetValidationError(`Preset name must contain 1–${MAX_PRESET_NAME_LENGTH} characters`);
  }
  if (typeof item.content !== "string" || !item.content.trim() || item.content.length > MAX_PRESET_CONTENT_LENGTH) {
    throw new PromptPresetValidationError(`Preset content must contain 1–${MAX_PRESET_CONTENT_LENGTH} characters`);
  }
  return { id: item.id, name: item.name.trim(), content: item.content };
}

export function promptSelectionFromSettings(settings: PromptPresetSettings): SessionPromptSelection {
  const selected = settings.presets.find((item) => item.id === settings.selectedPresetId);
  const preset = selected ?? (settings.defaultSystemPrompt
    ? {
        id: METEORAGENT_DEFAULT_PROMPT_ID,
        name: "MeteorAgent 默认提示词",
        content: settings.defaultSystemPrompt,
      }
    : null);
  return { version: 2, mode: settings.mode, preset: preset ? { ...preset } : null };
}

export function readSessionPromptSelection(entries: readonly SessionEntry[]): SessionPromptSelection | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== PROMPT_SELECTION_TYPE) continue;
    const data = entry.data as Partial<SessionPromptSelection> | null;
    if (!data || (data.version !== 1 && data.version !== 2) || !isWorkMode(data.mode)) continue;
    try {
      return { version: data.version, mode: data.mode, preset: data.preset === null ? null : validatePromptPreset(data.preset) };
    } catch {
      // Ignore malformed metadata, without applying the current global default.
    }
  }
  return undefined;
}

export function appendSessionPromptSelection(manager: SessionManager, selection: SessionPromptSelection): void {
  manager.appendCustomEntry(PROMPT_SELECTION_TYPE, selection);
}

export const MODE_INSTRUCTIONS: Record<WorkMode, string> = {
  auto: "",
  plan: "You are in Plan mode. Analyze the user's request, inspect relevant files with the available read-only tools, and produce an actionable plan with clear steps, assumptions, and acceptance criteria. Do not change files, execute shell commands, install anything, generate assets, or perform external writes. Do not claim implementation is complete. If implementation is requested, explain that a new conversation in Auto or Goal mode is needed to carry it out.",
  goal: "You are in Goal mode. Treat the user's request as a concrete goal. Establish the desired outcome and practical acceptance criteria, then work through the necessary steps using the available tools. Continue within this task until the goal is achieved or a genuine blocker needs user input. Verify material results where feasible and summarize the outcome, evidence, and any remaining work in plain language. Never claim success without evidence, invent progress, or repeat failed actions indefinitely. Respect user stops, permissions, and scope; this mode does not authorize background scheduling or automatic future turns.",
};

/** v1 sessions keep their saved additive behavior; v2 presets replace the full system prompt. */
export function composeSessionSystemPrompt(base: string, selection?: SessionPromptSelection): string {
  if (!selection) return base;
  const prompt = selection.version === 1
    ? [base, selection.preset?.content].filter(Boolean).join("\n\n")
    : selection.preset?.content ?? base;
  return [prompt, MODE_INSTRUCTIONS[selection.mode]].filter(Boolean).join("\n\n");
}
