export const MODEL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ModelInput = "text" | "image";
export type ModelThinkingLevelMap = Record<string, string | null>;

export interface ModelCapabilities {
  reasoning?: boolean;
  input?: ModelInput[];
  thinkingLevelMap?: ModelThinkingLevelMap;
}

// Pi clamps this configuration to its internal off level. The provider can
// still think according to its own defaults, because no effort is supplied.
export const AUTO_ONLY_THINKING_LEVEL_MAP: Readonly<ModelThinkingLevelMap> =
  Object.fromEntries(MODEL_THINKING_LEVELS.map((level) => [level, null]));

export const STANDARD_THINKING_LEVEL_MAP: Readonly<ModelThinkingLevelMap> = {
  off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max",
};

export function isAutoOnlyThinkingMap(map?: Readonly<ModelThinkingLevelMap>): boolean {
  return MODEL_THINKING_LEVELS.every((level) => map?.[level] === null);
}

export function relayModelCapabilityCompat(id: string): Record<string, unknown> | undefined {
  if (id.toLowerCase() !== "deepseek-v4.1-flash") return undefined;
  return {
    thinkingFormat: "deepseek",
    requiresReasoningContentOnAssistantMessages: true,
    supportsDeveloperRole: false,
    maxTokensField: "max_tokens",
  };
}

export function capabilityRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function readModelInput(value: unknown): ModelInput[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const input = value.flatMap((entry): ModelInput[] => {
    if (typeof entry !== "string") return [];
    const lower = entry.trim().toLowerCase();
    return lower === "text" || lower === "image" ? [lower] : [];
  });
  return input.length ? (["text", "image"] as const).filter((item) => input.includes(item)) : undefined;
}

export function readModelThinkingLevelMap(value: unknown): ModelThinkingLevelMap | undefined {
  const record = capabilityRecord(value);
  if (!record) return undefined;
  const entries = MODEL_THINKING_LEVELS.flatMap((level): [string, string | null][] => {
    const effort = record[level];
    return effort === null || (typeof effort === "string" && /^[\w-]{1,32}$/.test(effort)) ? [[level, effort]] : [];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function thinkingMapFromLevels(value: unknown): ModelThinkingLevelMap | undefined {
  if (!Array.isArray(value)) return undefined;
  const levels = new Set(value.flatMap((entry) => typeof entry === "string" ? [entry.trim().toLowerCase()] : []));
  if (levels.size === 1 && levels.has("auto")) return { ...AUTO_ONLY_THINKING_LEVEL_MAP };
  if (levels.has("none")) levels.add("off");
  if (!MODEL_THINKING_LEVELS.some((level) => levels.has(level))) return undefined;
  return Object.fromEntries(MODEL_THINKING_LEVELS.map((level) => [level, levels.has(level)
    ? (level === "off" && levels.has("none") ? "none" : level) : null]));
}

/** Read only explicit capabilities. IDs, transport, and pricing come from their own sources. */
export function readUpstreamModelCapabilities(value: Record<string, unknown>): ModelCapabilities {
  const caps = capabilityRecord(value.capabilities);
  const thinkingLevelMap = readModelThinkingLevelMap(value.thinkingLevelMap ?? value.thinking_level_map ?? caps?.thinkingLevelMap ?? caps?.thinking_level_map)
    ?? thinkingMapFromLevels(value.supported_reasoning_efforts ?? value.reasoning_efforts ?? value.thinking_levels
      ?? caps?.supported_reasoning_efforts ?? caps?.reasoning_efforts ?? caps?.thinking_levels);
  const flags = [value.reasoning, value.supports_reasoning, value.thinking, caps?.reasoning, caps?.thinking];
  const explicitReasoning = flags.find((flag): flag is boolean => typeof flag === "boolean");
  const reasoning = explicitReasoning ?? (thinkingLevelMap ? true : undefined);
  const input = readModelInput(capabilityRecord(value.modalities)?.input ?? value.input_modalities
    ?? capabilityRecord(value.architecture)?.input_modalities ?? value.input ?? caps?.input_modalities);
  const imageFlag = value.supports_vision ?? caps?.vision ?? caps?.image_input;
  return {
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(input ? { input } : typeof imageFlag === "boolean" ? { input: imageFlag ? ["text", "image"] : ["text"] } : {}),
    ...(reasoning !== false && thinkingLevelMap ? { thinkingLevelMap } : {}),
  };
}
