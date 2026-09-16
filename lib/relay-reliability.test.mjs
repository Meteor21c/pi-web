import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

// All credentials are fake. No default agent directory or real network access.
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalFetch = globalThis.fetch;
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "meteor-relay-regression-"));
const jiti = createJiti(import.meta.url, { alias: { "@": new URL("..", import.meta.url).pathname } });
const auth = await jiti.import("./relay-auth.ts");
const { syncRelayProviders } = await jiti.import("./relay-keys-sync.ts");
const { isRelayProviderId } = await jiti.import("./relay-config.ts");
const groupStore = await jiti.import("./relay-group-store.ts");
const { resolveMixedRelayModels } = await jiti.import("./relay-models.ts");
const { testRelayConnection, parseRelayModelIds } = await jiti.import("./relay-config-test.ts");
const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const session = () => ({ email: "mock@example.test", generation: "test-generation", accessToken: "old-access", refreshToken: "old-refresh", accessTokenExpiresAt: Date.now() + 60000, updatedAt: 1 });
const disk = (name) => JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, name), "utf8"));

test.beforeEach(async () => {
  auth.invalidateRelayOperations();
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "meteor-relay-regression-"));
  globalThis.fetch = async () => { throw new Error("Unexpected network request in isolated test"); };
  await auth.writeRelaySessionFile(session());
});
test.after(() => {
  globalThis.fetch = originalFetch;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  // Retain explicit temporary directories; never recursively delete files.
});

test("concurrent validation rotates refresh only once and preserves the new session", async () => {
  let refreshes = 0;
  globalThis.fetch = async (url, init) => {
    if (url.endsWith("/refresh")) {
      refreshes++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return response({ data: { access_token: "new-access", refresh_token: "new-refresh", expires_in: 60 } });
    }
    return init.headers.Authorization.endsWith("old-access") ? response({}, 401) : response({ data: { id: 1, email: "mock@example.test" } });
  };
  const results = await Promise.all([auth.checkRelaySession(), auth.checkRelaySession(), auth.checkRelaySession()]);
  assert.equal(refreshes, 1);
  assert.ok(results.every((r) => r.ok));
  assert.equal((await auth.readRelaySessionFile()).refreshToken, "new-refresh");
});

test("503 after refresh preserves rotated tokens and uses only unexpired offline grace", async () => {
  globalThis.fetch = async (url, init) => url.endsWith("/refresh")
    ? response({ data: { access_token: "new-access", refresh_token: "new-refresh", expires_in: 60 } })
    : response({}, init.headers.Authorization.endsWith("old-access") ? 401 : 503);
  assert.equal((await auth.checkRelaySession()).offlineGrace, true);
  assert.equal((await auth.readRelaySessionFile()).refreshToken, "new-refresh");
  await auth.writeRelaySessionFile({ ...session(), accessTokenExpiresAt: 1 });
  globalThis.fetch = async () => { throw new Error("offline"); };
  assert.equal((await auth.checkRelaySession()).ok, false);
  assert.ok(await auth.readRelaySessionFile());
});

test("key listing paginates 101 keys and rejects incomplete or secret identities", async () => {
  const calls = [];
  const deps = { fetch: async (url) => {
    calls.push(url);
    const page = Number(new URL(url).searchParams.get("page"));
    return response({ data: { total: 101, items: Array.from({ length: page === 1 ? 100 : 1 }, (_, i) => ({ id: (page - 1) * 100 + i, key: `fake-${i}` })) } });
  } };
  assert.equal((await auth.relayListKeys("fake-access", deps)).length, 101);
  assert.equal(calls.length, 2);
  await assert.rejects(auth.relayListKeys("fake", { fetch: async () => response({ data: { items: [{ key: "secret-no-id" }] } }) }), /public ID/);
  await assert.rejects(auth.relayListKeys("fake", { fetch: async () => response({ data: { total: 5, items: [] } }) }), /Incomplete/);
});

test("key listing parses nested group rate and key usage metadata", async () => {
  const [key] = await auth.relayListKeys("fake", { fetch: async () => response({ data: { items: [{
    id: 7,
    key: "sk-private",
    name: "deepseek",
    group_id: 2,
    current_concurrency: "3",
    usage_1d: "1.25",
    group: { id: 2, name: "Gemini反重力", platform: "gemini", rate_multiplier: "0.25", long_context_pricing_enabled: true },
  }] } }) });
  assert.equal(key.group.name, "Gemini反重力");
  assert.equal(key.group.platform, "gemini");
  assert.equal(key.group.rate_multiplier, 0.25);
  assert.equal(key.current_concurrency, 3);
  assert.equal(key.usage_1d, 1.25);
});

test("mixed catalog retains per-model SDK protocol/base URL and known capabilities", async () => {
  const models = resolveMixedRelayModels(["gpt-5.6", "claude-sonnet-4-6", "unknown-chat", "gpt-image-1"], "https://relay.example.test");
  assert.equal(models.length, 3);
  assert.equal(models[2].reasoning, false);
  assert.deepEqual(models[2].input, ["text"]);
  const path = join(process.env.PI_CODING_AGENT_DIR, "models.json");
  writeFileSync(path, JSON.stringify({ providers: { "meteor21c-k123": { baseUrl: "https://relay.example.test", api: "anthropic-messages", models } } }));
  const runtime = await ModelRuntime.create({ modelsPath: path, authPath: join(process.env.PI_CODING_AGENT_DIR, "auth.json") });
  const gpt = runtime.getModel("meteor21c-k123", "gpt-5.6");
  const claude = runtime.getModel("meteor21c-k123", "claude-sonnet-4-6");
  assert.equal(gpt.api, "openai-responses");
  assert.equal(gpt.baseUrl, "https://relay.example.test/v1");
  assert.equal(gpt.reasoning, true);
  assert.deepEqual(gpt.input, ["text", "image"]);
  assert.equal(claude.api, "anthropic-messages");
  assert.equal(claude.baseUrl, "https://relay.example.test");
});

test("sync preserves double-k identity, counts saved mixed models, and never rewrites tokens", async () => {
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: { "meteor21c-k-k123": { models: [] } } }));
  globalThis.fetch = async (url) => url.includes("/keys?")
    ? response({ data: { items: [{ id: 123, key: "fake-api-key", status: "active" }] } })
    : response({ data: [{ id: "gpt-5.6" }, { id: "claude-sonnet-4-6" }] });
  const before = await auth.readRelaySessionFile();
  const result = await syncRelayProviders();
  assert.equal(result.totalModelCount, 2);
  assert.equal(result.providers[0].providerId, "meteor21c-k-k123");
  assert.ok(isRelayProviderId(result.providers[0].providerId));
  assert.equal(disk("models.json").providers["meteor21c-k-k123"].models.length, 2);
  assert.deepEqual(await auth.readRelaySessionFile(), before);
});

test("sync stores safe nested group metadata without persisting the full key", async () => {
  globalThis.fetch = async (url) => url.includes("/keys?")
    ? response({ data: { items: [{
      id: 77,
      key: "sk-never-persist-this-0272",
      name: "deepseek",
      group_id: 2,
      usage_1d: 1.5,
      group: { id: 2, name: "Gemini反重力", platform: "gemini", rate_multiplier: 0.25, long_context_pricing_enabled: true },
    }] } })
    : url.includes("/model-plaza")
      ? response({ data: { groups: [{
          id: 2,
          long_context_pricing_enabled: true,
          models: [{
            name: "gemini-3-flash-preview",
            pricing: { billing_mode: "token", intervals: [
              { min_tokens: 0, max_tokens: 1_048_576 },
              { min_tokens: 1_048_576, max_tokens: null },
            ] },
          }],
        }] } })
      : response({ data: [{ id: "gemini-3-flash-preview" }] });
  const result = await syncRelayProviders();
  assert.equal(result.ok, true);
  assert.equal(result.providers[0].displayName, "deepseek");
  assert.equal(result.providers[0].groupName, "Gemini反重力");
  assert.equal(result.providers[0].rateMultiplier, 0.25);
  assert.match(result.providers[0].providerId, /^meteor21c-a[a-zA-Z0-9_-]+-k77$/);
  assert.equal(JSON.stringify(result).includes("never-persist-this"), false);
  const sidecar = readFileSync(join(process.env.PI_CODING_AGENT_DIR, "meteoragent-groups.json"), "utf8");
  assert.equal(sidecar.includes("never-persist-this"), false);
  assert.equal(JSON.parse(sidecar).groups[0].maskedKey, "sk-nev...0272");
  assert.equal(JSON.parse(sidecar).groups[0].contextWindows["gemini-3-flash-preview"], 1_048_576);
  assert.equal(disk("models.json").providers[result.providers[0].providerId].models[0].contextWindow, 1_048_576);
});

test("logout during catalog fetch prevents stale sync and keeps manual keys/history", async () => {
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "auth.json"), JSON.stringify({ meteor21c: { type: "api_key", key: "manual-fake" }, "meteor21c-k123": { type: "api_key", key: "synced-fake" } }));
  groupStore.writeRelayGroups([{ accountId: groupStore.stableRelayAccountId("mock@example.test"), providerId: "meteor21c-k123", keyId: "123", keyName: "synced", maskedKey: "sk-sync...1234", syncedAt: 1 }]);
  let release;
  let announce;
  const arrived = new Promise((r) => { announce = r; });
  globalThis.fetch = async (url) => {
    if (url.includes("/keys?")) return response({ data: { items: [{ id: 123, key: "fake-key" }] } });
    if (url.includes("/model-plaza")) return response({ data: { groups: [] } });
    announce();
    await new Promise((r) => { release = r; });
    return response({ data: [{ id: "gpt-5.6" }] });
  };
  const sync = syncRelayProviders();
  await arrived;
  await auth.clearRelaySessionFile();
  release();
  assert.equal((await sync).reason, "unauthenticated");
  assert.equal(await auth.readRelaySessionFile(), null);
  assert.equal(disk("auth.json")["meteor21c-k123"], undefined);
  assert.equal(disk("auth.json").meteor21c.key, "manual-fake");
});

test("legacy single-session data migrates to a v2 active-account store", async () => {
  const legacy = session();
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "meteoragent-session.json"), JSON.stringify(legacy));

  const migrated = await auth.readRelaySessionFile();
  assert.equal(migrated.email, legacy.email);
  assert.ok(migrated.accountId);
  const stored = disk("meteoragent-session.json");
  assert.equal(stored.version, 2);
  assert.equal(stored.activeAccountId, migrated.accountId);
  assert.equal(stored.accounts[migrated.accountId].accessToken, legacy.accessToken);
  assert.equal(stored.accounts[migrated.accountId].refreshToken, legacy.refreshToken);
});

test("multiple relay accounts coexist and logging out one preserves the other", async () => {
  await auth.clearRelaySessionFile();
  const firstEpoch = auth.invalidateRelayOperations();
  assert.equal(await auth.commitRelayLogin({
    ...session(),
    email: "first@example.test",
    accessToken: "first-token",
    user: { id: 1, email: "first@example.test", balance: 12.5 },
  }, firstEpoch), true);
  const first = await auth.readRelaySessionFile();

  const secondEpoch = auth.invalidateRelayOperations();
  assert.equal(await auth.commitRelayLogin({
    ...session(),
    email: "second@example.test",
    accessToken: "second-token",
    user: { id: 2, email: "second@example.test", balance: 4 },
  }, secondEpoch), true);
  const second = await auth.readRelaySessionFile();
  assert.ok(first.accountId);
  assert.ok(second.accountId);
  assert.notEqual(first.accountId, second.accountId);

  const beforeLogout = await auth.listRelayAccounts();
  assert.equal(beforeLogout.activeAccountId, second.accountId);
  assert.equal(beforeLogout.accounts.length, 2);
  assert.ok(beforeLogout.accounts.every((account) => !("accessToken" in account) && !("refreshToken" in account)));

  await auth.clearRelaySessionFile(second.accountId);
  assert.equal(await auth.readRelaySessionFile(second.accountId), null);
  assert.equal((await auth.readRelaySessionFile()).accountId, first.accountId);
  const afterLogout = await auth.listRelayAccounts();
  assert.equal(afterLogout.activeAccountId, first.accountId);
  assert.equal(afterLogout.accounts.some((account) => account.accountId === second.accountId), false);
  assert.equal(afterLogout.accounts.some((account) => account.accountId === first.accountId), true);
});

test("complete empty key list removes last synced provider but keeps manually configured providers", async () => {
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: { "meteor21c-k123": { models: [] }, meteor21c: { models: [] } } }));
  groupStore.writeRelayGroups([{ accountId: groupStore.stableRelayAccountId("mock@example.test"), providerId: "meteor21c-k123", keyId: "123", keyName: "old", maskedKey: "sk-old...1234", syncedAt: 1 }]);
  globalThis.fetch = async () => response({ data: { items: [] } });
  assert.equal((await syncRelayProviders()).reason, "no-key");
  assert.equal(disk("models.json").providers["meteor21c-k123"], undefined);
  assert.ok(disk("models.json").providers.meteor21c);
});

test("empty key list cleans only providers indexed to the selected account", async () => {
  const accountId = groupStore.stableRelayAccountId("mock@example.test");
  const otherAccountId = "other-account";
  const ownProvider = `meteor21c-a${accountId}-k1`;
  const otherProvider = "meteor21c-aother-account-k1";
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: {
    [ownProvider]: { models: [] },
    [otherProvider]: { models: [] },
  } }));
  groupStore.writeRelayGroups([
    { accountId, providerId: ownProvider, keyId: "1", keyName: "own", maskedKey: "sk-own...0001", syncedAt: 1 },
    { accountId: otherAccountId, providerId: otherProvider, keyId: "1", keyName: "other", maskedKey: "sk-other...0001", syncedAt: 1 },
  ]);
  globalThis.fetch = async () => response({ data: { items: [] } });
  assert.equal((await syncRelayProviders()).reason, "no-key");
  assert.equal(disk("models.json").providers[ownProvider], undefined);
  assert.ok(disk("models.json").providers[otherProvider]);
  assert.deepEqual(groupStore.readRelayGroups().map((group) => group.accountId), [otherAccountId]);
});

test("directory parser rejects malformed success; URL override is validated and honored", async () => {
  assert.throws(() => parseRelayModelIds({}), /Invalid/);
  assert.throws(() => parseRelayModelIds({ data: [{ id: 12 }] }), /Invalid/);
  let destination;
  globalThis.fetch = async (url, init) => { destination = url; assert.ok(init.signal); assert.equal(init.redirect, "error"); return response({}); };
  assert.equal((await testRelayConnection("fake", "https://alternate.example.test")).ok, false);
  assert.equal(destination, "https://alternate.example.test/v1/models");
  assert.equal((await testRelayConnection("fake", "https://user:pass@alternate.example.test")).ok, false);
});

test("account switch during sync rejects old-account results", async () => {
  let release;
  let arrived;
  const waiting = new Promise((r) => { arrived = r; });
  globalThis.fetch = async (url) => {
    if (url.includes("/keys?")) return response({ data: { items: [{ id: 42, key: "old-account-key" }] } });
    if (url.includes("/model-plaza")) return response({ data: { groups: [] } });
    arrived();
    await new Promise((r) => { release = r; });
    return response({ data: [{ id: "gpt-5.6" }] });
  };
  const pending = syncRelayProviders();
  await waiting;
  const epoch = auth.invalidateRelayOperations();
  assert.equal(await auth.commitRelayLogin({ ...session(), email: "new@example.test", accessToken: "new-account-token" }, epoch), true);
  release();
  assert.equal((await pending).reason, "unauthenticated");
  assert.equal((await auth.readRelaySessionFile()).email, "new@example.test");
});

test("partial catalog failure preserves old channel and reports warnings, unknown status is probed", async () => {
  const old = { models: [{ id: "gpt-5.6" }] };
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: { "meteor21c-k2": old } }));
  globalThis.fetch = async (url, init) => {
    if (url.includes("/keys?")) return response({ data: { items: [{ id: 1, key: "fake-1", status: "unfamiliar-status" }, { id: 2, key: "fake-2" }] } });
    return init.headers.Authorization.endsWith("fake-1") ? response({ data: [{ id: "gpt-5.6" }] }) : response({}, 503);
  };
  const result = await syncRelayProviders();
  assert.equal(result.ok, true);
  assert.equal(result.totalModelCount, 1);
  assert.match(result.providers[0].providerId, /^meteor21c-a[a-zA-Z0-9_-]+-k1$/);
  assert.deepEqual(result.warnings, [{ providerId: "meteor21c-k2", reason: "relay-error" }]);
  assert.deepEqual(disk("models.json").providers["meteor21c-k2"], old);
});

test("failed second key page cannot remove existing providers", async () => {
  const config = { providers: { "meteor21c-k999": { models: [] } } };
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(config));
  globalThis.fetch = async (url) => new URL(url).searchParams.get("page") === "1"
    ? response({ data: { total: 101, items: Array.from({ length: 100 }, (_, id) => ({ id, key: `fake-${id}` })) } })
    : response({}, 503);
  assert.equal((await syncRelayProviders()).ok, false);
  assert.deepEqual(disk("models.json"), config);
});

test("explicitly revoked key is removed but healthy peers still synchronize", async () => {
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: { "meteor21c-k2": { models: [] } } }));
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "auth.json"), JSON.stringify({ "meteor21c-k2": { type: "api_key", key: "fake-2" } }));
  globalThis.fetch = async (url, init) => url.includes("/keys?")
    ? response({ data: { items: [{ id: 1, key: "fake-1" }, { id: 2, key: "fake-2" }] } })
    : init.headers.Authorization.endsWith("fake-2") ? response({}, 403) : response({ data: [{ id: "gpt-5.6" }] });
  const result = await syncRelayProviders();
  assert.equal(result.ok, true);
  assert.equal(result.warnings[0].reason, "invalid-key");
  assert.equal(disk("models.json").providers["meteor21c-k2"], undefined);
  assert.equal(disk("auth.json")["meteor21c-k2"], undefined);
});

test("manual save uses the exact tested override for every saved model and correct count", async () => {
  const { POST } = await jiti.import("../app/api/relay-config/save/route.ts");
  let testedUrl;
  globalThis.fetch = async (url) => {
    testedUrl = url;
    return response({ data: [{ id: "gpt-5.6" }, { id: "claude-sonnet-4-6" }, { id: "gpt-image-1" }] });
  };
  const res = await POST(new Request("http://localhost:30141/api/relay-config/save", {
    method: "POST", headers: { host: "localhost:30141", origin: "http://localhost:30141", "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "fake-key", baseUrl: "https://alternate.example.test" }),
  }));
  const result = await res.json();
  assert.equal(result.ok, true);
  assert.equal(result.modelCount, 2);
  assert.equal(testedUrl, "https://alternate.example.test/v1/models");
  const models = disk("models.json").providers.meteor21c.models;
  assert.equal(models[0].baseUrl, "https://alternate.example.test/v1");
  assert.equal(models[1].baseUrl, "https://alternate.example.test");
});
