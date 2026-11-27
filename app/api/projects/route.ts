import { createNamedProject, getProjectSnapshot } from "@/lib/project-store";
import { projectErrorResponse, projectSnapshotResponse } from "./responses";

export const dynamic = "force-dynamic";

export function GET(): Response {
  try {
    return projectSnapshotResponse(getProjectSnapshot());
  } catch (error) {
    return projectErrorResponse(error);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body: unknown = await req.json().catch(() => undefined);
    return projectSnapshotResponse(await createNamedProject(body), 201);
  } catch (error) {
    return projectErrorResponse(error);
  }
}
