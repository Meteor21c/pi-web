import { capabilityRecord } from "./model-capabilities";

/** Defaults for relay models without a synchronized or catalog context window. */
export const RELAY_GPT_DEFAULT_CONTEXT_WINDOW = 258_000;
export const RELAY_CLAUDE_DEFAULT_CONTEXT_WINDOW = 200_000;
export const RELAY_OTHER_DEFAULT_CONTEXT_WINDOW = 128_000;

export function readContextWindowTokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function relayDefaultContextWindow(modelId: string, synchronizedLimit?: number, modelDefault?: number): number {
  const verified = readContextWindowTokens(synchronizedLimit) ?? readContextWindowTokens(modelDefault);
  if (verified !== undefined) return verified;
  if (/gpt|codex/i.test(modelId)) return RELAY_GPT_DEFAULT_CONTEXT_WINDOW;
  if (/claude/i.test(modelId)) return RELAY_CLAUDE_DEFAULT_CONTEXT_WINDOW;
  return RELAY_OTHER_DEFAULT_CONTEXT_WINDOW;
}

export function resolveRelayContextWindow(modelId: string, customValue?: number, synchronizedLimit?: number, modelDefault?: number): number {
  return readContextWindowTokens(customValue) ?? relayDefaultContextWindow(modelId, synchronizedLimit, modelDefault);
}

export function upstreamRelayContextWindow(model: Record<string, unknown>): number | undefined {
  const caps = capabilityRecord(model.capabilities);
  return [
    model.context_window, model.contextWindow, model.context_length, model.max_context_tokens,
    capabilityRecord(model.limit)?.context, caps?.context_window, caps?.contextWindow,
  ].map(readContextWindowTokens).find((value) => value !== undefined);
}
