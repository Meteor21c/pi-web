import { getRelayBaseUrl, isRelayProviderId } from "./relay-config";
import { readModelsConfig } from "./models-config-store";

export interface RelayBillingReport {
  billing_scope?: string;
  billing_type?: string;
  group_rate_multiplier?: number;
  rate_multiplier?: number;
  resolved_rate_multiplier?: number;
  effective_rate_multiplier?: number;
  observed_at?: string;
  group_name?: string;
  platform?: string;
  long_context_pricing_enabled?: boolean;
}

export type RelayBillingResult =
  | { status: "ready"; billing: RelayBillingReport; capturedAt: number }
  | { status: "unavailable" };

export interface RelayBillingDeps {
  getApiKey?: () => string | undefined | Promise<string | undefined>;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  now?: () => number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

async function apiKeyFor(providerId: string): Promise<string | undefined> {
  try {
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const runtime = await ModelRuntime.create({ refreshOnCreate: false });
    const resolved = await runtime.getAuth(providerId);
    const apiKey = resolved?.auth?.apiKey;
    if (typeof apiKey === "string" && apiKey) return apiKey;
    const authorization = resolved?.auth?.headers?.authorization;
    if (typeof authorization !== "string" || !authorization) return undefined;
    return authorization.match(/^Bearer\s+(.+)$/i)?.[1] ?? authorization;
  } catch {
    return undefined;
  }
}

function baseUrlFor(providerId: string): string {
  const providers = asRecord(readModelsConfig().providers);
  const provider = asRecord(providers?.[providerId]);
  if (typeof provider?.baseUrl !== "string") return getRelayBaseUrl();
  return provider.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export async function queryRelayBilling(
  providerId: string,
  deps: RelayBillingDeps = {},
): Promise<RelayBillingResult> {
  if (!isRelayProviderId(providerId)) return { status: "unavailable" };
  const apiKey = await (deps.getApiKey ? deps.getApiKey() : apiKeyFor(providerId));
  if (!apiKey) return { status: "unavailable" };

  const baseUrl = (deps.baseUrl ?? baseUrlFor(providerId)).replace(/\/+$/, "");
  let response: Response;
  try {
    response = await (deps.fetch ?? globalThis.fetch)(`${baseUrl}/v1/sub2api/billing`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { status: "unavailable" };
  }
  if (!response.ok) return { status: "unavailable" };

  try {
    const raw: unknown = await response.json();
    const envelope = asRecord(raw);
    const payload = asRecord(envelope?.data) ?? envelope;
    if (!payload) return { status: "unavailable" };
    const billing: RelayBillingReport = {
      billing_scope: typeof payload.billing_scope === "string" ? payload.billing_scope : undefined,
      billing_type: typeof payload.billing_type === "string" ? payload.billing_type : undefined,
      group_rate_multiplier: finiteNumber(payload.group_rate_multiplier),
      rate_multiplier: finiteNumber(payload.rate_multiplier),
      resolved_rate_multiplier: finiteNumber(payload.resolved_rate_multiplier),
      effective_rate_multiplier: finiteNumber(payload.effective_rate_multiplier),
      observed_at: typeof payload.observed_at === "string" ? payload.observed_at : undefined,
      group_name: typeof payload.group_name === "string" ? payload.group_name : undefined,
      platform: typeof payload.platform === "string" ? payload.platform : undefined,
      long_context_pricing_enabled: typeof payload.long_context_pricing_enabled === "boolean"
        ? payload.long_context_pricing_enabled
        : undefined,
    };
    if (Object.values(billing).every((value) => value === undefined)) return { status: "unavailable" };
    return { status: "ready", billing, capturedAt: deps.now?.() ?? Date.now() };
  } catch {
    return { status: "unavailable" };
  }
}
