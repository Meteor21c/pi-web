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
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
  RELAY_CLAUDE_DEFAULT_CONTEXT_WINDOW,
  RELAY_GPT_FIRST_TIER_CONTEXT_WINDOW,
  RELAY_OTHER_DEFAULT_CONTEXT_WINDOW,
  clampRelayContextWindow,
} from "./relay-model-policy";
import { isRelayImageGenerationModel } from "./relay-image-generation";

export interface RelayModelDef {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
  api?: string;
  baseUrl?: string;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: Record<string, unknown>;
}

const GPT_FAMILY = { contextWindow: RELAY_GPT_FIRST_TIER_CONTEXT_WINDOW, maxTokens: 128_000, cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 } } as const;
const GPT_CODEX_FAMILY = { contextWindow: RELAY_GPT_FIRST_TIER_CONTEXT_WINDOW, maxTokens: 100_000, cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 } } as const;
const GPT_MINI_FAMILY = { contextWindow: RELAY_GPT_FIRST_TIER_CONTEXT_WINDOW, maxTokens: 128_000, cost: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 } } as const;
const GPT_FLAGSHIP_FAMILY = { contextWindow: RELAY_GPT_FIRST_TIER_CONTEXT_WINDOW, maxTokens: 128_000, cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 } } as const;
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

type RelayModelCapabilities = Pick<RelayModelDef, "reasoning" | "input" | "thinkingLevelMap">;

/**
 * Only enrich exact IDs from well-known upstream catalogs. An unknown or
 * relay-specific alias must keep the existing conservative fallback so that a
 * similar-looking name never enables a request feature the relay cannot use.
 */
const BUILTIN_CAPABILITIES = new Map<string, RelayModelCapabilities>(
  (["openai", "anthropic", "xai", "google", "deepseek"] as const).flatMap((provider) => (
    getBuiltinModels(provider).map((model) => [model.id.toLocaleLowerCase(), {
      reasoning: model.reasoning,
      input: model.input.filter((value): value is "text" | "image" => value === "text" || value === "image"),
      thinkingLevelMap: model.thinkingLevelMap ? { ...model.thinkingLevelMap } : undefined,
    }] as const)
  )),
);

// The relay has exposed Fable 5.1 with both a dotted and a hyphenated ID.
// pi-ai currently uses the hyphenated spelling, so explicitly share its
// authoritative capabilities with the relay's dotted alias as well.
const fable51Capabilities = BUILTIN_CAPABILITIES.get("claude-fable-5-1");
if (fable51Capabilities) {
  BUILTIN_CAPABILITIES.set("claude-fable-5.1", fable51Capabilities);
}

const FALLBACK: RelayModelDef = {
  id: "",
  reasoning: false,
  input: ["text"],
  contextWindow: RELAY_OTHER_DEFAULT_CONTEXT_WINDOW,
  maxTokens: 16_384,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/**
 * 用内置元数据补全远端 /v1/models 返回的模型 id 列表。
 * family:
 *  - "gpt" / "claude"：内置表命中取元数据，未命中走保守 FALLBACK；无远端列表时返回内置全表（离线兜底）
 *  - "other"：远端目录中不属于 gpt/claude 家族的其余模型；精确命中常见上游目录时补全能力，未知模型保持 FALLBACK
 */
export function resolveRelayModels(
  family: "gpt" | "claude" | "other",
  remoteIds?: string[],
): RelayModelDef[] {
  if (family === "other") {
    if (!remoteIds || remoteIds.length === 0) return [];
    return remoteIds
      .filter((id) => !GPT_MATCH.test(id) && !CLAUDE_MATCH.test(id))
      .map((id) => withCommonCapabilities({ ...FALLBACK, id, name: id }));
  }

  const table = TABLE_BY_FAMILY[family];
  const match = family === "gpt" ? GPT_MATCH : CLAUDE_MATCH;
  if (!remoteIds || remoteIds.length === 0) {
    return [...table.values()].map(withKnownCapabilities);
  }
  return remoteIds
    .filter((id) => match.test(id))
    .map((id) => ({
      ...(table.has(id)
        ? withKnownCapabilities(table.get(id)!)
        : {
            ...FALLBACK,
            contextWindow: family === "gpt"
              ? RELAY_GPT_FIRST_TIER_CONTEXT_WINDOW
              : RELAY_CLAUDE_DEFAULT_CONTEXT_WINDOW,
          }),
      id,
      name: id,
    }));
}

// Exact SDK IDs inherit the authoritative capability map. Relay-only aliases
// fall back to documented family behavior; unverified review/spark/fable-like
// aliases remain conservative rather than receiving capabilities by name.
function withKnownCapabilities(model: RelayModelDef): RelayModelDef {
  const capabilities = BUILTIN_CAPABILITIES.get(model.id.toLocaleLowerCase());
  if (capabilities) return withCapabilities(model, capabilities);
  const conservative = /fable|auto-review|spark/.test(model.id);
  return { ...model, reasoning: !conservative, input: conservative ? ["text"] : ["text", "image"] };
}

function withCommonCapabilities(model: RelayModelDef): RelayModelDef {
  const capabilities = BUILTIN_CAPABILITIES.get(model.id.toLocaleLowerCase());
  if (!capabilities) return model;
  return withCapabilities(model, capabilities);
}

function withCapabilities(model: RelayModelDef, capabilities: RelayModelCapabilities): RelayModelDef {
  return {
    ...model,
    reasoning: capabilities.reasoning,
    input: capabilities.input ? [...capabilities.input] : model.input,
    thinkingLevelMap: capabilities.thinkingLevelMap ? { ...capabilities.thinkingLevelMap } : undefined,
  };
}

/** SDK supports per-model api/baseUrl; preserve all families under one key. */
export function resolveMixedRelayModels(ids: string[], base = getRelayBaseUrl()): RelayModelDef[] {
  return [...new Set(ids)].flatMap((id) => {
    // Non-chat endpoints must not be advertised as conversational models.
    if (isRelayImageGenerationModel(id) || /embedding|whisper|tts|sora|rerank/i.test(id)) return [];
    const family = CLAUDE_MATCH.test(id) ? "claude" : GPT_MATCH.test(id) ? "gpt" : "other";
    return resolveRelayModels(family, [id]).map((model) => ({
      ...model,
      contextWindow: clampRelayContextWindow(id, model.contextWindow),
      api: family === "claude" ? "anthropic-messages" : family === "gpt" ? "openai-responses" : "openai-completions",
      baseUrl: family === "claude" ? base : `${base}/v1`,
    }));
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
