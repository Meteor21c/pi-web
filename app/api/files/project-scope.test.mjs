import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { GET, POST, DELETE } = await jiti.import("./[...path]/route.ts");
const { GET: index } = await jiti.import("../file-index/route.ts");
const { getAllowedFileRoots, getProjectFileRoots, allowFileRoot } = await jiti.import("../../../lib/file-access.ts");
const { encodeFilePathForApi, normalizeFilePathSlashes } = await jiti.import("../../../lib/file-paths.ts");
const { ORIGINAL_IMAGE_DIRECTORY } = await jiti.import("../../../lib/image-attachments.ts");
const { createNamedProject, setSessionProject, updateNamedProject } = await jiti.import("../../../lib/project-store.ts");
const { cacheSessionPath, invalidateSessionPathCache } = await jiti.import("../../../lib/session-reader.ts");

const origin = "http://localhost";

function checkedFile(filePath, type, projectId, method = "GET", body, sessionId) {
  const params = new URLSearchParams({ type });
  if (projectId !== undefined) params.set("projectId", projectId);
  if (sessionId !== undefined) params.set("sessionId", sessionId);
  const encoded = encodeFilePathForApi(filePath);
  const isUpload = body instanceof FormData;
  const request = new NextRequest(origin + `/api/files/${encoded}?${params}`, {
    method,
    headers: { Host: "localhost", Origin: origin, ...(!isUpload && { "Content-Type": "application/json" }) },
    body: body === undefined || isUpload ? body : JSON.stringify(body),
  });
  const handler = { GET, POST, DELETE }[method];
  return handler(request, { params: Promise.resolve({ path: encoded.split("/").map(decodeURIComponent) }) });
}

test("named file browsing uses only current directories and changes take effect immediately", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "magent-project-files-"));
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  const priorAdditionalRoots = globalThis.__piAdditionalAllowedRoots;
  const priorRootCache = globalThis.__piAllowedRootsCache;
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  globalThis.__piAdditionalAllowedRoots = new Set();
  globalThis.__piAllowedRootsCache = undefined;
  t.after(() => {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    globalThis.__piAdditionalAllowedRoots = priorAdditionalRoots;
    globalThis.__piAllowedRootsCache = priorRootCache;
  });

  const primary = path.join(root, "primary");
  const extra = path.join(root, "extra files");
  const outside = path.join(root, "outside");
  mkdirSync(primary);
  mkdirSync(extra);
  mkdirSync(outside);
  const note = path.join(extra, "demo.txt");
  const outsideNote = path.join(outside, "example.txt");
  writeFileSync(note, "extra project document");
  writeFileSync(outsideNote, "example in a different directory");
  const { project } = await createNamedProject({ name: "Demo", defaultDirectory: primary, directories: [extra] });
  const { id, defaultDirectory, directories } = project;
  const [projectRoot, additionalRoot] = directories;
  const extraNote = path.join(additionalRoot, path.basename(note));
  allowFileRoot(outside);

  assert.deepEqual([...getProjectFileRoots(id)], directories);
  assert.equal((await getAllowedFileRoots(null)).size, 0);
  assert.equal((await checkedFile(outsideNote, "read")).status, 200);
  assert.equal((await checkedFile(outsideNote, "read", id)).status, 403);
  assert.equal((await checkedFile(outsideNote, "read", "")).status, 403);
  assert.equal((await checkedFile(extraNote, "read", "unknown")).status, 403);
  assert.equal((await checkedFile(extraNote, "read")).status, 403);
  const read = await checkedFile(extraNote, "read", id);
  assert.equal(read.status, 200);
  assert.equal((await read.json()).content, "extra project document");

  const uploadCheck = { fileNames: ["draft.txt"] };
  assert.equal((await checkedFile(additionalRoot, "upload-check", id, "POST", uploadCheck)).status, 200);
  assert.equal((await checkedFile(outside, "upload-check", id, "POST", uploadCheck)).status, 403);
  assert.equal((await checkedFile(outsideNote, "read", id, "DELETE")).status, 403);

  const link = path.join(projectRoot, "outside-link");
  symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  assert.equal((await checkedFile(path.join(link, "example.txt"), "read", id)).status, 403);
  assert.deepEqual((await (await checkedFile(projectRoot, "list", id)).json()).entries, []);

  const indexFor = (cwd) => index(new NextRequest(origin + `/api/file-index?${new URLSearchParams({ cwd, projectId: id })}`));
  assert.deepEqual((await (await indexFor(additionalRoot)).json()).files, ["demo.txt"]);
  assert.equal((await indexFor(outside)).status, 403);

  const allProjectFiles = (params = {}) => index(new NextRequest(origin + `/api/file-index?${new URLSearchParams({ projectId: id, ...params })}`));
  const { entries } = await (await allProjectFiles()).json();
  const extraDirectory = normalizeFilePathSlashes(additionalRoot);
  const indexedNote = {
    path: "extra files/demo.txt",
    absolutePath: normalizeFilePathSlashes(extraNote),
    isDir: false,
  };
  assert.deepEqual(entries, [
    { path: "primary", absolutePath: normalizeFilePathSlashes(projectRoot), isDir: true },
    { path: "extra files", absolutePath: extraDirectory, isDir: true },
    indexedNote,
  ]);
  assert.deepEqual((await (await allProjectFiles({ q: `${extraDirectory}/` })).json()).matches, [indexedNote]);
  assert.equal((await allProjectFiles({ projectId: "missing" })).status, 403);

  // URLs in inline chat media carry the session ID, so they must inherit the
  // same project scope even when they do not specify the project explicitly.
  const sessionId = randomUUID();
  const attachmentDirectory = path.join(process.env.PI_CODING_AGENT_DIR, ORIGINAL_IMAGE_DIRECTORY, "image-example");
  mkdirSync(attachmentDirectory, { recursive: true });
  const attachment = path.join(attachmentDirectory, "example.png");
  writeFileSync(attachment, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const sessionFile = path.join(root, `${sessionId}.jsonl`);
  const timestamp = new Date().toISOString();
  const header = { type: "session", version: 3, id: sessionId, cwd: projectRoot, timestamp };
  const message = { role: "user", content: `@"${attachment}"\n@"${outsideNote}"` };
  const entry = { type: "message", id: "user", parentId: null, timestamp, message };
  writeFileSync(sessionFile, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`);
  cacheSessionPath(sessionId, sessionFile);
  t.after(() => invalidateSessionPathCache(sessionId));
  await setSessionProject(sessionId, id);
  const readBySession = (filePath, projectId) => checkedFile(filePath, "read", projectId, "GET", undefined, sessionId);
  assert.equal((await readBySession(extraNote)).status, 200);
  assert.equal((await readBySession(outsideNote)).status, 403);
  assert.equal((await readBySession(attachment)).status, 200);
  assert.equal((await readBySession(attachment, "missing")).status, 403);

  await updateNamedProject(id, { defaultDirectory, directories: [defaultDirectory] });
  assert.equal((await checkedFile(extraNote, "read", id)).status, 403);
  assert.equal((await readBySession(extraNote)).status, 403);
  assert.equal((await indexFor(additionalRoot)).status, 403);
  assert.deepEqual((await (await allProjectFiles({ q: "demo.txt" })).json()).matches, []);
  const upload = new FormData();
  upload.append("files", new Blob(["new project document"], { type: "text/plain" }), "draft.txt");
  const uploadResponse = await checkedFile(defaultDirectory, "upload", id, "POST", upload);
  assert.equal(uploadResponse.status, 200);
  assert.deepEqual((await uploadResponse.json()).uploaded, ["draft.txt"]);
  assert.equal((await readBySession(path.join(defaultDirectory, "draft.txt"))).status, 200);
  await setSessionProject(sessionId, null);
  assert.equal((await readBySession(outsideNote)).status, 403);
  assert.equal((await readBySession(attachment)).status, 200);
});
