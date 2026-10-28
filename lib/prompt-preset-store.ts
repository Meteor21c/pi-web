import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import {
  isWorkMode, MAX_PRESET_CONTENT_LENGTH, MAX_PROMPT_PRESETS, PromptPresetValidationError, validatePromptPreset,
  type PromptPresetSettings,
} from "./prompt-presets";

export function getPromptPresetSettingsPath(): string {
  return join(getAgentDir(), "meteoragent-prompt-presets.json");
}

export function readPromptPresetSettings(path = getPromptPresetSettingsPath()): PromptPresetSettings {
  if (!existsSync(path)) return { version: 2, presets: [], selectedPresetId: null, mode: "auto", defaultSystemPrompt: null };
  const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> | null;
  if (!data || (data.version !== 1 && data.version !== 2) || !Array.isArray(data.presets) || data.presets.length > MAX_PROMPT_PRESETS
    || !isWorkMode(data.mode) || (data.selectedPresetId !== null && typeof data.selectedPresetId !== "string")) {
    throw new Error("Invalid prompt preset settings; the existing file has been preserved");
  }
  const defaultSystemPrompt = data.version === 2 ? data.defaultSystemPrompt : null;
  if (defaultSystemPrompt !== null && (typeof defaultSystemPrompt !== "string"
    || !defaultSystemPrompt.trim() || defaultSystemPrompt.length > MAX_PRESET_CONTENT_LENGTH)) {
    throw new Error("Invalid default system prompt; the existing file has been preserved");
  }
  const presets = (data.presets as unknown[]).map(validatePromptPreset);
  if (new Set(presets.map((item) => item.id)).size !== presets.length
    || (data.selectedPresetId !== null && !presets.some((item) => item.id === data.selectedPresetId))) {
    throw new Error("Invalid prompt preset references; the existing file has been preserved");
  }
  return {
    version: 2,
    presets,
    selectedPresetId: data.selectedPresetId as string | null,
    mode: data.mode,
    defaultSystemPrompt: defaultSystemPrompt as string | null,
  };
}

/** Apply one operation to the latest file rather than overwriting a stale client list. */
export function updatePromptPresetSettings(value: unknown, path = getPromptPresetSettingsPath()): PromptPresetSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PromptPresetValidationError("Invalid action");
  const action = value as Record<string, unknown>;
  const settings = readPromptPresetSettings(path);
  if (action.type === "save") {
    const preset = validatePromptPreset(action.preset);
    const index = settings.presets.findIndex((item) => item.id === preset.id);
    if (index === -1) {
      if (settings.presets.length >= MAX_PROMPT_PRESETS) throw new PromptPresetValidationError(`At most ${MAX_PROMPT_PRESETS} presets are allowed`);
      settings.presets.push(preset);
    } else settings.presets[index] = preset;
  } else if (action.type === "delete") {
    if (typeof action.id !== "string" || !settings.presets.some((item) => item.id === action.id)) {
      throw new PromptPresetValidationError("Preset not found");
    }
    settings.presets = settings.presets.filter((item) => item.id !== action.id);
    if (settings.selectedPresetId === action.id) settings.selectedPresetId = null;
  } else if (action.type === "select") {
    if (action.selectedPresetId !== undefined) {
      if (action.selectedPresetId !== null && !settings.presets.some((item) => item.id === action.selectedPresetId)) {
        throw new PromptPresetValidationError("Preset not found");
      }
      settings.selectedPresetId = action.selectedPresetId as string | null;
    }
    if (action.mode !== undefined) {
      if (!isWorkMode(action.mode)) throw new PromptPresetValidationError("Invalid work mode");
      settings.mode = action.mode;
    }
  } else if (action.type === "set_default_prompt") {
    if (action.prompt !== null && (typeof action.prompt !== "string"
      || !action.prompt.trim() || action.prompt.length > MAX_PRESET_CONTENT_LENGTH)) {
      throw new PromptPresetValidationError(`Default system prompt must contain 1–${MAX_PRESET_CONTENT_LENGTH} characters`);
    }
    settings.defaultSystemPrompt = action.prompt as string | null;
  } else throw new PromptPresetValidationError("Unknown prompt preset action");
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, JSON.stringify(settings, null, 2));
  return settings;
}
