import { ProjectStoreError } from "@/lib/project-store";

export function projectResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

export function projectErrorResponse(error: unknown): Response {
  if (error instanceof ProjectStoreError) {
    return projectResponse({ error: error.message }, error.status);
  }
  console.error("[meteoragent] Project operation failed:", error);
  return projectResponse({ error: "Could not access the saved projects" }, 500);
}
