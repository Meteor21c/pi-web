import { migrateLegacyProjects } from "@/lib/project-store";
import { getRpcSession, hasBusyRpcSessionForProjectChange } from "@/lib/rpc-manager";
import { isApiRequestAllowed } from "@/lib/request-security";
import { listAllSessions } from "@/lib/session-reader";
import { projectErrorResponse, projectResponse, projectSnapshotResponse } from "../responses";

export async function POST(req: Request): Promise<Response> {
  if (!isApiRequestAllowed(req)) return projectResponse({ error: "Untrusted API request" }, 403);
  try {
    const snapshot = await migrateLegacyProjects(await listAllSessions(), {
      isBusy: hasBusyRpcSessionForProjectChange,
      afterWrite: (sessionIds) => {
        for (const sessionId of sessionIds) getRpcSession(sessionId)?.destroy();
      },
    });
    return projectSnapshotResponse(snapshot);
  } catch (error) {
    return projectErrorResponse(error);
  }
}
