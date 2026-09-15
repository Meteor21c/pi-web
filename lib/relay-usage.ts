/**
 * meteor21c 中转站用量查询模块。
 *
 * 端点：GET /v1/usage（Bearer sk- key），响应结构见 lib/relay-config.ts 头部注释。
 * 余额/用量金额字段（balance、daily_usage[].cost、model_stats[].cost）均已为 USD，无需换算。
 */

import { getRelayBaseUrl, RELAY_USAGE_ENDPOINT } from "./relay-config";

export interface RelayUsageReport {
  capturedAt: number;
  balanceUsd: number;
  mode: string;
  today: {
    date: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cost: number;
  };
  topModels: Array<{
    model: string;
    requests: number;
    totalTokens: number;
    cost: number;
  }>;
}

export type RelayUsageResult =
  | { status: "ready"; report: RelayUsageReport }
  | { status: "auth-unavailable"; message: string }
  | { status: "query-failed"; message: string };

/** 可注入的依赖，便于在测试中解耦凭证读取与网络请求。 */
export interface RelayUsageDeps {
  /** 读取 meteor21c 的 apiKey；不传则走 pi 凭据体系（ModelRuntime）。 */
  getApiKey?: () => string | undefined | Promise<string | undefined>;
  /** 自定义 fetch 实现；不传则使用 globalThis.fetch。 */
  fetch?: typeof fetch;
}

const RELAY_PROVIDER_ID = "meteor21c";
const QUERY_TIMEOUT_MS = 15_000;

/** 服务器本地日期（YYYY-MM-DD），用于匹配 daily_usage 中的“今天”。 */
function todayLocalDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function stringOrFallback(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

const EMPTY_TODAY = {
  date: "",
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
};

/** 默认凭证读取：复用 provider-usage.ts 的 pi 凭据体系（ModelRuntime.create + getAuth）。 */
async function readApiKeyFromCredentials(): Promise<string | undefined> {
  try {
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const runtime = await ModelRuntime.create({ refreshOnCreate: false });
    const resolved = await runtime.getAuth(RELAY_PROVIDER_ID);
    const apiKey = resolved?.auth?.apiKey;
    if (typeof apiKey === "string" && apiKey.length > 0) return apiKey;
    const authHeader = resolved?.auth?.headers?.["authorization"];
    if (typeof authHeader === "string" && authHeader.length > 0) {
      const bearer = authHeader.match(/^Bearer\s+(.+)$/i);
      return bearer?.[1] ?? authHeader;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function buildReport(payload: Record<string, unknown>, capturedAt: number): RelayUsageReport {
  const balance = numberOrUndefined(payload.balance) ?? numberOrUndefined(payload.remaining) ?? 0;
  const mode = stringOrFallback(payload.mode, "unknown");

  const dailyUsage = Array.isArray(payload.daily_usage) ? payload.daily_usage : [];
  const today = todayLocalDate();
  const todayEntry = dailyUsage
    .map((entry) => (typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : undefined))
    .find((entry) => entry?.date === today);

  let todayReport = EMPTY_TODAY;
  if (todayEntry) {
    todayReport = {
      date: today,
      requests: numberOrUndefined(todayEntry.requests) ?? 0,
      inputTokens: numberOrUndefined(todayEntry.input_tokens) ?? 0,
      outputTokens: numberOrUndefined(todayEntry.output_tokens) ?? 0,
      cacheReadTokens: numberOrUndefined(todayEntry.cache_read_tokens) ?? 0,
      cacheWriteTokens: numberOrUndefined(todayEntry.cache_write_tokens) ?? 0,
      cost: numberOrUndefined(todayEntry.cost) ?? 0,
    };
  }

  const modelStats = Array.isArray(payload.model_stats) ? payload.model_stats : [];
  const topModels = modelStats
    .map((entry) => (typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : undefined))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .map((entry) => ({
      model: stringOrFallback(entry.model, "unknown"),
      requests: numberOrUndefined(entry.requests) ?? 0,
      totalTokens: numberOrUndefined(entry.total_tokens) ?? 0,
      cost: numberOrUndefined(entry.cost) ?? 0,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 5);

  return { capturedAt, balanceUsd: balance, mode, today: todayReport, topModels };
}

export async function queryRelayUsage(deps: RelayUsageDeps = {}): Promise<RelayUsageResult> {
  const apiKey = await (deps.getApiKey ? deps.getApiKey() : readApiKeyFromCredentials());
  if (!apiKey) {
    return {
      status: "auth-unavailable",
      message: "The meteor21c relay API key is not configured or unavailable.",
    };
  }

  const doFetch = deps.fetch ?? globalThis.fetch;
  const url = `${getRelayBaseUrl()}${RELAY_USAGE_ENDPOINT}`;

  let response: Response;
  try {
    response = await doFetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      redirect: "error",
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    });
  } catch {
    return {
      status: "query-failed",
      message: "The relay usage query failed due to a network or proxy error.",
    };
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return {
        status: "query-failed",
        message: "The meteor21c relay API key is invalid or unauthorized.",
      };
    }
    return {
      status: "query-failed",
      message: `The relay usage endpoint returned ${response.status}.`,
    };
  }

  try {
    const parsed: unknown = await response.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { status: "query-failed", message: "The relay usage response was not a JSON object." };
    }
    return { status: "ready", report: buildReport(parsed as Record<string, unknown>, Date.now()) };
  } catch {
    return { status: "query-failed", message: "The relay usage response could not be parsed." };
  }
}
