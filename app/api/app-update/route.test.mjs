import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("manual update checks bypass the in-memory release cache", () => {
  assert.match(source, /export async function GET\(request: Request\)/);
  assert.match(source, /searchParams\.get\("refresh"\) === "1"/);
  assert.match(source, /loadUpdateStatus\(forceRefresh\)/);
  assert.match(source, /if \(forceRefresh\) \{[\s\S]*?await fetchLatestVersion\(\)/);
});

test("desktop checks use the desktop channel and the matching native installer", async () => {
  const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
  const previous = process.env.METEORAGENT_DESKTOP_PLATFORM;
  const originalFetch = globalThis.fetch;
  process.env.METEORAGENT_DESKTOP_PLATFORM = "windows-x64";
  globalThis.fetch = async (url) => {
    assert.equal(url, "https://dl.meteor21c.fun/desktop/latest.json");
    return Response.json({ version: "9.1.4", installers: {
      "windows-x64": { artifact: "MeteorAgent-Desktop-Beta-9.1.4-Windows-x64-Setup.exe", bytes: 80_000_000, sha256: "a".repeat(64) },
    } });
  };
  try {
    const { GET } = await jiti.import("./route.ts");
    const response = await GET(new Request("http://localhost/api/app-update?refresh=1"));
    const status = await response.json();
    assert.equal(response.status, 200);
    assert.equal(status.latestVersion, "9.1.4");
    assert.equal(status.updateAvailable, true);
    assert.equal(status.desktop, true);
    assert.equal(status.automaticUpdateSupported, false);
    assert.equal(status.releaseUrl, "https://dl.meteor21c.fun/desktop/9.1.4/MeteorAgent-Desktop-Beta-9.1.4-Windows-x64-Setup.exe");
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.METEORAGENT_DESKTOP_PLATFORM;
    else process.env.METEORAGENT_DESKTOP_PLATFORM = previous;
    globalThis.__meteorAgentAppUpdateCache = undefined;
  }
});
