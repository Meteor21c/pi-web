"use client";

import { useEffect, useState } from "react";
import type { RelayActualCostMatch, RelayActualCostsResult, RelayImageCharge } from "@/lib/relay-actual-cost";

const EMPTY: RelayActualCostsResult = {
  costs: {},
  relayTurnCount: 0,
  matchedTurnCount: 0,
  estimatedRelayCost: 0,
  actualRelayCost: 0,
  imageCharges: [],
  imageChargeCount: 0,
  matchedImageChargeCount: 0,
  actualImageCost: 0,
  textChargesComplete: false,
  imageChargesComplete: true,
  complete: false,
};

function isCostMap(value: unknown): value is Record<string, RelayActualCostMatch> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isImageCharges(value: unknown): value is RelayImageCharge[] {
  return Array.isArray(value) && value.every((item) => (
    Boolean(item && typeof item === "object" && typeof (item as RelayImageCharge).entryId === "string")
  ));
}

export function useRelayActualCosts(
  sessionId: string | undefined,
  revision: string,
  enabled: boolean,
): RelayActualCostsResult {
  const [snapshot, setSnapshot] = useState<{ sessionId: string; result: RelayActualCostsResult }>();

  useEffect(() => {
    if (!sessionId || !enabled) return;

    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const load = async (attempt: number) => {
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/relay-costs`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json() as Partial<RelayActualCostsResult> & { status?: unknown };
        if (controller.signal.aborted || payload.status !== "ready" || !isCostMap(payload.costs)) return;
        const next: RelayActualCostsResult = {
          costs: payload.costs,
          relayTurnCount: finite(payload.relayTurnCount),
          matchedTurnCount: finite(payload.matchedTurnCount),
          estimatedRelayCost: finite(payload.estimatedRelayCost),
          actualRelayCost: finite(payload.actualRelayCost),
          imageCharges: isImageCharges(payload.imageCharges) ? payload.imageCharges : [],
          imageChargeCount: finite(payload.imageChargeCount),
          matchedImageChargeCount: finite(payload.matchedImageChargeCount),
          actualImageCost: finite(payload.actualImageCost),
          textChargesComplete: payload.textChargesComplete === true,
          imageChargesComplete: payload.imageChargesComplete !== false,
          complete: payload.complete === true,
        };
        setSnapshot({ sessionId, result: next });
        // Billing rows can commit a moment after the local assistant entry.
        if (!next.complete && attempt < 2 && !controller.signal.aborted) {
          retryTimer = setTimeout(() => void load(attempt + 1), 1_500 * (attempt + 1));
        }
      } catch {
        // Keep the last successful billing lookup through temporary failures.
      }
    };

    void load(0);
    return () => {
      controller.abort();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [sessionId, revision, enabled]);

  return snapshot && snapshot.sessionId === sessionId ? snapshot.result : EMPTY;
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
