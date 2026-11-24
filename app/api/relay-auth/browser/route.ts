import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  finishRelayLogin,
  RelayAuthError,
  relayOperationEpoch,
  relayPollBrowserLogin,
  relayStartBrowserLogin,
} from "@/lib/relay-auth";

export const dynamic = "force-dynamic";

type Reply = Record<string, unknown>;
type PendingLogin = {
  id: string;
  epoch: number;
  expiresAt: number;
  relay: Awaited<ReturnType<typeof relayStartBrowserLogin>>;
  nextPollAt: number;
  inFlight?: Promise<Reply>;
};
const globals = globalThis as typeof globalThis & { __meteorBrowserLogin?: { sequence: number; pending?: PendingLogin } };
const state = globals.__meteorBrowserLogin ??= { sequence: 0 };

function reply(body: Reply, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function poll(pending: PendingLogin): Promise<Reply> {
  const result = await relayPollBrowserLogin(pending.relay.requestId, pending.relay.deviceCode);
  if (state.pending !== pending || pending.epoch !== relayOperationEpoch()) return { status: "cancelled" };
  if (result.status === "pending") return result;
  if (result.status !== "authenticated") {
    state.pending = undefined;
    return result;
  }
  const login = await finishRelayLogin(result.login, pending.epoch,
    () => state.pending === pending && pending.expiresAt > Date.now());
  if (state.pending === pending) state.pending = undefined;
  return login ? { status: "authenticated", ...login } : { status: "cancelled" };
}

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return reply({ error: "Untrusted API request" }, 403);
  if (!hasJsonContentType(request)) return reply({ error: "Content-Type must be application/json" }, 415);
  const body = await request.json().catch(() => null);
  try {
    if (body?.action === "start") {
      const epoch = relayOperationEpoch();
      const sequence = ++state.sequence;
      state.pending = undefined;
      const relay = await relayStartBrowserLogin();
      if (sequence !== state.sequence || epoch !== relayOperationEpoch()) return reply({ status: "cancelled" });
      const id = randomUUID();
      state.pending = { id, epoch, relay, expiresAt: Date.now() + relay.expiresIn * 1000, nextPollAt: 0 };
      return reply({ status: "started", id, userCode: relay.userCode, verificationUrl: relay.verificationUrl,
        expiresIn: relay.expiresIn, interval: relay.interval });
    }
    if (body?.action !== "poll" && body?.action !== "cancel") return reply({ error: "Invalid login action" }, 400);
    const pending = state.pending;
    if (!pending || pending.id !== body.id) return reply({ status: "expired" });
    if (pending.epoch !== relayOperationEpoch() || pending.expiresAt <= Date.now() || body.action === "cancel") {
      state.pending = undefined;
      return reply({ status: body.action === "poll" ? "expired" : "cancelled" });
    }
    if (pending.inFlight) return reply(await pending.inFlight);
    if (pending.nextPollAt > Date.now()) return reply({ status: "pending" });
    pending.nextPollAt = Date.now() + pending.relay.interval * 1000;
    pending.inFlight = poll(pending).finally(() => { pending.inFlight = undefined; });
    return reply(await pending.inFlight);
  } catch (error) {
    if (error instanceof RelayAuthError && error.status === 404 && body?.action === "start") {
      return reply({ status: "unavailable" });
    }
    if (error instanceof RelayAuthError && error.kind === "rate-limited" && body?.action === "poll") {
      const pending = state.pending;
      if (pending && pending.id === body.id) pending.nextPollAt = Date.now() + 10_000;
      return reply({ status: "pending" });
    }
    return reply({ status: "error", message: error instanceof RelayAuthError ? error.kind : "relay-error" }, 502);
  }
}
