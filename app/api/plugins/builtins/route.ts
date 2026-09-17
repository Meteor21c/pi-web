import { NextResponse } from "next/server";
import { ensureBuiltinPlugins, getBuiltinPluginStatus } from "@/lib/builtin-plugins";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

function readCwd(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new Error("cwd must be a non-empty string");
  return value;
}

async function validateCwd(cwd: string | undefined): Promise<string> {
  const resolved = cwd ?? process.cwd();
  if (!cwd) return resolved;
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) throw new Error("Access denied");
  return cwd;
}

/** GET /api/plugins/builtins — status of the automatic starter packages. */
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const query = new URL(request.url).searchParams.get("cwd");
    const cwd = await validateCwd(readCwd(query));
    const response = NextResponse.json(getBuiltinPluginStatus(cwd));
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

/**
 * POST /api/plugins/builtins — start the idempotent first-run bootstrap.
 * Installation is deliberately not awaited: all packages are optional and a
 * registry outage must never stop the main workspace from opening. Poll GET
 * to show progress and call POST again to retry failed entries.
 */
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    let body: { cwd?: unknown; force?: unknown };
    try {
      body = await request.json() as { cwd?: unknown; force?: unknown };
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const cwd = await validateCwd(readCwd(body.cwd));
    void ensureBuiltinPlugins(cwd, { force: body.force === true });
    const status = getBuiltinPluginStatus(cwd);
    const response = NextResponse.json(status, { status: 202 });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
