import { createNamedProject, getProjectSnapshot } from "@/lib/project-store";
import { projectErrorResponse, projectResponse } from "./responses";

export const dynamic = "force-dynamic";

export function GET(): Response {
  try {
    return projectResponse(getProjectSnapshot());
  } catch (error) {
    return projectErrorResponse(error);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body: unknown = await req.json().catch(() => undefined);
    return projectResponse(await createNamedProject(body), 201);
  } catch (error) {
    return projectErrorResponse(error);
  }
}
