import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  AUTO_ONLY_THINKING_LEVEL_MAP,
  readModelInput,
  type ModelCapabilities,
} from "./model-capabilities";
import { recommendModelCatalogPreset, type ModelCatalogEntry } from "./model-catalog";
import { loadCatalog } from "./model-catalog-fetch";

interface ModelLookup {
  id: string;
  provider?: string;
  baseUrl?: string;
  api?: string;
}

type BuiltinModel = Model<Api>;
const canonicalProviders = new Set(["openai", "openai-codex", "anthropic", "google", "xai", "deepseek"]);
let exactModels: Map<string, BuiltinModel[]> | undefined;

function exactBuiltinModels(id: string): BuiltinModel[] {
  if (!exactModels) {
    exactModels = new Map();
    for (const provider of getBuiltinProviders()) {
      for (const model of getBuiltinModels(provider)) {
        const key = model.id.toLowerCase();
        const matches = exactModels.get(key);
        if (matches) matches.push(model);
        else exactModels.set(key, [model]);
      }
    }
  }
  return exactModels.get(id.trim().toLowerCase()) ?? [];
}

function hostname(url: string | undefined): string | undefined {
  try { return url ? new URL(url).hostname : undefined; } catch { return undefined; }
}

function agreement<T>(values: T[], key: (value: T) => string): T | undefined {
  const counts = new Map<string, number>();
  for (const value of values) {
    const name = key(value);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return values.find((value) => (counts.get(key(value)) ?? 0) / values.length >= 0.6);
}

export function builtinModelCapabilities({ id, provider, baseUrl, api }: ModelLookup): ModelCapabilities {
  const normalizedId = id.trim().toLowerCase() === "claude-fable-5.1" ? "claude-fable-5-1" : id;
  const matches = exactBuiltinModels(normalizedId);
  const direct = matches.find((model) => model.provider === provider)
    ?? matches.find((model) => baseUrl && hostname(model.baseUrl) === hostname(baseUrl))
    ?? matches.find((model) => canonicalProviders.has(model.provider));
  if (direct) return {
    reasoning: direct.reasoning,
    input: readModelInput(direct.input),
    thinkingLevelMap: direct.thinkingLevelMap ? { ...direct.thinkingLevelMap } : {},
  };

  if (id.toLowerCase() === "deepseek-v4-flash-vision-exp") {
    return {
      reasoning: true,
      input: ["text", "image"],
      thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" },
    };
  }

  // This exact relay alias has been shipped since the M0 catalog. The public
  // SDK lists its individual variants rather than the undifferentiated ID.
  if (id.toLowerCase() === "gpt-5.6" && matches.length === 0) {
    return { reasoning: true, input: ["text", "image"], thinkingLevelMap: {} };
  }

  const mapCandidates = matches.filter((model) => (!api || model.api === api) && model.reasoning && model.thinkingLevelMap);
  const map = mapCandidates.length > 1 ? agreement(mapCandidates.map((model) => model.thinkingLevelMap!),
    (value) => JSON.stringify(Object.entries(value).sort())) : undefined;
  return {
    reasoning: agreement(matches.map((model) => model.reasoning), String),
    input: readModelInput(agreement(matches.map((model) => model.input), (value) => [...value].sort().join(","))),
    thinkingLevelMap: map ? { ...map } : undefined,
  };
}

export function modelCapabilitiesNeedCatalog(model: ModelLookup, upstream: ModelCapabilities): boolean {
  const builtin = builtinModelCapabilities(model);
  return (upstream.reasoning ?? builtin.reasoning) === undefined || (upstream.input ?? builtin.input) === undefined;
}

export async function loadOptionalModelCapabilityCatalog(): Promise<readonly ModelCatalogEntry[]> {
  return loadCatalog().catch(() => []);
}

export function resolveModelCapabilities(
  model: ModelLookup,
  upstream: ModelCapabilities = {},
  catalog: readonly ModelCatalogEntry[] = [],
): Required<Pick<ModelCapabilities, "reasoning" | "input">> & Pick<ModelCapabilities, "thinkingLevelMap"> {
  const builtin = builtinModelCapabilities(model);
  const recommended = catalog.length && modelCapabilitiesNeedCatalog(model, upstream)
    ? recommendModelCatalogPreset(catalog, model.id, model.provider, model.baseUrl).preset : undefined;
  const reasoning = upstream.reasoning ?? builtin.reasoning ?? recommended?.reasoning ?? true;
  const input = upstream.input ?? builtin.input ?? readModelInput(recommended?.input) ?? ["text", "image"];
  const preferredMap = upstream.thinkingLevelMap ?? builtin.thinkingLevelMap;
  return {
    reasoning,
    input: [...input],
    ...(reasoning && (!preferredMap || Object.keys(preferredMap).length)
      ? { thinkingLevelMap: { ...(preferredMap ?? AUTO_ONLY_THINKING_LEVEL_MAP) } } : {}),
  };
}
