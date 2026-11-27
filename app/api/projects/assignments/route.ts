import { ProjectStoreError, setSessionProjects } from "@/lib/project-store";
import { getRpcSession } from "@/lib/rpc-manager";
import { readSessionHeader, resolveSessionPath } from "@/lib/session-reader";
import { projectErrorResponse, projectSnapshotResponse } from "../responses";
import { projectSessionChangeGuard } from "../session-runtime";

export async function POST(req: Request): Promise<Response> {
  try {
    const body = await req.json().catch(() => null) as { sessionIds?: unknown; projectId?: unknown } | null;
    if (!body || !Array.isArray(body.sessionIds) || body.sessionIds.length === 0
      || !body.sessionIds.every((id): id is string => typeof id === "string" && id.length > 0)
      || (body.projectId !== null && typeof body.projectId !== "string")) {
      throw new ProjectStoreError("Choose a project and at least one chat");
    }
    const sessionIds = [...new Set<string>(body.sessionIds)];
    for (const sessionId of sessionIds) {
      if (getRpcSession(sessionId)?.isAlive()) continue;
      const path = await resolveSessionPath(sessionId);
      let exists = false;
      try {
        exists = path !== null && readSessionHeader(path)?.id === sessionId;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (!exists) throw new ProjectStoreError("Chat not found", 404);
    }

    const snapshot = await setSessionProjects(
      sessionIds,
      body.projectId,
      projectSessionChangeGuard("Wait for the chat to finish before moving it"),
    );
    return projectSnapshotResponse(snapshot);
  } catch (error) {
    return projectErrorResponse(error);
  }
}
