import assert from "node:assert/strict";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET } = await jiti.import("./[id]/export/route.ts");
const { cacheSessionPath, invalidateSessionPathCache } = await jiti.import("@/lib/session-reader");

test("the pinned Pi exporter returns an HTML download for a saved conversation with branches", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "magent-export-fixture-"));
  const file = join(directory, "conversation.jsonl");
  const id = "export-fixture-" + directory.split("-").at(-1);
  const timestamp = new Date().toISOString();
  const userMessage = (entryId, parentId, text) => ({
    type: "message", id: entryId, parentId, timestamp,
    message: { role: "user", content: [{ type: "text", text }], timestamp: Date.parse(timestamp) },
  });
  const entries = [
    { type: "session", version: 3, id, cwd: directory, timestamp },
    userMessage("root", null, "Plan the meeting"),
    userMessage("first", "root", "Draft the agenda"),
    userMessage("second", "root", "Invite the team"),
  ];
  await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  cacheSessionPath(id, file);
  t.after(async () => {
    invalidateSessionPathCache(id);
    await unlink(file);
    await rmdir(directory);
  });

  const response = await GET(new Request(`http://localhost/api/sessions/${id}/export`), {
    params: Promise.resolve({ id }),
  });
  const html = await response.text();
  assert.equal(response.status, 200, html.slice(0, 500));
  assert.match(response.headers.get("content-disposition"), /^attachment;.*\.html/);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(html, /<!DOCTYPE html>/i);
  const data = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
  assert.ok(data, "export must contain the conversation data");
  const exported = JSON.parse(Buffer.from(data.trim(), "base64").toString("utf8"));
  assert.deepEqual(exported.entries.filter((entry) => entry.parentId === "root"), entries.slice(2));
});
