import { getRelayBaseUrl } from "./relay-config";
import {
  checkRelaySession,
  readRelaySessionFile,
  type RelaySessionFile,
} from "./relay-auth";

export interface RelayAccountUsageStats {
  todayRequests: number;
  todayActualCost: number;
  todayTokens: number;
  totalRequests: number;
  totalActualCost: number;
}

export type RelayAccountUsageResult =
  | { status: "ready"; usage: RelayAccountUsageStats; capturedAt: number }
  | { status: "unavailable" };

export interface RelayAccountUsageDeps {
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  now?: () => number;
  readSession?: (accountId: string) => Promise<RelaySessionFile | null>;
  checkSession?: (accountId: string) => Promise<Record<string, unknown>>;
}

class RelayAccountUsageHttpError extends Error {
  constructor(readonly status: number) {
    super(`Relay account usage returned HTTP ${status}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Parse only the five account-level counters shown by MeteorAgent. */
export function parseRelayAccountUsage(payload: unknown): RelayAccountUsageStats | null {
  const envelope = asRecord(payload);
  const data = asRecord(envelope?.data) ?? envelope;
  if (!data) return null;
  const todayRequests = finiteNonNegative(data.today_requests);
  const todayActualCost = finiteNonNegative(data.today_actual_cost);
  const todayTokens = finiteNonNegative(data.today_tokens);
  const totalRequests = finiteNonNegative(data.total_requests);
  const totalActualCost = finiteNonNegative(data.total_actual_cost);
  if ([todayRequests, todayActualCost, todayTokens, totalRequests, totalActualCost]
    .some((value) => value === undefined)) return null;
  return {
    todayRequests: todayRequests!,
    todayActualCost: todayActualCost!,
    todayTokens: todayTokens!,
    totalRequests: totalRequests!,
    totalActualCost: totalActualCost!,
  };
}

async function fetchAccountUsage(
  accessToken: string,
  deps: RelayAccountUsageDeps,
): Promise<RelayAccountUsageStats> {
  const baseUrl = (deps.baseUrl ?? getRelayBaseUrl()).replace(/\/+$/, "");
  const response = await (deps.fetch ?? globalThis.fetch)(`${baseUrl}/api/v1/usage/dashboard/stats`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new RelayAccountUsageHttpError(response.status);
  const usage = parseRelayAccountUsage(await response.json());
  if (!usage) throw new Error("Invalid relay account usage response");
  return usage;
}

/**
 * Read exact user dashboard totals with the account JWT. A rejected token gets
 * one normal session refresh and retry; every outward result remains token-free.
 */
export async function queryRelayAccountUsage(
  accountId: string,
  deps: RelayAccountUsageDeps = {},
): Promise<RelayAccountUsageResult> {
  const readSession = deps.readSession ?? readRelaySessionFile;
  const checkSession = deps.checkSession ?? checkRelaySession;
  let session = await readSession(accountId);
  if (!session) return { status: "unavailable" };

  try {
    const usage = await fetchAccountUsage(session.accessToken, deps);
    return { status: "ready", usage, capturedAt: deps.now?.() ?? Date.now() };
  } catch (error) {
    if (!(error instanceof RelayAccountUsageHttpError) || ![401, 403].includes(error.status)) {
      return { status: "unavailable" };
    }
  }

  const checked = await checkSession(accountId);
  if (checked.ok !== true) return { status: "unavailable" };
  session = await readSession(accountId);
  if (!session) return { status: "unavailable" };
  try {
    const usage = await fetchAccountUsage(session.accessToken, deps);
    return { status: "ready", usage, capturedAt: deps.now?.() ?? Date.now() };
  } catch {
    return { status: "unavailable" };
  }
}
