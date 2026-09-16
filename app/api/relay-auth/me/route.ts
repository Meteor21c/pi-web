import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  checkRelaySession,
  isRelayAccountId,
} from "@/lib/relay-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(request)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });

  let body: { accountId?: unknown };
  try {
    const raw = await request.text();
    body = raw.trim() ? JSON.parse(raw) as { accountId?: unknown } : {};
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body) || (body.accountId !== undefined && !isRelayAccountId(body.accountId))) {
    return NextResponse.json({ error: "Invalid accountId" }, { status: 400 });
  }
  return NextResponse.json(await checkRelaySession(body.accountId));
}
