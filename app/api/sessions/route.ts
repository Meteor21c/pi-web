import { jsonResponse } from "@/lib/json-response";
import { getProjectSnapshot } from "@/lib/project-store";
import {
  attachSessionProjectInfo,
  getSessionListVersion,
  listAllSessions,
  mergeSessionLists,
} from "@/lib/session-reader";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRpcSessionInfos,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const force = new URL(req.url).searchParams.get("force") === "1";
    const persistedSessionsPromise = listAllSessions({ force });
    // Capture before awaiting: mutations during the scan still require a later refresh.
    const sessionListVersion = getSessionListVersion();
    const [persistedSessions, runtimeSessions] = await Promise.all([
      persistedSessionsPromise,
      attachSessionProjectInfo(getRpcSessionInfos()),
    ]);
    const { assignments } = getProjectSnapshot();
    const sessions = mergeSessionLists(persistedSessions, runtimeSessions).map((session) => {
      const projectId = assignments[session.id];
      return projectId === undefined ? session : { ...session, projectId };
    });
    return jsonResponse({
      sessions,
      sessionListVersion,
      runningSessionIds: getRunningRpcSessionIds(),
      completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
    });
  } catch (error) {
    return jsonResponse({ error: String(error) }, { status: 500 });
  }
}
