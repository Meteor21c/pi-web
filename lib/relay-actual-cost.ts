import { getRelayBaseUrl, isRelayProviderId } from "./relay-config";
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
  complete: boolean;
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

async function fetchProviderRecords(
  providerId: string,
  turns: RelayTurnUsage[],
  deps: RelayActualCostDeps,
): Promise<{ records: RelayUsageRecord[]; exhaustive: boolean } | null> {
  const access = await (deps.resolveProviderAccess ?? providerAccess)(providerId);
  if (!access || turns.length === 0) return null;
  const earliest = Math.min(...turns.map((turn) => turn.completedAt));
  const latest = Math.max(...turns.map((turn) => turn.completedAt));
  const records: RelayUsageRecord[] = [];
  const doFetch = deps.fetch ?? globalThis.fetch;

  for (let page = 1; page <= MAX_PAGES_PER_PROVIDER; page++) {
    const url = new URL("/api/v1/usage", access.baseUrl.replace(/\/+$/, "") + "/");
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_size", String(PAGE_SIZE));
    url.searchParams.set("sort_by", "created_at");
    url.searchParams.set("sort_order", "desc");
    if (access.apiKeyId) url.searchParams.set("api_key_id", access.apiKeyId);
    url.searchParams.set("start_date", shanghaiDate(earliest));
    url.searchParams.set("end_date", shanghaiDate(latest));
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
): Promise<RelayActualCostsResult> {
  const validTurns = turns.filter((turn) => isRelayProviderId(turn.providerId));
  const byProvider = new Map<string, RelayTurnUsage[]>();
  for (const turn of validTurns) {
    const group = byProvider.get(turn.providerId) ?? [];
    group.push(turn);
    byProvider.set(turn.providerId, group);
  }

  const costs: Record<string, RelayActualCostMatch> = {};
  let queriesExhaustive = true;
  await Promise.all([...byProvider.entries()].map(async ([providerId, providerTurns]) => {
    const fetched = await fetchProviderRecords(providerId, providerTurns, deps);
    if (!fetched) {
      queriesExhaustive = false;
      return;
    }
    if (!fetched.exhaustive) queriesExhaustive = false;
    Object.assign(costs, matchRelayUsageRecords(providerTurns, fetched.records));
  }));

  const actualRelayCost = Object.values(costs).reduce((sum, item) => sum + item.actualCost, 0);
  const estimatedRelayCost = validTurns.reduce((sum, turn) => sum + turn.estimatedCost, 0);
  const matchedTurnCount = Object.keys(costs).length;
  return {
    costs,
    relayTurnCount: validTurns.length,
    matchedTurnCount,
    estimatedRelayCost,
    actualRelayCost,
    complete: queriesExhaustive && matchedTurnCount === validTurns.length,
  };
}
