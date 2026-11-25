import { isRelayProviderId } from "./relay-config";
import type { AgentMessage } from "./types";

export interface TurnRelayBilling {
  requestCount: number;
  matchedCount: number;
  matchedCost: number;
  estimatedCost?: number;
}

interface UsageRecord {
  stopReason?: unknown;
  usage?: {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
    cost?: { total?: unknown };
  };
}

export function isAssistantFailureWithoutUsage({ stopReason, usage }: UsageRecord): boolean {
  if (stopReason !== "error" && stopReason !== "aborted") return false;
  return ![usage?.input, usage?.output, usage?.cacheRead, usage?.cacheWrite, usage?.cost?.total]
    .some((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
}

export function summarizeTurnRelayBilling(
  messages: readonly AgentMessage[],
  entryIds: readonly string[],
  start: number,
  end: number,
  costs: Readonly<Record<string, { actualCost: number }>>,
): TurnRelayBilling | undefined {
  let hasRelay = false;
  let requestCount = 0;
  let matchedCount = 0;
  let matchedCost = 0;
  let estimatedCost = 0;
  let estimateComplete = true;

  for (let index = start; index <= end; index++) {
    const message = messages[index];
    if (message.role !== "assistant" || !message.usage || isAssistantFailureWithoutUsage(message)) continue;
    requestCount++;

    const estimate = message.usage.cost?.total;
    if (typeof estimate === "number" && Number.isFinite(estimate) && estimate > 0) estimatedCost += estimate;
    else estimateComplete = false;

    if (!isRelayProviderId(message.provider)) continue;
    hasRelay = true;
    const amount = costs[entryIds[index]]?.actualCost;
    if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0) {
      matchedCount++;
      matchedCost += amount;
    }
  }

  if (!hasRelay) return undefined;
  return { requestCount, matchedCount, matchedCost, estimatedCost: estimateComplete ? estimatedCost : undefined };
}
