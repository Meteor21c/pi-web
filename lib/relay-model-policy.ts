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

export function relayContextWindowLimit(modelId: string): number {
  if (/gpt|codex/i.test(modelId)) return RELAY_GPT_FIRST_TIER_CONTEXT_WINDOW;
  if (/claude/i.test(modelId)) return RELAY_CLAUDE_DEFAULT_CONTEXT_WINDOW;
  return RELAY_OTHER_DEFAULT_CONTEXT_WINDOW;
}

export function clampRelayContextWindow(modelId: string, value?: number): number {
  const limit = relayContextWindowLimit(modelId);
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return limit;
  return Math.min(Math.floor(value), limit);
}
