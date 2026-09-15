import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  clearRelaySessionFile,
  readRelaySessionFile,
  RelayAuthError,
  relayFetchMe,
  relayRefresh,
  writeRelaySessionFile,
} from "@/lib/relay-auth";

export const dynamic = "force-dynamic";

function isRefreshableError(err: unknown): err is RelayAuthError {
  return err instanceof RelayAuthError && (err.status === 401 || err.status === 403);
}

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(request)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });

  try {
    await request.json().catch(() => ({}));
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const session = await readRelaySessionFile();
  if (!session) {
    return NextResponse.json({ ok: false, reason: "unauthenticated" });
  }

  const fetchMe = async (token: string) => relayFetchMe(token);

  try {
    const user = await fetchMe(session.accessToken);
    return NextResponse.json({ ok: true, user });
  } catch (err) {
    // 网络错误：JWT 仍有效期内宽限离线放行（设计文档 §13.4 决策 3）。
    if (err instanceof RelayAuthError && err.kind === "network") {
      return NextResponse.json({
        ok: true,
        user: { email: session.email },
        offlineGrace: true,
      });
    }

    if (isRefreshableError(err) && session.refreshToken) {
      try {
        const refreshed = await relayRefresh(session.refreshToken);
        const now = Date.now();
        await writeRelaySessionFile({
          email: session.email,
          accessToken: refreshed.accessToken,
          accessTokenExpiresAt: now + refreshed.expiresIn * 1000,
          refreshToken: refreshed.refreshToken ?? session.refreshToken,
          updatedAt: now,
        });
        const user = await relayFetchMe(refreshed.accessToken);
        return NextResponse.json({ ok: true, user, refreshed: true });
      } catch {
        await clearRelaySessionFile();
        return NextResponse.json({ ok: false, reason: "session-expired" });
      }
    }

    // 其它认证失败：会话失效。
    await clearRelaySessionFile();
    return NextResponse.json({ ok: false, reason: "session-expired" });
  }
}
