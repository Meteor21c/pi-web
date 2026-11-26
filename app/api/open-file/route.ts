import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } from "@/lib/file-access";
import { launchNativeCommand, nativeDirectoryCommand, nativeFileCommand } from "@/lib/native-directory";
import { sessionProjectId } from "@/lib/project-store";
import { hasJsonContentType, isLocalDesktopRequest } from "@/lib/request-security";

export async function POST(request: Request) {
  if (!isLocalDesktopRequest(request)) {
    return NextResponse.json({ error: "Native file actions require the local Magent window" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  const body = await request.json().catch(() => null) as { path?: unknown; action?: unknown; sessionId?: unknown } | null;
  const requestedPath = body?.path;
  const action = body?.action;
  if (typeof requestedPath !== "string" || !path.isAbsolute(requestedPath) || requestedPath.includes("\0")
    || (action !== "open" && action !== "reveal")) {
    return NextResponse.json({ error: "An absolute path and a valid file action are required" }, { status: 400 });
  }

  try {
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId : undefined;
    const projectId = new URL(request.url).searchParams.get("projectId")
      ?? (sessionId ? sessionProjectId(sessionId) : undefined);
    const roots = await getAllowedFileRoots(projectId);
    if (!isFilePathAllowed(requestedPath, roots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    let realPath: string;
    let stat: fs.Stats;
    try {
      realPath = fs.realpathSync(requestedPath);
      stat = fs.statSync(realPath);
    } catch {
      return NextResponse.json({ error: "File or folder not found" }, { status: 404 });
    }
    if ((!stat.isFile() && !stat.isDirectory()) || !isExistingFilePathAllowed(realPath, roots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    // Reveal the entry shown in the tree, including an in-project link to another file.
    const target = action === "reveal" ? path.resolve(requestedPath) : realPath;
    await launchNativeCommand(action === "open" && stat.isDirectory()
      ? nativeDirectoryCommand(target) : nativeFileCommand(target, action));
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Could not open the file or folder" }, { status: 500 });
  }
}
