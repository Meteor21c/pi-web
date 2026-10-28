import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { readPromptPresetSettings, updatePromptPresetSettings } from "@/lib/prompt-preset-store";
import { PromptPresetValidationError } from "@/lib/prompt-presets";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  try {
    return NextResponse.json(readPromptPresetSettings(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const text = await req.text();
    if (text.length > 400_000) return NextResponse.json({ error: "Prompt settings are too large" }, { status: 413 });
    return NextResponse.json(updatePromptPresetSettings(JSON.parse(text)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, {
      status: error instanceof PromptPresetValidationError || error instanceof SyntaxError ? 400 : 500,
    });
  }
}
