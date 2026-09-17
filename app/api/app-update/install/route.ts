import { NextResponse } from "next/server";
import { getAppUpdateInstallStatus, startAutomaticAppUpdate } from "@/lib/app-update-manager";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  return NextResponse.json(getAppUpdateInstallStatus(), {
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
    const body = await request.json() as { version?: unknown };
    if (typeof body.version !== "string" || !body.version.trim()) {
      return NextResponse.json({ error: "version is required" }, { status: 400 });
    }
    return NextResponse.json(startAutomaticAppUpdate(body.version.trim()), { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, {
      status: /任务正在运行/.test(message) ? 409 : /不支持|不是可安装/.test(message) ? 400 : 500,
    });
  }
}
