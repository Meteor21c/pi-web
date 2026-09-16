import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  RelayAuthError,
  relayFetchMe,
  relayLogin,
  commitRelayLogin,
  invalidateRelayOperations,
  relayAccountIdForEmail,
} from "@/lib/relay-auth";

export const dynamic = "force-dynamic";

function messageForKind(kind: RelayAuthError["kind"]): string {
  switch (kind) {
    case "invalid-credentials":
      return "invalid-credentials";
    case "captcha-required":
      return "captcha-required";
    case "network":
      return "network";
    default:
      return "relay-error";
  }
}

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(request)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });

  let body: { email?: unknown; password?: unknown } | null;
  try {
    body = (await request.json()) as { email?: unknown; password?: unknown };
  } catch {
    return NextResponse.json({ ok: false, message: "relay-error" }, { status: 400 });
  }

  const email = body && typeof body === "object" && typeof body.email === "string" ? body.email.trim() : "";
  const password = body && typeof body === "object" && typeof body.password === "string" ? body.password : "";
  if (!email || !password) {
    return NextResponse.json({ ok: false, message: "invalid-credentials" }, { status: 400 });
  }

  const epoch = invalidateRelayOperations();
  try {
    const login = await relayLogin(email, password);
    const user = login.user ?? await relayFetchMe(login.accessToken);
    const accountId = relayAccountIdForEmail(user.email);
    const now = Date.now();
    const committed = await commitRelayLogin({
      accountId,
      email: user.email,
      accessToken: login.accessToken,
      accessTokenExpiresAt: now + login.expiresIn * 1000,
      refreshToken: login.refreshToken,
      updatedAt: now,
      user,
    }, epoch);
    if (!committed) return NextResponse.json({ ok: false, message: "login-cancelled" });
    return NextResponse.json({ ok: true, accountId, user });
  } catch (err) {
    if (err instanceof RelayAuthError) {
      return NextResponse.json({ ok: false, message: messageForKind(err.kind) });
    }
    return NextResponse.json({ ok: false, message: "relay-error" }, { status: 500 });
  }
}
