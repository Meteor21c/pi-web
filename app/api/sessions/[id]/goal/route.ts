import { existsSync } from "node:fs";
import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getRpcSession } from "@/lib/rpc-manager";
import { invalidateSessionListCache, resolveSessionPath } from "@/lib/session-reader";
import { parseSessionGoalUpdate, readSessionGoal, SessionGoalError, updateSessionGoal } from "@/lib/session-goal";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function locateSession(id: string) {
  const rpc = getRpcSession(id);
  if (rpc?.isAlive() && rpc.sessionFile) {
    const path = rpc.sessionFile;
    return {
      path,
      persist: existsSync(path) ? undefined : () => {
        if (getRpcSession(id) !== rpc || !rpc.isAlive() || rpc.sessionFile !== path) return;
        rpc.persistUnflushedSession();
        invalidateSessionListCache();
      },
    };
  }
  const path = await resolveSessionPath(id);
  return path && existsSync(path) ? { path } : null;
}

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(_req: Request, { params }: RouteContext) {
  const { id } = await params;
  try {
    const session = await locateSession(id);
    if (!session) return json({ error: "Session not found" }, 404);
    return json({ goal: readSessionGoal(session.path) });
  } catch {
    return json({ error: "Unable to read session goal" }, 500);
  }
}

export async function PUT(req: Request, { params }: RouteContext) {
  if (!isApiRequestAllowed(req)) return json({ error: "Untrusted API request" }, 403);
  if (!hasJsonContentType(req)) return json({ error: "Content-Type must be application/json" }, 415);
  const { id } = await params;
  try {
    const update = parseSessionGoalUpdate(await req.json().catch(() => null));
    const session = await locateSession(id);
    if (!session) return json({ error: "Session not found" }, 404);
    const { goal, conflict } = await updateSessionGoal(session.path, update, session.persist);
    if (conflict) {
      return json({ error: "Session goal has changed", code: "goal_conflict", goal }, 409);
    }
    return json({ goal });
  } catch (error) {
    if (error instanceof SessionGoalError) return json({ error: error.message }, error.status);
    return json({ error: "Unable to save session goal" }, 500);
  }
}
