/**
 * meteor21c relay — 内置模型元数据表与 models.json provider 片段构建。
 *
 * 背景：中转站 /v1/models 只返回模型 id，不含 contextWindow / maxTokens / 价格。
 * pi 对缺失字段按保守默认（128K 上下文）处理，会造成长会话中途截断，
 * 因此这里内置 M0 实测收集的双分组模型目录（GPT 10 + Claude 12）。
 * 价格为公开目录参考值（USD / 百万 tokens），仅影响本地成本显示；
 * MeteorAgent 产品界面将其作为只读信息，不允许用户手工改写。
 *
 * 目录来源：M0 实测（2026-09-15），见 A3 方案设计文档 §10。
 */

import { getRelayBaseUrl, getRelayResponsesBaseUrl } from "./relay-config";
import { canonicalAnthropicThinkingCompat, canonicalModelContextWindow, canonicalModelOutputTokenLimit, resolveModelCapabilities } from "./model-capability-catalog";
import { relayModelCapabilityCompat, type ModelCapabilities } from "./model-capabilities";
import type { ModelCatalogEntry } from "./model-catalog";
import {
  RELAY_CLAUDE_DEFAULT_CONTEXT_WINDOW,
  RELAY_GPT_DEFAULT_CONTEXT_WINDOW,
  RELAY_OTHER_DEFAULT_CONTEXT_WINDOW,
  readContextWindowTokens,
  relayDefaultContextWindow,
} from "./relay-model-policy";
import { isRelayImageGenerationModel } from "./relay-image-generation";
import {
  readOutputTokenLimit,
  RELAY_FALLBACK_MAX_OUTPUT_TOKENS,
  resolveRelayMaxOutputTokens,
  type RelayOutputPreferences,
} from "./relay-output-policy";

export interface RelayModelDef extends ModelCapabilities, RelayOutputPreferences {
  id: string;
  name?: string;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  /** Explicit context window chosen by the user. */
  meteorAgentContextWindowOverride?: number;
  /** Context window reported by the authenticated relay catalog. */
  meteorAgentUpstreamContextWindow?: number;
  /** Auto window from the matching models.dev or bundled Pi configuration. */
  meteorAgentCatalogContextWindow?: number;
  maxTokens?: number;
  api?: string;
  baseUrl?: string;
  meteorAgentCapabilityOverrides?: ModelCapabilities;
  compat?: Record<string, unknown>;
}

export interface RelayModelUpstreamMetadata extends ModelCapabilities {
  maxOutputTokens?: number;
  contextWindow?: number;
}

const GPT_FAMILY = { contextWindow: RELAY_GPT_DEFAULT_CONTEXT_WINDOW, maxTokens: 128_000, cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 } } as const;
const GPT_CODEX_FAMILY = { contextWindow: RELAY_GPT_DEFAULT_CONTEXT_WINDOW, maxTokens: 100_000, cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 } } as const;
const GPT_MINI_FAMILY = { contextWindow: RELAY_GPT_DEFAULT_CONTEXT_WINDOW, maxTokens: 128_000, cost: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 } } as const;
const GPT_FLAGSHIP_FAMILY = { contextWindow: RELAY_GPT_DEFAULT_CONTEXT_WINDOW, maxTokens: 128_000, cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 } } as const;
const OPUS_FAMILY = { contextWindow: RELAY_CLAUDE_DEFAULT_CONTEXT_WINDOW, maxTokens: 64_000, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } } as const;
const SONNET_FAMILY = { contextWindow: RELAY_CLAUDE_DEFAULT_CONTEXT_WINDOW, maxTokens: 64_000, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } } as const;
const HAIKU_FAMILY = { contextWindow: RELAY_CLAUDE_DEFAULT_CONTEXT_WINDOW, maxTokens: 64_000, cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } } as const;
// Anthropic's Fable card differs from Sonnet. These values are only the
// offline fallback; an account sync prefers the relay model-plaza prices.
const FABLE5_FAMILY = { contextWindow: RELAY_CLAUDE_DEFAULT_CONTEXT_WINDOW, maxTokens: 64_000, cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } } as const;
const FABLE51_FAMILY = { contextWindow: RELAY_CLAUDE_DEFAULT_CONTEXT_WINDOW, maxTokens: 64_000, cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 } } as const;

/** GPT 分组（M0 实测目录） */
const GPT_MODELS: RelayModelDef[] = [
  { id: "gpt-5.6", ...GPT_FAMILY },
  { id: "gpt-5.6-luna", ...GPT_FAMILY },
  { id: "gpt-5.6-sol", ...GPT_FAMILY },
  { id: "gpt-5.6-terra", ...GPT_FAMILY },
  { id: "gpt-5.5", ...GPT_FAMILY },
  { id: "gpt-5.4", ...GPT_FAMILY },
  { id: "gpt-5.4-mini", ...GPT_MINI_FAMILY },
  { id: "gpt-5.3-codex-spark", ...GPT_CODEX_FAMILY },
  { id: "codex-auto-review", ...GPT_CODEX_FAMILY },
  { id: "gpt-6-astra", ...GPT_FLAGSHIP_FAMILY },
];

/** Claude 分组（M0 实测目录；在线同步时以模型广场官方价覆盖） */
const CLAUDE_MODELS: RelayModelDef[] = [
  { id: "claude-opus-5", ...OPUS_FAMILY },
  { id: "claude-opus-4-8", ...OPUS_FAMILY },
  { id: "claude-opus-4-7", ...OPUS_FAMILY },
  { id: "claude-opus-4-6", ...OPUS_FAMILY },
  { id: "claude-sonnet-5", ...SONNET_FAMILY },
  { id: "claude-sonnet-4-6", ...SONNET_FAMILY },
  { id: "claude-sonnet-4-5", ...SONNET_FAMILY },
  { id: "claude-sonnet-4-5-20250929", ...SONNET_FAMILY },
  { id: "claude-haiku-4-5", ...HAIKU_FAMILY },
  { id: "claude-haiku-4-5-20251001", ...HAIKU_FAMILY },
  { id: "claude-fable-5", ...FABLE5_FAMILY },
  { id: "claude-fable-5.1", ...FABLE51_FAMILY },
  // The relay has emitted the hyphenated spelling as well; keep both forms
  // available so an offline catalog is useful before the next sync.
  { id: "claude-fable-5-1", ...FABLE51_FAMILY },
];

const GPT_MATCH = /gpt|codex/i;
const CLAUDE_MATCH = /claude/i;

const TABLE_BY_FAMILY: Record<"gpt" | "claude", Map<string, RelayModelDef>> = {
  gpt: new Map(GPT_MODELS.map((x) => [x.id, x])),
  claude: new Map(CLAUDE_MODELS.map((x) => [x.id, x])),
};

const FALLBACK: RelayModelDef = {
  id: "",
  contextWindow: RELAY_OTHER_DEFAULT_CONTEXT_WINDOW,
  maxTokens: RELAY_FALLBACK_MAX_OUTPUT_TOKENS,
};

function modelFamily(id: string): "gpt" | "claude" | "other" {
  return CLAUDE_MATCH.test(id) ? "claude" : GPT_MATCH.test(id) ? "gpt" : "other";
}

function relayModelApi(family: ReturnType<typeof modelFamily>): string {
  return family === "claude" ? "anthropic-messages" : family === "gpt" ? "openai-responses" : "openai-completions";
}

export function relayOutputNeedsCatalog(id: string, upstream?: RelayModelUpstreamMetadata): boolean {
  // Don't delay a relay group sync just to find a limit for a protocol that
  // can use Auto without one. Anthropic Messages requires the field.
  return modelFamily(id) === "claude"
    && readOutputTokenLimit(upstream?.maxOutputTokens) === undefined
    && canonicalModelOutputTokenLimit(id, "anthropic-messages") === undefined;
}

/** Resolve local context and price fallbacks independently of capabilities. */
function relayModelFallback(family: "gpt" | "claude" | "other", id: string): RelayModelDef {
  if (family === "other") return { ...FALLBACK, id };
  return TABLE_BY_FAMILY[family].get(id) ?? {
    ...FALLBACK,
    id,
    contextWindow: relayDefaultContextWindow(id),
  };
}

export function relayOutputTokenFallback(id: string): number {
  return relayModelFallback(modelFamily(id), id).maxTokens ?? RELAY_FALLBACK_MAX_OUTPUT_TOKENS;
}

export function resolveRelayModels(family: "gpt" | "claude" | "other", remoteIds?: string[]): RelayModelDef[] {
  const ids = remoteIds?.length ? remoteIds : family === "other" ? [] : [...TABLE_BY_FAMILY[family].keys()];
  return ids.filter((id) => family === "claude" ? CLAUDE_MATCH.test(id)
    : family === "gpt" ? GPT_MATCH.test(id)
      : !CLAUDE_MATCH.test(id) && !GPT_MATCH.test(id)).map((id) => {
    const model = relayModelFallback(family, id);
    const limit = canonicalModelOutputTokenLimit(id, relayModelApi(family));
    const output: RelayOutputPreferences = limit === undefined ? {} : {
      meteorAgentMaxOutputTokensLimit: limit,
      meteorAgentMaxOutputTokensSource: "catalog",
    };
    const compat = family === "claude" ? canonicalAnthropicThinkingCompat(id) : undefined;
    const contextWindow = canonicalModelContextWindow(id, relayModelApi(family)) ?? model.contextWindow;
    return {
      ...model,
      ...output,
      name: id,
      contextWindow,
      maxTokens: resolveRelayMaxOutputTokens(output, contextWindow, model.maxTokens),
      ...resolveModelCapabilities({ id }),
      ...(compat ? { compat } : {}),
    };
  });
}

/** SDK supports per-model api/baseUrl; preserve all families under one key. */
export function resolveMixedRelayModels(
  ids: readonly string[],
  base = getRelayBaseUrl(),
  upstream: ReadonlyMap<string, RelayModelUpstreamMetadata> = new Map(),
  catalog: readonly ModelCatalogEntry[] = [],
  groupName?: string,
): RelayModelDef[] {
  return [...new Set(ids)].flatMap((id) => {
    // Non-chat endpoints must not be advertised as conversational models.
    if (isRelayImageGenerationModel(id) || /embedding|whisper|tts|sora|rerank/i.test(id)) return [];
    const family = modelFamily(id);
    const api = relayModelApi(family);
    const model = relayModelFallback(family, id);
    const metadata = upstream.get(id);
    const relayLimit = readOutputTokenLimit(metadata?.maxOutputTokens);
    const limit = relayLimit ?? canonicalModelOutputTokenLimit(id, api, catalog);
    const output: RelayOutputPreferences = limit === undefined ? {} : {
      meteorAgentMaxOutputTokensLimit: limit,
      meteorAgentMaxOutputTokensSource: relayLimit === undefined ? "catalog" : "relay",
    };
    const catalogContext = canonicalModelContextWindow(id, api, groupName, catalog);
    const upstreamContext = readContextWindowTokens(metadata?.contextWindow);
    const contextWindow = upstreamContext ?? catalogContext ?? model.contextWindow ?? relayDefaultContextWindow(id);
    const compat = api === "anthropic-messages" ? canonicalAnthropicThinkingCompat(id) : relayModelCapabilityCompat(id);
    return [{
      ...model,
      ...resolveModelCapabilities({ id, api }, metadata, catalog),
      ...output,
      name: id,
      contextWindow,
      ...(upstreamContext === undefined ? {} : { meteorAgentUpstreamContextWindow: upstreamContext }),
      ...(catalogContext === undefined ? {} : { meteorAgentCatalogContextWindow: catalogContext }),
      maxTokens: resolveRelayMaxOutputTokens(output, contextWindow, model.maxTokens),
      api,
      baseUrl: family === "claude" ? base : `${base}/v1`,
      ...(compat ? { compat } : {}),
    }];
  });
}

/**
 * 构建写入 models.json 的三 provider 片段。三条通道按协议分流（M0 实测）：
 *  - meteor21c        → openai-responses（GPT/Codex 系；该系走 chat/completions 会 400）
 *  - meteor21c-claude → anthropic-messages（Claude 系原生透传）
 *  - meteor21c-openai → openai-completions（其余长尾分组：deepseek/grok/绘图等）
 * remoteIds 为该 key 实际可见的 /v1/models 目录；不传则用内置表兜底（仅 gpt/claude）。
 */
export function buildRelayProviderConfigs(remoteIds?: string[]): Record<string, unknown> {
  return {
    "meteor21c": {
      baseUrl: getRelayResponsesBaseUrl(),
      api: "openai-responses",
      models: resolveRelayModels("gpt", remoteIds),
    },
    "meteor21c-claude": {
      baseUrl: getRelayBaseUrl(),
      api: "anthropic-messages",
      models: resolveRelayModels("claude", remoteIds),
    },
    "meteor21c-openai": {
      baseUrl: getRelayResponsesBaseUrl(),
      api: "openai-completions",
      models: resolveRelayModels("other", remoteIds),
    },
  };
}
