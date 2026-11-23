import { NextResponse } from "next/server";
import { readModelsConfig, modelsConfigForEditor, modelsConfigRevision, writeModelsConfigIfCurrent } from "@/lib/models-config-store";
import { capabilityRecord, readModelInput, readModelThinkingLevelMap } from "@/lib/model-capabilities";
import { loadOptionalModelCapabilityCatalog, modelCapabilitiesNeedCatalog, resolveModelCapabilities } from "@/lib/model-capability-catalog";
import { isRelayProviderId } from "@/lib/relay-config";

export const dynamic = "force-dynamic";

export async function GET() {
  const config = readModelsConfig();
  return NextResponse.json(modelsConfigForEditor(config), { headers: { ETag: modelsConfigRevision(config), "Cache-Control": "no-store" } });
}

/** Apply defaults to newly created custom entries, preserving explicit edits. */
async function fillNewModelCapabilities(body: Record<string, unknown>, previous: Record<string, unknown>) {
  const providers = capabilityRecord(body.providers);
  const previousProviders = capabilityRecord(previous.providers);
  const missing = Object.entries(providers ?? {}).flatMap(([provider, value]) => {
    const config = capabilityRecord(value);
    if (!config || !Array.isArray(config.models) || isRelayProviderId(provider)) return [];
    const saved = capabilityRecord(previousProviders?.[provider])?.models;
    const savedIds = new Set(Array.isArray(saved) ? saved.map((model) => capabilityRecord(model)?.id) : []);
    return config.models.flatMap((value) => {
      const model = capabilityRecord(value);
      if (!model || typeof model.id !== "string" || !model.id.trim() || savedIds.has(model.id)) return [];
      const upstream = {
        reasoning: typeof model.reasoning === "boolean" ? model.reasoning : undefined,
        input: readModelInput(model.input),
        thinkingLevelMap: readModelThinkingLevelMap(model.thinkingLevelMap),
      };
      const lookup = {
        id: model.id,
        provider,
        baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : typeof config.baseUrl === "string" ? config.baseUrl : undefined,
        api: typeof model.api === "string" ? model.api : typeof config.api === "string" ? config.api : undefined,
      };
      return [{ model, upstream, lookup }];
    });
  });
  const catalog = missing.some(({ lookup, upstream }) => modelCapabilitiesNeedCatalog(lookup, upstream))
    ? await loadOptionalModelCapabilityCatalog() : [];
  for (const { model, upstream, lookup } of missing) {
    Object.assign(model, resolveModelCapabilities(lookup, upstream, catalog));
  }
}

const conflict = () => NextResponse.json({ error: "Configuration changed. Reload before saving.", code: "conflict" }, { status: 409 });

export async function PUT(req: Request) {
  try {
    const body = await req.json() as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid configuration" }, { status: 400 });
    }
    const revision = req.headers.get("if-match");
    if (!revision) return NextResponse.json({ error: "Reload configuration before saving." }, { status: 428 });
    const previous = readModelsConfig();
    if (modelsConfigRevision(previous) !== revision) return conflict();
    await fillNewModelCapabilities(body, previous);
    const next = writeModelsConfigIfCurrent(body, revision);
    if (!next) return conflict();
    return NextResponse.json({ success: true, config: modelsConfigForEditor(readModelsConfig()) }, { headers: { ETag: next } });
  } catch {
    return NextResponse.json({ error: "Unable to save configuration." }, { status: 500 });
  }
}
