/**
 * meteor21c relay 模块 — 全局契约（provider id / 端点 / baseUrl 规则）
 *
 * 依据（2026-09-15 M0/M1 实测 + pi-ai 源码级确认）：
 * - openai-responses:  OpenAI SDK, baseURL 需带 /v1 → `${base}/v1`，SDK 拼 /responses
 * - anthropic-messages: Anthropic SDK, baseURL 用根域名，SDK 自拼 /v1/messages
 * - 余额/用量: GET /v1/usage（Bearer sk- key），双分组响应同构
 */

export const DEFAULT_RELAY_BASE_URL = "https://api.meteor21c.fun";
export const API_KEY_ENV = "METEOR21C_API_KEY";
export const RELAY_MODELS_ENDPOINT = "/v1/models";
export const RELAY_USAGE_ENDPOINT = "/v1/usage";

/** relay 系 provider 判定（固定 id + 每 key 的 meteor21c-k<keyId> 形式）。 */
export function isRelayProviderId(id: string): boolean {
  return id === "meteor21c" || /^meteor21c-(a[a-zA-Z0-9_-]+-k[a-zA-Z0-9_-]+|k(?:-k)?[a-zA-Z0-9_-]+|claude|openai)$/.test(id);
}

/** 中转站根域名（无尾斜杠）。METEOR21C_BASE_URL 可覆盖默认值。 */
export function getRelayBaseUrl(): string {
  return (process.env.METEOR21C_BASE_URL ?? DEFAULT_RELAY_BASE_URL).replace(/\/+$/, "");
}

/** OpenAI Responses 通道 baseUrl（带 /v1，OpenAI SDK 拼 /responses）。 */
export function getRelayResponsesBaseUrl(base = getRelayBaseUrl()): string {
  return `${base}/v1`;
}
