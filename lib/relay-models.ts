/**
 * meteor21c relay — 内置模型元数据表与 models.json provider 片段构建。
 *
 * 背景：中转站 /v1/models 只返回模型 id，不含 contextWindow / maxTokens / 价格。
 * pi 对缺失字段按保守默认（128K 上下文）处理，会造成长会话中途截断，
 * 因此这里内置 M0 实测收集的双分组模型目录（GPT 10 + Claude 12）。
 * 价格为估算值（USD / 百万 tokens），仅影响本地成本显示，可按站内定价校准。
 *
 * 目录来源：M0 实测（2026-09-15），见 A3 方案设计文档 §10。
 */

import { getRelayBaseUrl, getRelayResponsesBaseUrl } from "./relay-config";

export interface RelayModelDef {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
}

const GPT_FAMILY = { contextWindow: 400_000, maxTokens: 128_000, cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 } } as const;
const GPT_CODEX_FAMILY = { contextWindow: 272_000, maxTokens: 100_000, cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 } } as const;
const GPT_MINI_FAMILY = { contextWindow: 400_000, maxTokens: 128_000, cost: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 } } as const;
const GPT_FLAGSHIP_FAMILY = { contextWindow: 400_000, maxTokens: 128_000, cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 } } as const;
const OPUS_FAMILY = { contextWindow: 200_000, maxTokens: 64_000, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } } as const;
const SONNET_FAMILY = { contextWindow: 200_000, maxTokens: 64_000, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } } as const;
const HAIKU_FAMILY = { contextWindow: 200_000, maxTokens: 64_000, cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } } as const;

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

/** Claude 分组（M0 实测目录；fable 家族参数未公开，按 sonnet 档估） */
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
  { id: "claude-fable-5", ...SONNET_FAMILY },
  { id: "claude-fable-5.1", ...SONNET_FAMILY },
];

const FAMILY_MATCH: Record<"gpt" | "claude", RegExp> = {
  gpt: /gpt|codex/i,
  claude: /claude/i,
};

const TABLE_BY_FAMILY: Record<"gpt" | "claude", Map<string, RelayModelDef>> = {
  gpt: new Map(GPT_MODELS.map((x) => [x.id, x])),
  claude: new Map(CLAUDE_MODELS.map((x) => [x.id, x])),
};

const FALLBACK: RelayModelDef = {
  id: "",
  reasoning: true,
  input: ["text"],
  contextWindow: 200_000,
  maxTokens: 64_000,
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

/**
 * 用内置元数据补全远端 /v1/models 返回的模型 id 列表。
 * 未传远端列表时返回内置表（作为离线兜底）。
 */
export function resolveRelayModels(family: "gpt" | "claude", remoteIds?: string[]): RelayModelDef[] {
  const table = TABLE_BY_FAMILY[family];
  const match = FAMILY_MATCH[family];
  if (!remoteIds || remoteIds.length === 0) {
    return [...table.values()];
  }
  return remoteIds
    .filter((id) => match.test(id))
    .map((id) => ({ ...(table.get(id) ?? FALLBACK), id, name: id }));
}

/**
 * 构建写入 models.json 的双 provider 片段（providers 对象的两个键值）。
 * remoteIds 为 onboarding 时在线拉取的 /v1/models 目录（按 key 分组返回）。
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
  };
}
