import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { syncRelayProviders } from "@/lib/relay-keys-sync";

export const dynamic = "force-dynamic";

/**
 * POST /api/relay-config/auto — 密钥同步（每 key 一个 provider，名字/分组与中转站一致）。
 * 响应: { ok, providers?: [{providerId, displayName, family, groupId, modelCount}], totalModelCount?, reason?, message? }
 */
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    await request.json().catch(() => ({}));
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const result = await syncRelayProviders();
  return NextResponse.json(result);
}
