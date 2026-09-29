import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8");
const sidebarSource = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../app/api/files/[...path]/route.ts", import.meta.url), "utf8");
const openDirectorySource = await readFile(new URL("../app/api/open-directory/route.ts", import.meta.url), "utf8");

test("provides a debounced file search UI and opens selected results", () => {
  assert.match(source, /searchQuery/);
  assert.match(source, /\/api\/file-index\?cwd=\$\{encodeURIComponent\(cwd\)\}&q=\$\{encodeURIComponent\(query\)\}/);
  assert.match(source, /setTimeout\(\(\) =>/);
  assert.match(source, /onOpenFile\(node\.fullPath, node\.name\)/);
});

test("renders search results with the existing expandable file tree", () => {
  assert.match(source, /buildSearchTree/);
  assert.match(source, /searchRoots\.map/);
  assert.match(source, /<TreeNode/);
  assert.match(source, /expandedPaths=\{searchExpanded\}/);
});

test("search result rows offer mention and download actions like the file tree", () => {
  assert.match(source, /onAtMention\(getRelativeFilePath\(node\.fullPath, cwd\), node\.isDir\)/);
  assert.match(source, /<MentionIcon \/>/);
  assert.match(source, /encodeFilePathForApi\(node\.fullPath\)\}\?type=download/);
  assert.match(source, /window\.confirm\(t\("files\.confirmDelete"/);
  assert.match(source, /onDeleteFile=\{handleDeleteFile\}/);
  assert.match(apiSource, /export async function DELETE\(/);
});

test("project address can open its authorized directory in the native file manager", () => {
  assert.match(sidebarSource, /fetch\("\/api\/open-directory"/);
  assert.match(sidebarSource, /sidebar\.openInFileManager/);
  assert.match(openDirectorySource, /isExistingFilePathAllowed\(requestedPath, roots\)/);
  assert.match(openDirectorySource, /nativeDirectoryCommand\(directory\)/);
});

test("keeps search on the bounded index and reports request failures", () => {
  assert.match(source, /setSearchError\(true\)/);
  assert.match(source, /role="alert"/);
  assert.doesNotMatch(apiSource, /type === "search"|searchFiles/);
});
