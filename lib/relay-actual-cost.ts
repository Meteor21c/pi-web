import { getRelayBaseUrl, isRelayProviderId } from "./relay-config";
import { isRelayImageGenerationModel } from "./relay-image-generation";
import type { RelayImageBillingEntry } from "./relay-image-billing";
import {
  checkRelaySession,
  readRelaySessionFile,
  type RelaySessionFile,
} from "./relay-auth";
import { readRelayGroups } from "./relay-group-store";

const USAGE_TIMEZONE = "Asia/Shanghai";
const PAGE_SIZE = 100;
const MAX_PAGES_PER_PROVIDER = 10;
const MATCH_WINDOW_MS = 45_000;
// Image APIs may spend minutes rendering and downloading the final asset. They
// do not return the same token tuple as chat completions, so their fallback
// matcher gets a wider model+time window while still requiring a unique row.
const IMAGE_MATCH_WINDOW_MS = 5 * 60_000;
// Usage rows are timestamped by the relay while the local marker is stamped
// after the image has downloaded.  Include adjacent calendar days so a late
// request around midnight is not excluded before matching starts.
const USAGE_DATE_PADDING_MS = 24 * 60 * 60_000;

export interface RelayTurnUsage {
  entryId: string;
  providerId: string;
  model: string;
  sessionId: string;
  completedAt: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
}

export interface RelayUsageRecord {
  id: number;
  requestId: string;
  model: string;
  sessionId?: string;
  createdAt: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCost: number;
  actualCost: number;
  rateMultiplier?: number;
}

export interface RelayActualCostMatch {
  actualCost: number;
  totalCost: number;
  rateMultiplier?: number;
  matchedBy: "session" | "usage-and-time";
}

export interface RelayActualCostsResult {
  costs: Record<string, RelayActualCostMatch>;
  relayTurnCount: number;
  matchedTurnCount: number;
  estimatedRelayCost: number;
  actualRelayCost: number;
  imageCharges: RelayImageCharge[];
  imageChargeCount: number;
  matchedImageChargeCount: number;
  actualImageCost: number;
  textChargesComplete: boolean;
  imageChargesComplete: boolean;
  complete: boolean;
}

export interface RelayImageCharge {
  entryId: string;
  anchorEntryId: string;
  model: string;
  imageCount: number;
  completedAt: number;
  actualCost?: number;
  totalCost?: number;
  rateMultiplier?: number;
  matchedBy?: "model-and-time";
}

interface ProviderAccess {
  accessToken: string;
  apiKeyId?: string;
  baseUrl: string;
}

export interface RelayActualCostDeps {
  fetch?: typeof globalThis.fetch;
  resolveProviderAccess?: (providerId: string) => Promise<ProviderAccess | null>;
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

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function normalizeModel(value: string): string {
  return value.trim().toLowerCase().split("/").at(-1) ?? "";
}

function shanghaiDate(timestamp: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: USAGE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function parseUsageRecord(value: unknown): RelayUsageRecord | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = nonNegativeInteger(record.id);
  const createdAt = typeof record.created_at === "string" ? Date.parse(record.created_at) : Number.NaN;
  const actualCost = finiteNumber(record.actual_cost);
  const totalCost = finiteNumber(record.total_cost);
  const inputTokens = nonNegativeInteger(record.input_tokens);
  const outputTokens = nonNegativeInteger(record.output_tokens);
  const cacheReadTokens = nonNegativeInteger(record.cache_read_tokens);
  const cacheWriteTokens = nonNegativeInteger(record.cache_creation_tokens);
  if (
    id === undefined
    || !Number.isFinite(createdAt)
    || actualCost === undefined
    || actualCost < 0
    || totalCost === undefined
    || totalCost < 0
    || inputTokens === undefined
    || outputTokens === undefined
    || cacheReadTokens === undefined
    || cacheWriteTokens === undefined
    || typeof record.model !== "string"
  ) return null;

  return {
    id,
    requestId: typeof record.request_id === "string" ? record.request_id : "",
    model: record.model,
    sessionId: typeof record.session_id === "string" && record.session_id.trim()
      ? record.session_id.trim()
      : undefined,
    createdAt,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalCost,
    actualCost,
    rateMultiplier: finiteNumber(record.rate_multiplier),
  };
}

async function providerAccess(providerId: string): Promise<ProviderAccess | null> {
  if (!isRelayProviderId(providerId)) return null;
  const metadata = readRelayGroups().find((entry) => entry.providerId === providerId);
  // Legacy sessions can retain provider ids that a later group sync removed.
  // In that case query the active account without a key filter; the strict
  // session/usage/time matcher below still decides whether a row is usable.
  const accountId = metadata?.accountId;

  let session: RelaySessionFile | null = await readRelaySessionFile(accountId);
  if (session && session.accessTokenExpiresAt <= Date.now()) {
    const checked = await checkRelaySession(accountId);
    if (!checked.ok) return null;
    session = await readRelaySessionFile(accountId);
  }
  if (!session?.accessToken) return null;
  return {
    accessToken: session.accessToken,
    apiKeyId: metadata?.keyId,
    baseUrl: getRelayBaseUrl(),
  };
}

interface UsageTimeRange {
  earliest: number;
  latest: number;
}

async function fetchProviderRecords(
  providerId: string,
  range: UsageTimeRange,
  deps: RelayActualCostDeps,
): Promise<{ records: RelayUsageRecord[]; exhaustive: boolean } | null> {
  const access = await (deps.resolveProviderAccess ?? providerAccess)(providerId);
  if (!access) return null;
  const records: RelayUsageRecord[] = [];
  const doFetch = deps.fetch ?? globalThis.fetch;

  for (let page = 1; page <= MAX_PAGES_PER_PROVIDER; page++) {
    const url = new URL("/api/v1/usage", access.baseUrl.replace(/\/+$/, "") + "/");
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_size", String(PAGE_SIZE));
    url.searchParams.set("sort_by", "created_at");
    url.searchParams.set("sort_order", "desc");
    if (access.apiKeyId) url.searchParams.set("api_key_id", access.apiKeyId);
    url.searchParams.set("start_date", shanghaiDate(range.earliest - USAGE_DATE_PADDING_MS));
    url.searchParams.set("end_date", shanghaiDate(range.latest + USAGE_DATE_PADDING_MS));
    url.searchParams.set("timezone", USAGE_TIMEZONE);

    let response: Response;
    try {
      response = await doFetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${access.accessToken}` },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return null;
    }
    if (!response.ok) return null;

    let payload: Record<string, unknown> | undefined;
    try {
      const envelope = asRecord(await response.json());
      payload = asRecord(envelope?.data) ?? envelope;
    } catch {
      return null;
    }
    if (!payload || !Array.isArray(payload.items)) return null;
    records.push(...payload.items.flatMap((item) => {
      const parsed = parseUsageRecord(item);
      return parsed ? [parsed] : [];
    }));

    const pages = nonNegativeInteger(payload.pages);
    if (payload.items.length < PAGE_SIZE || (pages !== undefined && page >= pages)) {
      return { records, exhaustive: true };
    }
  }
  return { records, exhaustive: false };
}

/** Match a successful image request to the nearest unique upstream image row. */
export function matchRelayImageUsageRecords(
  charges: readonly RelayImageBillingEntry[],
  records: readonly RelayUsageRecord[],
): Record<string, RelayActualCostMatch> {
  const result: Record<string, RelayActualCostMatch> = {};
  const used = new Set<number>();
  const ordered = [...charges].sort((left, right) => left.data.completedAt - right.data.completedAt);
  const sameMomentCounts = new Map<string, number>();
  for (const charge of ordered) {
    const key = `${normalizeModel(charge.data.modelId)}\0${charge.data.completedAt}`;
    sameMomentCounts.set(key, (sameMomentCounts.get(key) ?? 0) + 1);
  }

  for (const charge of ordered) {
    const sameMomentKey = `${normalizeModel(charge.data.modelId)}\0${charge.data.completedAt}`;
    // A tool result has no upstream request id.  Two identical image calls
    // completed at the same millisecond therefore cannot be assigned safely,
    // even when the ledger happens to contain more than one matching row.
    if ((sameMomentCounts.get(sameMomentKey) ?? 0) > 1) continue;
    const candidates = records.flatMap((record, index) => {
      if (used.has(index) || !isRelayImageGenerationModel(record.model)) return [];
      if (normalizeModel(charge.data.modelId) !== normalizeModel(record.model)) return [];
      const distance = Math.abs(record.createdAt - charge.data.completedAt);
      if (distance > IMAGE_MATCH_WINDOW_MS) return [];
      return [{ record, index, distance }];
    }).sort((left, right) => left.distance - right.distance || left.record.id - right.record.id);

    const best = candidates[0];
    if (!best) continue;
    const second = candidates[1];
    // Never guess when two identical image requests are equally close. The
    // next usage refresh can resolve it once a request id is available.
    if (second && second.distance === best.distance) continue;
    used.add(best.index);
    result[charge.entryId] = {
      actualCost: best.record.actualCost,
      totalCost: best.record.totalCost,
      rateMultiplier: best.record.rateMultiplier,
      matchedBy: "usage-and-time",
    };
  }
  return result;
}

function sameUsage(turn: RelayTurnUsage, record: RelayUsageRecord): boolean {
  return normalizeModel(turn.model) === normalizeModel(record.model)
    && turn.inputTokens === record.inputTokens
    && turn.outputTokens === record.outputTokens
    && turn.cacheReadTokens === record.cacheReadTokens
    && turn.cacheWriteTokens === record.cacheWriteTokens;
}

/**
 * Match one stored upstream charge to at most one local assistant response.
 * A persisted session id is authoritative. Older rows without one are accepted
 * only when their model, complete token tuple, and completion time all agree.
 */
export function matchRelayUsageRecords(
  turns: readonly RelayTurnUsage[],
  records: readonly RelayUsageRecord[],
): Record<string, RelayActualCostMatch> {
  const result: Record<string, RelayActualCostMatch> = {};
  const used = new Set<number>();
  const orderedTurns = [...turns].sort((left, right) => left.completedAt - right.completedAt);

  for (const turn of orderedTurns) {
    const candidates = records.flatMap((record, index) => {
      if (used.has(index) || !sameUsage(turn, record)) return [];
      if (record.sessionId && record.sessionId !== turn.sessionId) return [];
      const distance = Math.abs(record.createdAt - turn.completedAt);
      if (distance > MATCH_WINDOW_MS) return [];
      return [{ record, index, distance, sessionRank: record.sessionId === turn.sessionId ? 0 : 1 }];
    }).sort((left, right) => left.sessionRank - right.sessionRank || left.distance - right.distance || left.record.id - right.record.id);

    const best = candidates[0];
    if (!best) continue;
    const second = candidates[1];
    if (second && second.sessionRank === best.sessionRank && second.distance === best.distance) continue;
    used.add(best.index);
    result[turn.entryId] = {
      actualCost: best.record.actualCost,
      totalCost: best.record.totalCost,
      rateMultiplier: best.record.rateMultiplier,
      matchedBy: best.sessionRank === 0 ? "session" : "usage-and-time",
    };
  }
  return result;
}

export async function queryRelayActualCosts(
  turns: readonly RelayTurnUsage[],
  deps: RelayActualCostDeps = {},
  billingEntries: readonly RelayImageBillingEntry[] = [],
): Promise<RelayActualCostsResult> {
  const validTurns = turns.filter((turn) => isRelayProviderId(turn.providerId));
  const validImageCharges = billingEntries.filter((charge) => isRelayProviderId(charge.data.providerId));
  const byProvider = new Map<string, RelayTurnUsage[]>();
  for (const turn of validTurns) {
    const group = byProvider.get(turn.providerId) ?? [];
    group.push(turn);
    byProvider.set(turn.providerId, group);
  }

  const imageByProvider = new Map<string, RelayImageBillingEntry[]>();
  for (const charge of validImageCharges) {
    const group = imageByProvider.get(charge.data.providerId) ?? [];
    group.push(charge);
    imageByProvider.set(charge.data.providerId, group);
  }

  const costs: Record<string, RelayActualCostMatch> = {};
  const imageMatches: Record<string, RelayActualCostMatch> = {};
  let queriesExhaustive = true;
  let imageQueriesExhaustive = true;
  const providerIds = new Set([...byProvider.keys(), ...imageByProvider.keys()]);
  await Promise.all([...providerIds].map(async (providerId) => {
    const providerTurns = byProvider.get(providerId) ?? [];
    const providerImages = imageByProvider.get(providerId) ?? [];
    const timestamps = [
      ...providerTurns.map((turn) => turn.completedAt),
      ...providerImages.map((charge) => charge.data.completedAt),
    ];
    const fetched = await fetchProviderRecords(providerId, {
      earliest: Math.min(...timestamps),
      latest: Math.max(...timestamps),
    }, deps);
    if (!fetched) {
      if (providerTurns.length) queriesExhaustive = false;
      if (providerImages.length) imageQueriesExhaustive = false;
      return;
    }
    if (!fetched.exhaustive) {
      if (providerTurns.length) queriesExhaustive = false;
      if (providerImages.length) imageQueriesExhaustive = false;
    }
    if (providerTurns.length) Object.assign(costs, matchRelayUsageRecords(providerTurns, fetched.records));
    if (providerImages.length) Object.assign(imageMatches, matchRelayImageUsageRecords(providerImages, fetched.records));
  }));

  const actualRelayCost = Object.values(costs).reduce((sum, item) => sum + item.actualCost, 0);
  const estimatedRelayCost = validTurns.reduce((sum, turn) => sum + turn.estimatedCost, 0);
  const matchedTurnCount = Object.keys(costs).length;
  const textChargesComplete = queriesExhaustive && matchedTurnCount === validTurns.length;
  const imageCharges = validImageCharges.map((charge) => {
    const match = imageMatches[charge.entryId];
    return {
      entryId: charge.entryId,
      anchorEntryId: charge.data.anchorEntryId,
      model: charge.data.modelId,
      imageCount: charge.data.imageCount,
      completedAt: charge.data.completedAt,
      ...(match ? {
        actualCost: match.actualCost,
        totalCost: match.totalCost,
        ...(match.rateMultiplier === undefined ? {} : { rateMultiplier: match.rateMultiplier }),
        matchedBy: "model-and-time" as const,
      } : {}),
    } satisfies RelayImageCharge;
  });
  const matchedImageChargeCount = imageCharges.filter((charge) => charge.actualCost !== undefined).length;
  const actualImageCost = imageCharges.reduce((sum, charge) => sum + (charge.actualCost ?? 0), 0);
  const imageChargesComplete = imageQueriesExhaustive && matchedImageChargeCount === validImageCharges.length;
  return {
    costs,
    relayTurnCount: validTurns.length,
    matchedTurnCount,
    estimatedRelayCost,
    actualRelayCost,
    imageCharges,
    imageChargeCount: validImageCharges.length,
    matchedImageChargeCount,
    actualImageCost,
    textChargesComplete,
    imageChargesComplete,
    complete: textChargesComplete && imageChargesComplete,
  };
}
