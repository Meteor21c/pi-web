import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  RelayAuthError,
  relayLogin,
  finishRelayLogin,
  invalidateRelayOperations,
} from "@/lib/relay-auth";

export const dynamic = "force-dynamic";

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
    const result = await finishRelayLogin(await relayLogin(email, password), epoch);
    return NextResponse.json(result ?? { ok: false, message: "login-cancelled" });
  } catch (err) {
    if (err instanceof RelayAuthError) {
      return NextResponse.json({ ok: false, message: err.kind });
    }
    return NextResponse.json({ ok: false, message: "relay-error" }, { status: 500 });
  }
}
