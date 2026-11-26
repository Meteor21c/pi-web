import { updateNamedProject } from "@/lib/project-store";
import { projectErrorResponse, projectResponse } from "../responses";
import { projectSessionChangeGuard } from "../session-runtime";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await params;
    const body: unknown = await req.json().catch(() => undefined);
    return projectResponse(await updateNamedProject(
      id,
      body,
      projectSessionChangeGuard("Wait for this project's chats to finish before editing its folders"),
    ));
  } catch (error) {
    return projectErrorResponse(error);
  }
}
