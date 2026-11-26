import { ProjectStoreError } from "@/lib/project-store";
import { getRpcSession, hasBusyRpcSessionForProjectChange, type AgentSessionWrapper } from "@/lib/rpc-manager";

/** Validate and release affected wrappers in the same tick as the store update. */
export function projectSessionChangeGuard(busyMessage: string) {
  const idleRuntimes: AgentSessionWrapper[] = [];
  return {
    beforeWrite: (sessionIds: string[]) => {
      for (const sessionId of sessionIds) {
        if (hasBusyRpcSessionForProjectChange(sessionId)) throw new ProjectStoreError(busyMessage, 409);
        const session = getRpcSession(sessionId);
        if (session?.isAlive()) idleRuntimes.push(session);
      }
    },
    afterWrite: () => {
      for (const session of idleRuntimes) session.destroy();
    },
  };
}
