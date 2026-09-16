import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { readRelaySessionFile, relayListKeys } from "@/lib/relay-auth";
import { safeRelayKey } from "@/lib/relay-group-store";

export const dynamic = "force-dynamic";

/** GET /api/relay-auth/keys — 只返回浏览器展示所需的安全元数据，不返回完整 API key。 */
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });

  const session = await readRelaySessionFile();
  if (!session?.accessToken) {
    return NextResponse.json({ ok: false, reason: "unauthenticated" });
  }

  try {
    const keys = await relayListKeys(session.accessToken);
    return NextResponse.json({ ok: true, keys: keys.map(safeRelayKey) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Network error")) {
      return NextResponse.json({ ok: false, reason: "network" });
    }
    return NextResponse.json({ ok: false, reason: "unauthenticated" });
  }
}

// NOTE: 不提供 POST（创建 key）。按产品决策，key 一律由用户在中转站控制台创建，
// 客户端只做拉取与同步（见 components/RelayKeyRefresh.tsx）。
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(request)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  return NextResponse.json({ ok: false, reason: "create-disabled" }, { status: 405 });
}
