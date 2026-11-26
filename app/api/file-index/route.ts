import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
  isWindowsAbsolutePath,
} from "@/lib/file-access";
import { buildEntriesFromFiles, filterFileEntries, type FileIndexEntry } from "@/lib/file-fuzzy";
import { joinFilePath, normalizeFilePathSlashes } from "@/lib/file-paths";

const execFileAsync = promisify(execFile);

// Same skip lists as /api/files — only used for the non-git readdir fallback.
// Git-tracked repos rely on .gitignore instead (matches the TUI's fd behavior).
const IGNORED_NAMES = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__",
  ".turbo", ".cache", "coverage", ".pytest_cache", ".mypy_cache",
  "target", "vendor", ".DS_Store",
]);

const IGNORED_SUFFIXES = [".pyc"];

/** Cap on the plain (no-query) response used as the client-side index */
const MAX_FILES = 5000;
/** Hard caps on the full in-memory listing that ?q= searches against */
const GIT_HARD_CAP = 200_000;
const WALK_HARD_CAP = 50_000;
const MAX_WALK_DEPTH = 8;
const MAX_QUERY_LENGTH = 500;
const CACHE_TTL_MS = 10_000;
const CACHE_MAX_ENTRIES = 20;

interface FileListing {
  /** Full listing up to the hard cap (not the client cap) */
  files: string[];
  /** True when even the hard cap was exceeded */
  hardTruncated: boolean;
}

type CachedListing = (FileListing & { entries?: FileIndexEntry[] }) | {
  files?: undefined;
  entries: FileIndexEntry[];
  hardTruncated: boolean;
};

interface CacheEntry {
  listing: CachedListing;
  expiresAt: number;
}

// Per-cwd cache on globalThis so it survives Next.js hot-reload; the @ menu
// re-requests on every open and searches on every keystroke, so listings must
// not be recomputed within a short window.
declare global {
  var __piFileIndexCache: Map<string, CacheEntry> | undefined;
}

function getIndexCache(): Map<string, CacheEntry> {
  if (!globalThis.__piFileIndexCache) globalThis.__piFileIndexCache = new Map();
  return globalThis.__piFileIndexCache;
}

async function listWithGit(cwd: string): Promise<FileListing | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { timeout: 10_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } },
    );
    const all = stdout.split("\0").filter(Boolean);
    if (all.length > GIT_HARD_CAP) {
      return { files: all.slice(0, GIT_HARD_CAP), hardTruncated: true };
    }
    return { files: all, hardTruncated: false };
  } catch {
    // Not a git repo (or git unavailable) — caller falls back to readdir walk.
    return null;
  }
}

function listWithWalk(cwd: string, fileLimit = WALK_HARD_CAP): FileListing {
  const files: string[] = [];
  // BFS so shallow files win when the cap truncates the listing.
  const queue: Array<{ abs: string; rel: string; depth: number }> = [{ abs: cwd, rel: "", depth: 0 }];
  let hardTruncated = false;
  for (let index = 0; index < queue.length; index++) {
    const { abs, rel, depth } = queue[index];
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (IGNORED_NAMES.has(d.name) || IGNORED_SUFFIXES.some((s) => d.name.endsWith(s))) continue;
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (depth + 1 <= MAX_WALK_DEPTH && queue.length <= fileLimit) {
          queue.push({ abs: path.join(abs, d.name), rel: childRel, depth: depth + 1 });
        } else {
          hardTruncated = true;
        }
      } else if (d.isFile()) {
        if (files.length >= fileLimit) {
          return { files, hardTruncated: true };
        }
        files.push(childRel);
      }
    }
  }
  return { files, hardTruncated };
}

function listProjectRoots(roots: Set<string>): CachedListing {
  const folders: FileIndexEntry[] = [];
  const children: FileIndexEntry[] = [];
  const usedNames = new Set<string>();
  const fileLimit = Math.floor(WALK_HARD_CAP / roots.size);
  let hardTruncated = false;
  for (const root of roots) {
    const absolutePath = normalizeFilePathSlashes(root);
    const baseName = path.basename(root) || absolutePath.replace(/\/$/, "") || "/";
    let name = baseName;
    for (let suffix = 2; usedNames.has(name.toLowerCase()); suffix++) {
      name = `${baseName} (${suffix})`;
    }
    usedNames.add(name.toLowerCase());
    folders.push({ path: name, absolutePath, isDir: true });
    const listing = listWithWalk(root, fileLimit);
    hardTruncated ||= listing.hardTruncated;
    for (const entry of buildEntriesFromFiles(listing.files)) {
      children.push({
        path: joinFilePath(name, entry.path),
        absolutePath: joinFilePath(absolutePath, entry.path),
        isDir: entry.isDir,
      });
    }
  }
  return { entries: folders.concat(children), hardTruncated };
}

async function getCachedListing(key: string, load: () => CachedListing | Promise<CachedListing>): Promise<CachedListing> {
  const cache = getIndexCache();
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.listing;
  const listing = await load();
  for (const [existingKey, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(existingKey);
  }
  if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
  cache.set(key, { listing, expiresAt: Date.now() + CACHE_TTL_MS });
  return listing;
}

// GET /api/file-index?cwd=/abs/path[&q=query]
// Without q: { files: string[] (relative to cwd, capped at MAX_FILES),
// truncated: boolean } — the client-side index for local filtering.
// With q: { matches: { path, isDir }[] } — ranked against the FULL listing so
// repos larger than MAX_FILES still find deep files (cap applied after
// matching, like the TUI passing the query to fd).
// Named project @ autocomplete omits cwd and returns entries with absolute paths.
// Guarded by the same allow-list as /api/files.
export async function GET(req: NextRequest) {
  try {
    const cwd = req.nextUrl.searchParams.get("cwd")?.trim() ?? "";
    const query = req.nextUrl.searchParams.get("q")?.slice(0, MAX_QUERY_LENGTH) ?? "";
    const projectId = req.nextUrl.searchParams.get("projectId");
    if (projectId !== null && !req.nextUrl.searchParams.has("cwd")) {
      const roots = await getAllowedFileRoots(projectId);
      if (!roots.size) return NextResponse.json({ error: "Access denied" }, { status: 403 });
      const key = JSON.stringify([projectId, [...roots]]);
      const listing = await getCachedListing(key, () => listProjectRoots(roots));
      const entries = listing.entries ?? [];
      return query
        ? NextResponse.json({ matches: filterFileEntries(entries, query) })
        : NextResponse.json({
            entries: entries.slice(0, MAX_FILES),
            truncated: listing.hardTruncated || entries.length > MAX_FILES,
          });
    }
    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots(projectId ?? undefined);
    if (!isFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(cwd);
    } catch {
      return NextResponse.json({ error: "Directory not found" }, { status: 404 });
    }
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "Not a directory" }, { status: 400 });
    }
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const cacheKey = projectId === null ? cwd : JSON.stringify([projectId, cwd]);
    const listing = await getCachedListing(cacheKey, async () =>
      (projectId === null ? await listWithGit(cwd) : null) ?? listWithWalk(cwd));
    const { files = [], hardTruncated } = listing;

    if (query) {
      listing.entries ??= buildEntriesFromFiles(files);
      return NextResponse.json({ matches: filterFileEntries(listing.entries, query) });
    }

    return NextResponse.json({
      files: files.slice(0, MAX_FILES),
      truncated: hardTruncated || files.length > MAX_FILES,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
