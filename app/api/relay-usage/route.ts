import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { queryRelayUsage } from "@/lib/relay-usage";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(request)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });

  try {
    // 无 body 需求，但容忍空 JSON `{}`，需能解析。
    await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    const result = await queryRelayUsage();
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ status: "query-failed", message: "The relay usage query failed." });
  }
}
