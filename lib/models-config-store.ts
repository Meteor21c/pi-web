import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { invalidateModelsCache } from "./models-cache";
import { relayAuthorizedModelIdsByProvider } from "./relay-group-store";

const MODEL_COST_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeModelCost(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const providedKeys = MODEL_COST_KEYS.filter((key) => value[key] !== undefined);
  if (providedKeys.length === 0) return undefined;
  if (providedKeys.some((key) => (
    typeof value[key] !== "number" || !Number.isFinite(value[key])
  ))) return undefined;

  return Object.fromEntries([
    ...Object.entries(value),
    ...MODEL_COST_KEYS.map((key) => [key, value[key] ?? 0]),
  ]);
}

/** Complete partial cost groups with zero; omit a cost group only when it is empty. */
export function normalizeModelsConfigCosts(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = structuredClone(data);
  if (!isRecord(normalized.providers)) return normalized;

  for (const provider of Object.values(normalized.providers)) {
    if (!isRecord(provider) || !Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (!isRecord(model) || !("cost" in model)) continue;
      const cost = normalizeModelCost(model.cost);
      if (cost) model.cost = cost;
      else delete model.cost;
    }
  }
  return normalized;
}

function sanitizeModelsConfig(data: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(data.providers)) return data;

  const providers = Object.fromEntries(Object.entries(data.providers).map(([providerId, provider]) => {
    if (!isRecord(provider) || !Array.isArray(provider.models)) return [providerId, provider];
    const models = provider.models.filter((model) => (
      !isRecord(model) || typeof model.id !== "string" || model.id.trim().length > 0
    ));
    return [providerId, { ...provider, models }];
  }));

  return { ...data, providers };
}

/**
 * Account-synced relay providers are authoritative: only model ids returned by
 * that API key's authenticated /v1/models snapshot may remain in models.json.
 * Providers without an index entry are ordinary user-managed providers and are
 * deliberately left untouched. A legacy indexed provider with no modelIds
 * snapshot is fail-closed and must be synchronized before it can be used.
 */
export function filterRelayAuthorizedModels(
  data: Record<string, unknown>,
  modelsPath = getModelsConfigPath(),
): Record<string, unknown> {
  if (modelsPath !== getModelsConfigPath()) return data;
  const authorized = relayAuthorizedModelIdsByProvider();
  if (authorized.size === 0 || !isRecord(data.providers)) return data;

  const providers = Object.fromEntries(Object.entries(data.providers).map(([providerId, provider]) => {
    const allowed = authorized.get(providerId);
    if (!allowed) return [providerId, provider];
    if (!isRecord(provider)) return [providerId, provider];
    const models = Array.isArray(provider.models)
      ? provider.models.filter((model) => isRecord(model) && typeof model.id === "string" && allowed.has(model.id))
      : [];
    return [providerId, { ...provider, models }];
  }));
  return { ...data, providers };
}

export function getModelsConfigPath(): string {
  return join(getAgentDir(), "models.json");
}

/** Opaque revision for HTTP optimistic concurrency; never exposes credentials. */
export function modelsConfigRevision(config: Record<string, unknown>): string {
  return `"${createHash("sha256").update(JSON.stringify(config)).digest("hex")}"`;
}

export function writeModelsConfigIfCurrent(
  data: Record<string, unknown>, revision: string,
  modelsPath = getModelsConfigPath(),
): string | null {
  // Synchronous check + write: no async boundary for other requests in this process.
  if (modelsConfigRevision(readModelsConfig(modelsPath)) !== revision) return null;
  writeModelsConfig(data, modelsPath);
  return modelsConfigRevision(readModelsConfig(modelsPath));
}

export function readModelsConfig(
  modelsPath = getModelsConfigPath(),
): Record<string, unknown> {
  if (!existsSync(modelsPath)) return { providers: {} };
  try {
    const parsed = JSON.parse(readFileSync(modelsPath, "utf8")) as Record<string, unknown>;
    return filterRelayAuthorizedModels(parsed, modelsPath);
  } catch {
    return { providers: {} };
  }
}

export function writeModelsConfig(
  data: Record<string, unknown>,
  modelsPath = getModelsConfigPath(),
): void {
  const dir = dirname(modelsPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const normalized = filterRelayAuthorizedModels(
    normalizeModelsConfigCosts(sanitizeModelsConfig(data)),
    modelsPath,
  );
  writePrivateFileAtomicSync(modelsPath, JSON.stringify(normalized, null, 2));
  invalidateModelsCache();
}
