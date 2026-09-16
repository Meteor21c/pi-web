import { NextResponse } from "next/server";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "fs";
import { resolve } from "path";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { samePath } from "@/lib/paths";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getProjectTrustStatus } from "@/lib/project-trust";
import {
  findPluginPackageEntry,
  getPluginActivationMode,
  isDisabledPackage,
  updateSessionPluginSelection,
  type PluginPackageScope,
} from "@/lib/plugin-activation";
import { getPluginSessionManager } from "@/lib/plugin-session-manager";
import { invalidateSessionListCache } from "@/lib/session-reader";
import { GET as getPlugins } from "../route";

export const dynamic = "force-dynamic";

function readScope(value: unknown): PluginPackageScope {
  if (value === "global" || value === undefined) return "global";
  if (value === "project") return "project";
  throw new Error("scope must be global or project");
}

function normalizePath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** PATCH /api/plugins/session — save one package's session-local toggle. */
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
      sessionId?: unknown;
      source?: unknown;
      scope?: unknown;
      enabled?: unknown;
    };
    if (typeof body.cwd !== "string" || body.cwd.trim() === "") {
      return NextResponse.json({ error: "cwd required" }, { status: 400 });
    }
    if (typeof body.sessionId !== "string" || body.sessionId.trim() === "") {
      return NextResponse.json({ error: "sessionId required" }, { status: 400 });
    }
    if (typeof body.source !== "string" || body.source.trim() === "") {
      return NextResponse.json({ error: "source required" }, { status: 400 });
    }
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be boolean" }, { status: 400 });
    }
    const cwd = body.cwd;
    const sessionId = body.sessionId.trim();
    const source = body.source.trim();
    const scope = readScope(body.scope);
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const sessionManager = await getPluginSessionManager(sessionId);
    if (!sessionManager) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    if (sessionManager.getSessionId() !== sessionId) {
      return NextResponse.json({ error: "Session id mismatch" }, { status: 409 });
    }
    if (!samePath(normalizePath(sessionManager.getCwd()), normalizePath(cwd))) {
      return NextResponse.json({ error: "Session cwd mismatch" }, { status: 403 });
    }

    const agentDir = getAgentDir();
    const projectTrust = getProjectTrustStatus(cwd, agentDir);
    if (scope === "project" && !projectTrust.trusted) {
      return NextResponse.json(
        { error: "Project resources must be trusted before modifying project plugins" },
        { status: 403 },
      );
    }
    const settingsManager = SettingsManager.create(cwd, agentDir, {
      projectTrusted: projectTrust.trusted,
    });
    const entry = findPluginPackageEntry(settingsManager, source, scope);
    if (!entry) return NextResponse.json({ error: "Plugin package not found" }, { status: 404 });
    if (getPluginActivationMode(entry) !== "session") {
      return NextResponse.json(
        { error: "Only session-mode plugins can be toggled for an individual session" },
        { status: 409 },
      );
    }
    if (isDisabledPackage(entry)) {
      return NextResponse.json(
        { error: "Plugin is globally disabled; enable it in settings before selecting it for a session" },
        { status: 409 },
      );
    }

    const plugins = updateSessionPluginSelection(sessionManager, source, scope, body.enabled);
    invalidateSessionListCache();
    const pluginResponse = await getPlugins(new Request(
      `http://localhost/api/plugins?cwd=${encodeURIComponent(cwd)}&sessionId=${encodeURIComponent(sessionId)}`,
    ));
    const pluginState = await pluginResponse.json();
    return NextResponse.json({
      success: true,
      sessionId,
      source,
      scope,
      enabled: body.enabled,
      reloadRequired: true,
      selection: plugins,
      plugins: pluginState,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
