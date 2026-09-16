import { SessionManager } from "@earendil-works/pi-coding-agent";
import { existsSync } from "fs";
import { getRpcSession } from "./rpc-manager";
import { resolveSessionPath } from "./session-reader";

export type PluginSessionManager = Pick<
  SessionManager,
  "getEntries" | "appendCustomEntry" | "getCwd" | "getSessionId"
>;

/** Resolve a live or persisted session for plugin-selection updates. */
export async function getPluginSessionManager(sessionId: string): Promise<PluginSessionManager | null> {
  const live = getRpcSession(sessionId);
  if (live?.isAlive()) return live.inner.sessionManager;
  const sessionFile = await resolveSessionPath(sessionId);
  if (!sessionFile) return null;
  // A transient session can be present in the path cache before its first
  // flush. Without this guard SessionManager.open() would create a new session
  // with a different id at the missing path and make the caller's id check
  // misleading.
  if (!existsSync(sessionFile)) return null;
  return SessionManager.open(sessionFile, undefined);
}
