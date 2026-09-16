import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const root = await mkdtemp(join(tmpdir(), "pi-web-plugin-route-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
await mkdir(join(agentDir, "extensions"), { recursive: true });
await mkdir(cwd);
await writeFile(join(agentDir, "extensions", "rtk.ts"), "export default () => {};\n");

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { allowFileRoot } = await jiti.import("../../../lib/file-access.ts");
const { GET } = await jiti.import("./route.ts");
const { POST: CHECK_POST } = await jiti.import("./check/route.ts");
allowFileRoot(cwd);

after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
});

test("lists auto-discovered top-level extensions", async () => {
  const response = await GET(new Request(`http://localhost/api/plugins?cwd=${encodeURIComponent(cwd)}`));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.packages, []);
  assert.deepEqual(body.standaloneExtensions, [{
    kind: "extension",
    name: "rtk",
    path: join(agentDir, "extensions", "rtk.ts"),
    relativePath: "extensions/rtk.ts",
    scope: "global",
    enabled: true,
  }]);
  assert.equal(body.totals.extensions, 1);
});

test("plugin activation/session routes expose the reload-boundary contract", async () => {
  const activationRoute = await readFile(new URL("./activation/route.ts", import.meta.url), "utf8");
  const sessionRoute = await readFile(new URL("./session/route.ts", import.meta.url), "utf8");
  const rpcSource = await readFile(new URL("../../../lib/rpc-manager.ts", import.meta.url), "utf8");

  assert.match(activationRoute, /export async function PATCH/);
  assert.match(activationRoute, /activationMode: mode/);
  assert.match(activationRoute, /reloadRequired: true/);
  assert.match(sessionRoute, /sessionId required/);
  assert.match(sessionRoute, /Session cwd mismatch/);
  assert.match(sessionRoute, /updateSessionPluginSelection/);
  assert.match(sessionRoute, /plugins: pluginState/);
  assert.match(rpcSource, /createSessionScopedSettingsManager\(baseSettingsManager, sessionManager\)/);
  assert.match(rpcSource, /await this\.inner\.settingsManager\.reload\?\.\(\)/);
  assert.match(rpcSource, /await this\.inner\.reload\(\)/);
});

test("plugin listing rejects an empty session id", async () => {
  const response = await GET(new Request(
    `http://localhost/api/plugins?cwd=${encodeURIComponent(cwd)}&sessionId=%20`,
  ));
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.error, "sessionId must be a non-empty string");
});

test("plugin update checks require a trusted JSON API request", async () => {
  const crossSite = await CHECK_POST(new Request("http://localhost/api/plugins/check", {
    method: "POST",
    headers: {
      host: "localhost",
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
      "content-type": "application/json",
    },
    body: JSON.stringify({ cwd }),
  }));
  assert.equal(crossSite.status, 403);
  assert.deepEqual(await crossSite.json(), { error: "Untrusted API request" });

  const wrongType = await CHECK_POST(new Request("http://localhost/api/plugins/check", {
    method: "POST",
    headers: { host: "localhost", "content-type": "text/plain" },
    body: JSON.stringify({ cwd }),
  }));
  assert.equal(wrongType.status, 415);
  assert.deepEqual(await wrongType.json(), { error: "Content-Type must be application/json" });
});
