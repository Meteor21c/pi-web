import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { isRelayAccountId } from "@/lib/relay-auth";
import { queryRelayAccountUsage } from "@/lib/relay-account-usage";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const accountId = new URL(request.url).searchParams.get("accountId");
  if (!accountId || !isRelayAccountId(accountId)) {
    return NextResponse.json({ error: "A valid relay account is required." }, { status: 400 });
  }
  const result = await queryRelayAccountUsage(accountId);
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
