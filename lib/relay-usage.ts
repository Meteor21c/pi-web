/**
 * meteor21c 中转站用量查询模块。
 *
 * 端点：GET /v1/usage（Bearer sk- key），响应结构见 lib/relay-config.ts 头部注释。
 * 余额/用量金额字段（balance、daily_usage[].cost、model_stats[].cost）均已为 USD，无需换算。
 */

import { getRelayBaseUrl, isRelayProviderId, RELAY_USAGE_ENDPOINT } from "./relay-config";

export interface RelayUsageReport {
  capturedAt: number;
  balanceUsd: number | null;
  unlimited: boolean;
  kind: "wallet" | "quota" | "subscription" | "unknown";
  planName?: string;
  status?: string;
  expiresAt?: string;
  rateLimits: Array<{ window: string; remaining: number | null; resetAt?: string }>;
  todayAvailable: boolean;
  modelStatsAvailable: boolean;
  costBasis: "actual" | "estimated";
  timezone: string;
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
  providerId?: string;
  /** 读取 meteor21c 的 apiKey；不传则走 pi 凭据体系（ModelRuntime）。 */
  getApiKey?: () => string | undefined | Promise<string | undefined>;
  /** 自定义 fetch 实现；不传则使用 globalThis.fetch。 */
  fetch?: typeof fetch;
  now?: () => number;
  baseUrl?: string;
}

const QUERY_TIMEOUT_MS = 15_000;
const USAGE_TIMEZONE = "Asia/Shanghai";

/** 服务器本地日期（YYYY-MM-DD），用于匹配 daily_usage 中的“今天”。 */
function todayLocalDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: USAGE_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const value = (type: string) => parts.find((p) => p.type === type)!.value;
  const y = value("year"), m = value("month"), d = value("day");
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
async function readApiKeyFromCredentials(providerId: string): Promise<string | undefined> {
  try {
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const runtime = await ModelRuntime.create({ refreshOnCreate: false });
    const resolved = await runtime.getAuth(providerId);
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
  const quota = asRecord(payload.quota);
  const subscription = asRecord(payload.subscription);
  const mode = stringOrFallback(payload.mode, "unknown");
  const kind = mode === "quota_limited" ? "quota" : payload.balance !== undefined ? "wallet" : subscription || payload.planName ? "subscription" : "unknown";
  // Quota-limited relays may include both the account wallet balance and the
  // current key/channel allowance. Prefer the latter so the UI cannot show a
  // healthy wallet while the active channel is already exhausted.
  const rawBalance = kind === "quota"
    ? numberOrUndefined(quota?.remaining) ?? numberOrUndefined(payload.remaining) ?? numberOrUndefined(payload.balance)
    : numberOrUndefined(payload.balance) ?? numberOrUndefined(payload.remaining) ?? numberOrUndefined(quota?.remaining);
  const unlimited = kind === "subscription" && rawBalance === -1;
  const balance = rawBalance !== undefined && rawBalance >= 0 ? rawBalance : null;

  const dailyUsage = Array.isArray(payload.daily_usage) ? payload.daily_usage : [];
  const today = todayLocalDate(new Date(capturedAt));
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
      cacheWriteTokens: numberOrUndefined(todayEntry.cache_creation_tokens) ?? numberOrUndefined(todayEntry.cache_write_tokens) ?? 0,
      cost: numberOrUndefined(todayEntry.actual_cost) ?? numberOrUndefined(todayEntry.cost) ?? 0,
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
      cost: numberOrUndefined(entry.actual_cost) ?? numberOrUndefined(entry.cost) ?? 0,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 5);

  const rateLimits = (Array.isArray(payload.rate_limits) ? payload.rate_limits : []).flatMap((raw) => {
    const entry = asRecord(raw);
    return entry && typeof entry.window === "string" ? [{ window: entry.window, remaining: numberOrUndefined(entry.remaining) ?? null, resetAt: typeof entry.reset_at === "string" ? entry.reset_at : undefined }] : [];
  });
  return { capturedAt, balanceUsd: balance, unlimited, kind, mode, today: todayReport, topModels,
    planName: typeof payload.planName === "string" ? payload.planName : undefined,
    status: typeof payload.status === "string" ? payload.status : undefined,
    expiresAt: typeof payload.expires_at === "string" ? payload.expires_at : typeof subscription?.expires_at === "string" ? subscription.expires_at : undefined,
    rateLimits, todayAvailable: Array.isArray(payload.daily_usage), modelStatsAvailable: Array.isArray(payload.model_stats),
    costBasis: todayEntry && numberOrUndefined(todayEntry.actual_cost) !== undefined ? "actual" : "estimated", timezone: USAGE_TIMEZONE,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export async function queryRelayUsage(deps: RelayUsageDeps = {}): Promise<RelayUsageResult> {
  const providerId = deps.providerId ?? "meteor21c";
  if (!isRelayProviderId(providerId)) return { status: "auth-unavailable", message: "Unknown relay channel." };
  const apiKey = await (deps.getApiKey ? deps.getApiKey() : readApiKeyFromCredentials(providerId));
  if (!apiKey) {
    return {
      status: "auth-unavailable",
      message: "The meteor21c relay API key is not configured or unavailable.",
    };
  }

  const doFetch = deps.fetch ?? globalThis.fetch;
  let baseUrl = deps.baseUrl ?? getRelayBaseUrl();
  if (!deps.baseUrl && !deps.getApiKey) {
    const { readModelsConfig } = await import("./models-config-store");
    const providers = asRecord(readModelsConfig().providers);
    const provider = asRecord(providers?.[providerId]);
    if (typeof provider?.baseUrl === "string") baseUrl = provider.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  }
  const url = `${baseUrl.replace(/\/+$/, "")}${RELAY_USAGE_ENDPOINT}?timezone=${encodeURIComponent(USAGE_TIMEZONE)}`;

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
    const payload = parsed as Record<string, unknown>;
    if (payload.isValid === false) return { status: "query-failed", message: "The relay reports this key as invalid." };
    if (!["balance", "remaining", "quota", "subscription", "rate_limits", "mode", "planName"].some((key) => payload[key] !== undefined)) {
      return { status: "query-failed", message: "The relay usage response has no account or quota information." };
    }
    return { status: "ready", report: buildReport(payload, deps.now?.() ?? Date.now()) };
  } catch {
    return { status: "query-failed", message: "The relay usage response could not be parsed." };
  }
}
