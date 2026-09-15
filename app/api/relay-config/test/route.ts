import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getRelayBaseUrl, RELAY_MODELS_ENDPOINT } from "@/lib/relay-config";

export const dynamic = "force-dynamic";

const GPT_RE = /gpt|codex/i;
const CLAUDE_RE = /claude/i;

export type RelayTestReason = "invalid-key" | "relay-error" | "network";

export interface RelayTestResult {
  ok: boolean;
  modelCount?: number;
  gptCount?: number;
  claudeCount?: number;
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
      return { ok: true, modelCount: ids.length, gptCount, claudeCount };
    }

    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: "invalid-key", message: "API key rejected (401)" };
    }

    return { ok: false, reason: "relay-error", message: `Relay returned ${res.status}` };
  } catch {
    return { ok: false, reason: "network", message: "Network error reaching the relay" };
  }
}

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let body: { apiKey?: unknown; baseUrl?: unknown };
  try {
    body = (await request.json()) as { apiKey?: unknown; baseUrl?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey) {
    return NextResponse.json({ error: "apiKey is required" }, { status: 400 });
  }

  const result = await testRelayConnection(
    apiKey,
    typeof body.baseUrl === "string" ? body.baseUrl : undefined,
  );
  return NextResponse.json(result);
}
