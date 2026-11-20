import type { Api, Model } from "@earendil-works/pi-ai";
import { capabilityRecord } from "./model-capabilities";
import { isRelayProviderId } from "./relay-config";

export const RELAY_FALLBACK_MAX_OUTPUT_TOKENS = 16_384;

export interface RelayOutputPreferences {
  /** Explicit user preference, independent of the effective SDK model metadata. */
  meteorAgentMaxOutputTokensOverride?: number;
  /** Model output ceiling reported by this route or an exact canonical model entry. */
  meteorAgentMaxOutputTokensLimit?: number;
  meteorAgentMaxOutputTokensSource?: "relay" | "catalog";
}

export function readOutputTokenLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function readRelayOutputPreferences(value: unknown): RelayOutputPreferences {
  const model = capabilityRecord(value);
  const override = readOutputTokenLimit(model?.meteorAgentMaxOutputTokensOverride);
  const limit = readOutputTokenLimit(model?.meteorAgentMaxOutputTokensLimit);
  const source = model?.meteorAgentMaxOutputTokensSource;
  return {
    ...(override === undefined ? {} : { meteorAgentMaxOutputTokensOverride: override }),
    ...(limit === undefined ? {} : { meteorAgentMaxOutputTokensLimit: limit }),
    ...(limit !== undefined && (source === "relay" || source === "catalog") ? { meteorAgentMaxOutputTokensSource: source } : {}),
  };
}

/** Read explicit positive output-token metadata only; `max_tokens` can be an
 * input-context or billing field, so do not infer an output limit from it. */
export function upstreamRelayOutputTokenLimit(value: Record<string, unknown>): number | undefined {
  const limits = capabilityRecord(value.limit);
  const caps = capabilityRecord(value.capabilities);
  const candidates = [
    value.max_output_tokens, value.maxOutputTokens, value.max_completion_tokens, value.output_token_limit,
    limits?.output, caps?.max_output_tokens, caps?.maxOutputTokens, caps?.max_completion_tokens, caps?.output_token_limit,
  ].flatMap((candidate) => {
    const valid = readOutputTokenLimit(candidate);
    return valid === undefined ? [] : [valid];
  });
  return candidates.length ? Math.min(...candidates) : undefined;
}

/**
 * Pi always needs positive numeric model metadata. Keep a local budget for its
 * context accounting even when the protocol lets the upstream choose a wire
 * default. An explicit override may exceed a fallback, but never a known cap.
 */
export function resolveRelayMaxOutputTokens(
  preferences: RelayOutputPreferences,
  contextWindow: unknown,
  fallback = RELAY_FALLBACK_MAX_OUTPUT_TOKENS,
): number {
  const override = readOutputTokenLimit(preferences.meteorAgentMaxOutputTokensOverride);
  const limit = readOutputTokenLimit(preferences.meteorAgentMaxOutputTokensLimit);
  return Math.min(
    override ?? limit ?? readOutputTokenLimit(fallback) ?? RELAY_FALLBACK_MAX_OUTPUT_TOKENS,
    limit ?? Infinity,
    readOutputTokenLimit(contextWindow) ?? Infinity,
  );
}

type PayloadOptions<M> = { maxTokens?: number; onPayload?: (payload: unknown, model: M) => unknown | Promise<unknown> };

/**
 * Only the normal relay chat path in Auto omits the OpenAI-style fields.
 * Explicit per-request budgets (such as compaction) and required Anthropic
 * max_tokens keep their semantics, as do all non-relay providers.
 */
export function applyRelayOutputPolicy<M extends Model<Api>, T extends PayloadOptions<M>>(
  model: M,
  options: T | undefined,
  resolvePreferences: (model: M) => RelayOutputPreferences,
): { model: M; options: T | undefined } {
  if (!isRelayProviderId(model.provider)) return { model, options };

  const optional = model.api === "openai-completions" || model.api === "openai-responses";
  if (!optional && model.api !== "anthropic-messages") return { model, options };

  const preferences = resolvePreferences(model);
  const override = readOutputTokenLimit(preferences.meteorAgentMaxOutputTokensOverride);
  const explicitRequest = readOutputTokenLimit(options?.maxTokens);

  if (optional && override === undefined && explicitRequest === undefined) {
    return {
      model,
      options: {
        ...options,
        onPayload(payload, requestModel) {
          const request = capabilityRecord(payload);
          if (request) {
            delete request.max_tokens;
            delete request.max_completion_tokens;
            delete request.max_output_tokens;
          }
          return options?.onPayload?.(payload, requestModel);
        },
      } as T,
    };
  }

  const maxTokens = resolveRelayMaxOutputTokens(preferences, model.contextWindow, model.maxTokens);
  return {
    model: model.maxTokens === maxTokens ? model : { ...model, maxTokens },
    options: {
      ...options,
      maxTokens: Math.min(explicitRequest ?? maxTokens, maxTokens),
    } as T,
  };
}
