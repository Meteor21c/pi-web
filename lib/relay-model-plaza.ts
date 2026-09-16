import { getRelayBaseUrl } from "./relay-config";
import type { RelayModelDef } from "./relay-models";

export interface RelayPricingInterval {
  min_tokens: number;
  max_tokens: number | null;
  tier_label?: string;
}

export interface RelayPlazaModel {
  name: string;
  platform?: string;
  pricing?: {
    billing_mode?: string;
    intervals?: RelayPricingInterval[];
  } | null;
}

export interface RelayPlazaGroup {
  id: string | number;
  name?: string;
  long_context_pricing_enabled?: boolean;
  models: RelayPlazaModel[];
}

export interface RelayModelPlaza {
  groups: RelayPlazaGroup[];
}

type FetchLike = typeof globalThis.fetch;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parseInterval(value: unknown): RelayPricingInterval | undefined {
  if (!isRecord(value)) return undefined;
  const min = finiteNonNegativeInteger(value.min_tokens);
  const max = value.max_tokens === null ? null : finiteNonNegativeInteger(value.max_tokens);
  if (min === undefined || max === undefined || (max !== null && max <= min)) return undefined;
  return {
    min_tokens: min,
    max_tokens: max,
    tier_label: typeof value.tier_label === "string" ? value.tier_label : undefined,
  };
}

/** Parse only the fields MeteorAgent needs; pricing and credentials never reach the browser. */
export function parseRelayModelPlaza(payload: unknown): RelayModelPlaza {
  const outer = isRecord(payload) && isRecord(payload.data) ? payload.data : payload;
  if (!isRecord(outer) || !Array.isArray(outer.groups)) return { groups: [] };
  const groups: RelayPlazaGroup[] = [];
  for (const rawGroup of outer.groups) {
    if (!isRecord(rawGroup) || !["string", "number"].includes(typeof rawGroup.id) || !Array.isArray(rawGroup.models)) continue;
    const models: RelayPlazaModel[] = [];
    for (const rawModel of rawGroup.models) {
      if (!isRecord(rawModel) || typeof rawModel.name !== "string" || !rawModel.name.trim()) continue;
      const pricing = isRecord(rawModel.pricing) ? rawModel.pricing : undefined;
      models.push({
        name: rawModel.name,
        platform: typeof rawModel.platform === "string" ? rawModel.platform : undefined,
        pricing: pricing ? {
          billing_mode: typeof pricing.billing_mode === "string" ? pricing.billing_mode : undefined,
          intervals: Array.isArray(pricing.intervals)
            ? pricing.intervals.flatMap((entry) => {
                const parsed = parseInterval(entry);
                return parsed ? [parsed] : [];
              })
            : [],
        } : null,
      });
    }
    groups.push({
      id: rawGroup.id as string | number,
      name: typeof rawGroup.name === "string" ? rawGroup.name : undefined,
      long_context_pricing_enabled: typeof rawGroup.long_context_pricing_enabled === "boolean"
        ? rawGroup.long_context_pricing_enabled
        : undefined,
      models,
    });
  }
  return { groups };
}

export async function fetchRelayModelPlaza(
  accessToken: string,
  deps: { fetch?: FetchLike; baseUrl?: string } = {},
): Promise<RelayModelPlaza> {
  const baseUrl = (deps.baseUrl ?? getRelayBaseUrl()).replace(/\/+$/, "");
  const response = await (deps.fetch ?? fetch)(`${baseUrl}/api/v1/model-plaza`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Model plaza request failed (HTTP ${response.status})`);
  return parseRelayModelPlaza(await response.json());
}

/** The first interval is inclusive at max_tokens in sub2api: (min, max]. */
export function firstTierContextWindow(
  plaza: RelayModelPlaza | null | undefined,
  groupId: string | number | undefined,
  modelId: string,
): number | undefined {
  if (!plaza || groupId === undefined) return undefined;
  const group = plaza.groups.find((entry) => String(entry.id) === String(groupId));
  if (!group || group.long_context_pricing_enabled === false) return undefined;
  const model = group.models.find((entry) => entry.name.toLocaleLowerCase() === modelId.toLocaleLowerCase());
  if (!model || (model.pricing?.billing_mode && model.pricing.billing_mode !== "token")) return undefined;
  const first = [...(model.pricing?.intervals ?? [])]
    .filter((entry) => entry.max_tokens !== null)
    .sort((a, b) => a.min_tokens - b.min_tokens)[0];
  return first?.max_tokens ?? undefined;
}

export function contextWindowsForModels(
  plaza: RelayModelPlaza | null | undefined,
  groupId: string | number | undefined,
  modelIds: readonly string[],
): Record<string, number> {
  return Object.fromEntries(modelIds.flatMap((modelId) => {
    const limit = firstTierContextWindow(plaza, groupId, modelId);
    return limit === undefined ? [] : [[modelId, limit]];
  }));
}

export function applyPlazaContextWindows(
  models: readonly RelayModelDef[],
  limits: Readonly<Record<string, number>>,
): RelayModelDef[] {
  return models.map((model) => ({
    ...model,
    contextWindow: limits[model.id] ?? model.contextWindow,
  }));
}
