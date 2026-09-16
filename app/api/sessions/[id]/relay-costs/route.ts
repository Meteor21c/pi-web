import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { getSessionEntries, resolveSessionPath } from "@/lib/session-reader";
import { isRelayProviderId } from "@/lib/relay-config";
import { queryRelayActualCosts, type RelayTurnUsage } from "@/lib/relay-actual-cost";

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const rpc = getRpcSession(id);
    const live = rpc?.isAlive() ? rpc : undefined;
    const filePath = live?.sessionFile ?? await resolveSessionPath(id);
    if (!live && !filePath) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    const entries = live
      ? live.inner.sessionManager.getEntries()
      : getSessionEntries(filePath!);

    const turns: RelayTurnUsage[] = [];
    for (const entry of entries) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      const message = entry.message as typeof entry.message & {
        provider?: unknown;
        model?: unknown;
        usage?: {
          input?: unknown;
          output?: unknown;
          cacheRead?: unknown;
          cacheWrite?: unknown;
          cost?: { total?: unknown };
        };
      };
      if (typeof message.provider !== "string" || !isRelayProviderId(message.provider)) continue;
      if (typeof message.model !== "string" || !message.usage) continue;
      const completedAt = Date.parse(entry.timestamp);
      const inputTokens = finiteNonNegative(message.usage.input);
      const outputTokens = finiteNonNegative(message.usage.output);
      const cacheReadTokens = finiteNonNegative(message.usage.cacheRead);
      const cacheWriteTokens = finiteNonNegative(message.usage.cacheWrite);
      const estimatedCost = finiteNonNegative(message.usage.cost?.total);
      if (
        !Number.isFinite(completedAt)
        || inputTokens === undefined
        || outputTokens === undefined
        || cacheReadTokens === undefined
        || cacheWriteTokens === undefined
        || estimatedCost === undefined
      ) continue;
      turns.push({
        entryId: entry.id,
        providerId: message.provider,
        model: message.model,
        sessionId: id,
        completedAt,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        estimatedCost,
      });
    }

    const result = await queryRelayActualCosts(turns);
    return NextResponse.json({ status: "ready", ...result }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch {
    // Actual charges are an optional authority overlay. Never expose auth or
    // upstream error details, and never replace the local estimate with zero.
    return NextResponse.json({ status: "unavailable", costs: {}, complete: false }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  }
}
