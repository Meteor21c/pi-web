/** Defaults for relay models whose pricing metadata does not specify a first tier. */
export const RELAY_GPT_DEFAULT_CONTEXT_WINDOW = 258_000;
export const RELAY_CLAUDE_DEFAULT_CONTEXT_WINDOW = 200_000;
export const RELAY_OTHER_DEFAULT_CONTEXT_WINDOW = 128_000;

export function readContextWindowTokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function relayDefaultContextWindow(modelId: string, synchronizedLimit?: number): number {
  const verified = readContextWindowTokens(synchronizedLimit);
  if (verified !== undefined) return verified;
  if (/gpt|codex/i.test(modelId)) return RELAY_GPT_DEFAULT_CONTEXT_WINDOW;
  if (/claude/i.test(modelId)) return RELAY_CLAUDE_DEFAULT_CONTEXT_WINDOW;
  return RELAY_OTHER_DEFAULT_CONTEXT_WINDOW;
}

export function resolveRelayContextWindow(modelId: string, customValue?: number, synchronizedLimit?: number): number {
  return readContextWindowTokens(customValue) ?? relayDefaultContextWindow(modelId, synchronizedLimit);
}
