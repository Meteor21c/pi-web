/**
 * 中转站连接探测（从 app/api/relay-config/test/route.ts 迁出）。
 *
 * 迁出原因：Next.js 的 route 模块只允许导出 HTTP handler 与保留字段，
 * 在 route.ts 里 `export` 业务函数（供 save 路由复用）会导致
 * `next build` 的 route 类型校验失败（tsc --noEmit 不覆盖此约束）。
 */
import { getRelayBaseUrl, RELAY_MODELS_ENDPOINT } from "./relay-config";

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

/**
 * Format-only SSRF guard: allow a client-supplied baseUrl override only when it
 * is a syntactically valid http(s) URL (no credential, no path). We do NOT
 * resolve the host — the server fetch to a fixed, operator-controlled relay is
 * the actual trust boundary. Returns null when the override is malformed.
 */
function sanitizeBaseUrlOverride(base?: unknown): string | null {
  if (typeof base !== "string" || !base.trim()) return null;
  const trimmed = base.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    // Syntax validation only (not DNS resolution).
    new URL(trimmed);
  } catch {
    return null;
  }
  return trimmed;
}

/** Probe the relay's /v1/models endpoint with the candidate API key. */
export async function testRelayConnection(
  apiKey: string,
  baseUrlOverride?: string,
): Promise<RelayTestResult> {
  const base = sanitizeBaseUrlOverride(baseUrlOverride) ?? getRelayBaseUrl();
  const url = `${base}${RELAY_MODELS_ENDPOINT}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
      cache: "no-store",
    });

    if (res.status === 200) {
      const json = (await res.json().catch(() => null)) as { data?: Array<{ id?: string }> } | null;
      const ids = (json && Array.isArray(json.data) ? json.data : [])
        .map((m) => String(m.id ?? ""))
        .filter(Boolean);
      let gptCount = 0;
      let claudeCount = 0;
      for (const id of ids) {
        if (GPT_RE.test(id)) gptCount++;
        if (CLAUDE_RE.test(id)) claudeCount++;
      }
      return { ok: true, modelCount: ids.length, gptCount, claudeCount, modelIds: ids };
    }

    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: "invalid-key", message: "API key rejected (401)" };
    }

    return { ok: false, reason: "relay-error", message: `Relay returned ${res.status}` };
  } catch {
    return { ok: false, reason: "network", message: "Network error reaching the relay" };
  }
}
