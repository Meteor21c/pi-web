import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { testRelayConnection } from "@/lib/relay-config-test";
import { persistRelayProvider, dominantFamily, protocolFor, sanitizeBaseUrlOverride } from "@/lib/relay-config-save";
import { resolveMixedRelayModels } from "@/lib/relay-models";

export const dynamic = "force-dynamic";

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
  if (body.baseUrl && !base) return NextResponse.json({ ok: false, reason: "relay-error", message: "Invalid relay root URL" }, { status: 400 });

  // 1. Online validation (reuses the test logic).
  const test = await testRelayConnection(apiKey, base ?? undefined);
  if (!test.ok) {
    return NextResponse.json(test);
  }

  let savedModelCount = 0;
  try {
    // 2. One key/provider, with each model using its own protocol and URL.
    const family = dominantFamily(test.modelIds ?? []);
    const { api, baseUrl } = protocolFor(family, base ?? undefined);
    const models = resolveMixedRelayModels(test.modelIds ?? [], base ?? undefined);
    if (!models.length) return NextResponse.json({ ok: false, reason: "relay-error", message: "No chat models available" });
    await persistRelayProvider({
      providerId: "meteor21c",
      displayName: "MeteorAgent",
      apiKey,
      api,
      baseUrl,
      models,
    });
    savedModelCount = models.length;
  } catch (error) {
    return NextResponse.json(
      { ok: false, reason: "save-failed", message: String(error) },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, modelCount: savedModelCount });
}
