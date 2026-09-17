import { NextResponse } from "next/server";
import {
  getAppRestartStatus,
  startLocalServiceRestart,
} from "@/lib/app-restart-manager";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  return NextResponse.json(getAppRestartStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    // The body is intentionally ignored. Restart targets are derived only
    // from the current process environment so a browser cannot supply PIDs or
    // paths to the detached helper; avoiding a body read also keeps this
    // control endpoint cheap when a client sends an accidental payload.
    return NextResponse.json(startLocalServiceRestart(), { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message, ...getAppRestartStatus() }, {
      status: /任务正在运行/.test(message) ? 409 : /不支持|缺失|缺少/.test(message) ? 400 : 500,
    });
  }
}
