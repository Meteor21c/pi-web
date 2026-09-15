import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { testRelayConnection } from "@/lib/relay-config-test";
import { persistRelayConfig, sanitizeBaseUrlOverride } from "@/lib/relay-config-save";

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

  // 1. Online validation (reuses the test logic).
  const test = await testRelayConnection(apiKey, base ?? undefined);
  if (!test.ok) {
    return NextResponse.json(test);
  }

  try {
    // 2. Upsert providers into models.json + persist credentials.
    //    用该 key 实际可见的目录，避免写入套餐外的模型。
    await persistRelayConfig(apiKey, base, test.modelIds);
  } catch (error) {
    return NextResponse.json(
      { ok: false, reason: "save-failed", message: String(error) },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, modelCount: test.modelCount ?? 0 });
}
