import { NextResponse } from "next/server";
import { readModelsConfig, modelsConfigRevision, writeModelsConfigIfCurrent } from "@/lib/models-config-store";

export const dynamic = "force-dynamic";

export async function GET() {
  const config = readModelsConfig();
  return NextResponse.json(config, { headers: { ETag: modelsConfigRevision(config), "Cache-Control": "no-store" } });
}

export async function PUT(req: Request) {
  try {
    const body = await req.json() as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid configuration" }, { status: 400 });
    }
    const revision = req.headers.get("if-match");
    if (!revision) return NextResponse.json({ error: "Reload configuration before saving." }, { status: 428 });
    const next = writeModelsConfigIfCurrent(body, revision);
    if (!next) return NextResponse.json({ error: "Configuration changed. Reload before saving.", code: "conflict" }, { status: 409 });
    return NextResponse.json({ success: true }, { headers: { ETag: next } });
  } catch {
    return NextResponse.json({ error: "Unable to save configuration." }, { status: 500 });
  }
}
