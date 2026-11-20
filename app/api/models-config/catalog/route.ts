import { NextResponse } from "next/server";
import {
  recommendModelCatalogPreset,
  searchModelCatalog,
} from "@/lib/model-catalog";

import { loadCatalog, MODELS_DEV_URL } from "@/lib/model-catalog-fetch";
import { builtinModelCapabilities, resolveModelCapabilities } from "@/lib/model-capability-catalog";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const query = (searchParams.get("q") ?? "").slice(0, 120);
  const provider = (searchParams.get("provider") ?? "").slice(0, 120);
  const baseUrl = (searchParams.get("baseUrl") ?? "").slice(0, 500);
  const api = (searchParams.get("api") ?? "").slice(0, 80);
  const parsedLimit = Number.parseInt(searchParams.get("limit") ?? "50", 10);
  const limit = Number.isFinite(parsedLimit) ? parsedLimit : 50;

  try {
    const entries = await loadCatalog();
    const models = searchModelCatalog(entries, query, provider, limit);
    const recommendation = recommendModelCatalogPreset(entries, query, provider, baseUrl);
    const lookup = { id: query, provider, baseUrl, api };
    const builtin = builtinModelCapabilities(lookup);
    if (builtin.reasoning !== undefined || recommendation.preset.reasoning !== undefined) {
      const capabilities = resolveModelCapabilities(lookup, {}, entries);
      recommendation.preset.reasoning = capabilities.reasoning;
      recommendation.preset.thinkingLevelMap = capabilities.thinkingLevelMap;
    }
    if (builtin.input) recommendation.preset.input = builtin.input;
    return NextResponse.json({ models, recommendation, source: MODELS_DEV_URL });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
