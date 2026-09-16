import { NextRequest, NextResponse } from "next/server";
import { getCommunityPluginCatalog } from "@/lib/plugin-catalog-fetch";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const forceRefresh = request.nextUrl.searchParams.get("refresh") === "1";
    const query = (request.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 120);
    const response = NextResponse.json(await getCommunityPluginCatalog(forceRefresh, query));
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
