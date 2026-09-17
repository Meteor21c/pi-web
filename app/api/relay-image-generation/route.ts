import { NextResponse } from "next/server";
import {
  getRelayImageGenerationStatus,
  setDefaultRelayImageModel,
} from "@/lib/relay-image-generation";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getPluginSessionManager } from "@/lib/plugin-session-manager";
import { appendSessionImageModelSelection, readSessionImageModelSelection } from "@/lib/session-image-model-selection";
import { invalidateSessionListCache } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const status = getRelayImageGenerationStatus();
    const sessionId = new URL(request.url).searchParams.get("sessionId")?.trim();
    const sessionManager = sessionId ? await getPluginSessionManager(sessionId) : null;
    const local = sessionManager
      ? readSessionImageModelSelection(sessionManager.getEntries() as never)
      : undefined;
    const effectiveAlias = local?.alias ?? status.defaultAlias;
    return NextResponse.json({
      ok: true,
      ...status,
      defaultAlias: effectiveAlias,
      sessionScoped: Boolean(local),
      models: status.models.map((model) => ({ ...model, isDefault: model.alias === effectiveAlias })),
    }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await request.json() as { providerId?: unknown; modelId?: unknown; sessionId?: unknown };
    if (typeof body.providerId !== "string" || !body.providerId.trim()
      || typeof body.modelId !== "string" || !body.modelId.trim()) {
      return NextResponse.json({ error: "providerId and modelId are required" }, { status: 400 });
    }
    const providerId = body.providerId.trim();
    const modelId = body.modelId.trim();
    if (body.sessionId !== undefined) {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim()) {
        return NextResponse.json({ error: "sessionId must be a non-empty string" }, { status: 400 });
      }
      const sessionManager = await getPluginSessionManager(body.sessionId.trim());
      if (!sessionManager) return NextResponse.json({ error: "Session not found" }, { status: 404 });
      const target = getRelayImageGenerationStatus().models.find((model) => (
        model.providerId === providerId && model.modelId === modelId
      ));
      if (!target) return NextResponse.json({ error: "Image model is not available" }, { status: 404 });
      const selected = appendSessionImageModelSelection(sessionManager, {
        providerId,
        modelId,
        alias: target.alias,
      });
      invalidateSessionListCache();
      return NextResponse.json({ ok: true, selected, sessionScoped: true, reloadRequired: true });
    }
    const selected = setDefaultRelayImageModel(providerId, modelId);
    return NextResponse.json({ ok: true, selected, sessionScoped: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: /not available/i.test(message) ? 404 : 500 });
  }
}
