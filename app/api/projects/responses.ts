import { getActiveProjectRoots, ProjectStoreError } from "@/lib/project-store";
import { samePath } from "@/lib/paths";
import type { ProjectSnapshot } from "@/lib/projects";

export function projectResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

export function projectSnapshotResponse(snapshot: ProjectSnapshot, status = 200): Response {
  const projects = snapshot.projects.map((project) => {
    const active = [...getActiveProjectRoots(project)];
    const unavailableDirectories = project.directories.filter((directory) => !active.some((root) => samePath(root, directory)));
    return unavailableDirectories.length > 0 ? { ...project, unavailableDirectories } : project;
  });
  return projectResponse({ ...snapshot, projects }, status);
}

export function projectErrorResponse(error: unknown): Response {
  if (error instanceof ProjectStoreError) {
    return projectResponse({ error: error.message }, error.status);
  }
  console.error("[meteoragent] Project operation failed:", error);
  return projectResponse({ error: "Could not access the saved projects" }, 500);
}
