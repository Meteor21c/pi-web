import { NextResponse } from "next/server";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { resolve } from "path";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getProjectTrustStatus } from "@/lib/project-trust";
import {
  findPluginPackageEntry,
  setPluginActivationMode,
  type PluginActivationMode,
} from "@/lib/plugin-activation";
import { withPluginOperationLock } from "@/lib/plugin-operation-lock";

export const dynamic = "force-dynamic";

function readScope(value: unknown): "global" | "project" {
  if (value === undefined || value === "global") return "global";
  if (value === "project") return "project";
  throw new Error("scope must be global or project");
}

function readMode(value: unknown): PluginActivationMode {
  if (value === "global" || value === "session") return value;
  throw new Error("mode must be global or session");
}

/** PATCH /api/plugins/activation — set a package's global/session policy. */
export async function PATCH(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as {
      cwd?: unknown;
      source?: unknown;
      scope?: unknown;
      mode?: unknown;
    };
    if (typeof body.cwd !== "string" || body.cwd.trim() === "") {
      return NextResponse.json({ error: "cwd required" }, { status: 400 });
    }
    if (typeof body.source !== "string" || body.source.trim() === "") {
      return NextResponse.json({ error: "source required" }, { status: 400 });
    }
    const scope = readScope(body.scope);
    const mode = readMode(body.mode);
    const cwd = body.cwd;
    const source = body.source.trim();
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const agentDir = getAgentDir();
    const projectTrust = getProjectTrustStatus(cwd, agentDir);
    if (scope === "project" && !projectTrust.trusted) {
      return NextResponse.json(
        { error: "Project resources must be trusted before modifying project plugins" },
        { status: 403 },
      );
    }
    const updated = await withPluginOperationLock(resolve(agentDir), async () => {
      // Read settings only after acquiring the queue so a concurrent starter
      // install cannot be overwritten by this request's stale snapshot.
      const settingsManager = SettingsManager.create(cwd, agentDir, {
        projectTrusted: projectTrust.trusted,
      });
      if (!findPluginPackageEntry(settingsManager, source, scope)) return false;
      if (!setPluginActivationMode(settingsManager, source, scope, mode)) return false;
      await settingsManager.flush();
      return true;
    });
    if (!updated) return NextResponse.json({ error: "Plugin package not found" }, { status: 404 });

    return NextResponse.json({
      success: true,
      source,
      scope,
      activationMode: mode,
      reloadRequired: true,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
