/**
 * 中转站连接探测（从 app/api/relay-config/test/route.ts 迁出）。
 *
 * 迁出原因：Next.js 的 route 模块只允许导出 HTTP handler 与保留字段，
 * 在 route.ts 里 `export` 业务函数（供 save 路由复用）会导致
 * `next build` 的 route 类型校验失败（tsc --noEmit 不覆盖此约束）。
 */
import { getRelayBaseUrl, RELAY_MODELS_ENDPOINT } from "./relay-config";
import { sanitizeBaseUrlOverride } from "./relay-config-save";

const GPT_RE = /gpt|codex/i;
const CLAUDE_RE = /claude/i;

export type RelayTestReason = "invalid-key" | "relay-error" | "network";

export interface RelayTestResult {
  ok: boolean;
  modelCount?: number;
  gptCount?: number;
  claudeCount?: number;
  /** 该 key 实际可见的模型 id 列表（200 时返回）。 */
  modelIds?: string[];
  reason?: RelayTestReason;
  message?: string;
}

/** Reject malformed catalogs instead of accepting arbitrary HTTP-200 payloads. */
export function parseRelayModelIds(json: unknown): string[] {
  if (!json || typeof json !== "object" || !("data" in json) || !Array.isArray(json.data)) {
    throw new Error("Invalid model catalog");
  }
  if (json.data.some((m: unknown) => !m || typeof m !== "object" || !("id" in m) || typeof m.id !== "string" || !m.id.trim())) {
    throw new Error("Invalid model catalog entry");
  }
  return [...new Set(json.data.map((m: { id: string }) => m.id.trim()))];
}

/** Probe the relay's /v1/models endpoint with the candidate API key. */
export async function testRelayConnection(
  apiKey: string,
  baseUrlOverride?: string,
): Promise<RelayTestResult> {
  const base = sanitizeBaseUrlOverride(baseUrlOverride) ?? getRelayBaseUrl();
  if (baseUrlOverride && !sanitizeBaseUrlOverride(baseUrlOverride)) return { ok: false, reason: "relay-error", message: "Invalid relay root URL" };
  const url = `${base}${RELAY_MODELS_ENDPOINT}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });

    if (res.status === 200) {
      const json = (await res.json().catch(() => null)) as { data?: Array<{ id?: string }> } | null;
      let ids: string[];
      try { ids = parseRelayModelIds(json); } catch { return { ok: false, reason: "relay-error", message: "Invalid model catalog" }; }
      if (!ids.length) return { ok: false, reason: "relay-error", message: "No visible models" };
      let gptCount = 0;
      let claudeCount = 0;
      for (const id of ids) {
        if (GPT_RE.test(id)) gptCount++;
        if (CLAUDE_RE.test(id)) claudeCount++;
      }
      return { ok: true, modelCount: ids.length, gptCount, claudeCount, modelIds: ids };
    }

    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: "invalid-key", message: `API key rejected (${res.status})` };
    }

    return { ok: false, reason: "relay-error", message: `Relay returned ${res.status}` };
  } catch {
    return { ok: false, reason: "network", message: "Network error reaching the relay" };
  }
}
