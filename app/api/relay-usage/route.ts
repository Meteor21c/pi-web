import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { queryRelayUsage } from "@/lib/relay-usage";
import { isRelayProviderId } from "@/lib/relay-config";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(request)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });

  let providerId: string;
  try {
    // 无 body 需求，但容忍空 JSON `{}`，需能解析。
    const body = await request.json();
    providerId = body?.providerId;
    if (typeof providerId !== "string" || !isRelayProviderId(providerId)) {
      return NextResponse.json({ error: "A valid relay channel is required." }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    const result = await queryRelayUsage({ providerId });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ status: "query-failed", message: "The relay usage query failed." });
  }
}
