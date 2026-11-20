/**
 * Product-safe model limits for MeteorAgent-managed relay groups.
 *
 * The relay catalog only guarantees model IDs. These limits deliberately keep
 * a new conversation inside the first pricing tier instead of advertising the
 * largest context window an upstream model may technically accept.
 */
export const RELAY_GPT_FIRST_TIER_CONTEXT_WINDOW = 258_000;
export const RELAY_CLAUDE_DEFAULT_CONTEXT_WINDOW = 200_000;
export const RELAY_OTHER_DEFAULT_CONTEXT_WINDOW = 128_000;

export function readContextWindowTokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function relayContextWindowLimit(modelId: string, synchronizedLimit?: number): number {
  const verified = readContextWindowTokens(synchronizedLimit);
  if (verified !== undefined) return verified;
  if (/gpt|codex/i.test(modelId)) return RELAY_GPT_FIRST_TIER_CONTEXT_WINDOW;
  if (/claude/i.test(modelId)) return RELAY_CLAUDE_DEFAULT_CONTEXT_WINDOW;
  return RELAY_OTHER_DEFAULT_CONTEXT_WINDOW;
}

/** The product GPT/Codex limit remains a ceiling when the plaza has no entry. */
export function relayContextWindowCeiling(modelId: string, synchronizedLimit?: number): number | undefined {
  return readContextWindowTokens(synchronizedLimit)
    ?? (/gpt|codex/i.test(modelId) ? RELAY_GPT_FIRST_TIER_CONTEXT_WINDOW : undefined);
}

export function resolveRelayContextWindow(modelId: string, customValue?: number, synchronizedLimit?: number): number {
  const custom = readContextWindowTokens(customValue);
  if (custom === undefined) return relayContextWindowLimit(modelId, synchronizedLimit);
  return Math.min(custom, relayContextWindowCeiling(modelId, synchronizedLimit) ?? custom);
}

export function clampRelayContextWindow(modelId: string, value?: number, synchronizedLimit?: number): number {
  const limit = relayContextWindowLimit(modelId, synchronizedLimit);
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return limit;
  return Math.min(Math.floor(value), limit);
}
