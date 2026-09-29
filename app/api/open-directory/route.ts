import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } from "@/lib/file-access";
import { nativeDirectoryCommand } from "@/lib/native-directory";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

function launchFileManager(directory: string): Promise<void> {
  const { command, args } = nativeDirectoryCommand(directory);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  const body = await request.json().catch(() => null) as { path?: unknown } | null;
  const requestedPath = typeof body?.path === "string" ? body.path.trim() : "";
  if (!requestedPath || !path.isAbsolute(requestedPath)) {
    return NextResponse.json({ error: "An absolute project directory is required" }, { status: 400 });
  }

  try {
    const roots = await getAllowedFileRoots();
    if (!isFilePathAllowed(requestedPath, roots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(requestedPath);
    } catch {
      return NextResponse.json({ error: "Project directory not found" }, { status: 404 });
    }
    if (!stat.isDirectory() || !isExistingFilePathAllowed(requestedPath, roots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    await launchFileManager(fs.realpathSync(requestedPath));
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}
