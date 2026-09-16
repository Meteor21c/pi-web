import { NextResponse } from "next/server";
import { checkRelaySession, clearRelaySessionFile, isRelayAccountId } from "@/lib/relay-auth";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });

  let body: { accountId?: unknown } = {};
  try {
    const raw = await request.text();
    if (raw.trim()) {
      if (!hasJsonContentType(request)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
      body = JSON.parse(raw) as { accountId?: unknown };
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || (body.accountId !== undefined && !isRelayAccountId(body.accountId))) {
    return NextResponse.json({ error: "Invalid accountId" }, { status: 400 });
  }

  await clearRelaySessionFile(body.accountId);
  const nextSession = await checkRelaySession();
  return NextResponse.json({
    ok: true,
    accountId: body.accountId ?? null,
    nextSession,
    syncedKeysRemoved: true,
    manualKeysRetained: true,
  });
}
