import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { buildRelayProviderConfigs } from "@/lib/relay-models";
import { readModelsConfig, writeModelsConfig } from "@/lib/models-config-store";
import { storeProviderCredential } from "@/lib/provider-credential-store";
import { testRelayConnection } from "@/app/api/relay-config/test/route";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeBaseUrlOverride(base?: unknown): string | null {
  if (typeof base !== "string" || !base.trim()) return null;
  const trimmed = base.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    new URL(trimmed);
  } catch {
    return null;
  }
  return trimmed;
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

  const base = sanitizeBaseUrlOverride(
    typeof body.baseUrl === "string" ? body.baseUrl : undefined,
  );

  // 1. Online validation (reuses the test logic).
  const test = await testRelayConnection(apiKey, base ?? undefined);
  if (!test.ok) {
    return NextResponse.json(test);
  }

  try {
    // 2a. Upsert the two relay provider fragments into models.json.
    const config = readModelsConfig();
    const providers = isRecord(config.providers)
      ? { ...config.providers }
      : ({} as Record<string, unknown>);

    Object.assign(providers, buildRelayProviderConfigs());

    // When the client supplied a custom base, override the default env-derived
    // baseUrl values (Responses channel keeps /v1, Claude channel uses root).
    if (base) {
      const gpt = providers["meteor21c"];
      const claude = providers["meteor21c-claude"];
      if (isRecord(gpt)) gpt.baseUrl = `${base}/v1`;
      if (isRecord(claude)) claude.baseUrl = base;
    }

    writeModelsConfig({ ...config, providers });

    // 2b. Persist the credential for both providers.
    await storeProviderCredential("meteor21c", { type: "api_key", key: apiKey });
    await storeProviderCredential("meteor21c-claude", { type: "api_key", key: apiKey });
  } catch (error) {
    return NextResponse.json(
      { ok: false, reason: "save-failed", message: String(error) },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, modelCount: test.modelCount ?? 0 });
}
