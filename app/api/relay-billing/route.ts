import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { isRelayProviderId } from "@/lib/relay-config";
import { queryRelayBilling } from "@/lib/relay-billing";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const providerId = new URL(request.url).searchParams.get("providerId");
  if (!providerId || !isRelayProviderId(providerId)) {
    return NextResponse.json({ error: "A valid relay channel is required." }, { status: 400 });
  }
  const result = await queryRelayBilling(providerId);
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
