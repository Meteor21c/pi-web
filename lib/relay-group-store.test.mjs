import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const jiti = createJiti(import.meta.url, { interopDefault: true });
const store = await jiti.import("./relay-group-store.ts");

test.beforeEach(() => {
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "meteor-group-store-"));
});

test.after(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

test("safe key DTO keeps group metadata but never exposes the credential", () => {
  const key = {
    id: 7,
    key: "sk-secret-material-0272",
    name: "deepseek",
    group_id: 2,
    usage_1d: 1.25,
    group: { name: "Gemini反重力", platform: "gemini", rate_multiplier: 0.25, long_context_pricing_enabled: true },
  };
  const safe = store.safeRelayKey(key);
  assert.equal(safe.name, "deepseek");
  assert.equal(safe.maskedKey, "sk-sec...0272");
  assert.equal(safe.groupName, "Gemini反重力");
  assert.equal(safe.rateMultiplier, 0.25);
  assert.equal(safe.key, undefined);
  assert.equal(JSON.stringify(safe).includes("secret-material"), false);
});

test("private group sidecar replaces only the selected account", () => {
  const first = store.metadataForRelayKey("a1", "meteor21c-aa1-k7", { id: 7, key: "sk-first-secret", name: "first" }, 1);
  const second = store.metadataForRelayKey("a2", "meteor21c-aa2-k7", { id: 7, key: "sk-second-secret", name: "second" }, 2);
  store.writeRelayGroups([first, second]);
  store.replaceRelayGroupsForAccount("a1", [{ ...first, keyName: "renamed", syncedAt: 3 }]);
  assert.deepEqual(store.readRelayGroups().map((group) => group.keyName).sort(), ["renamed", "second"]);
  const path = join(process.env.PI_CODING_AGENT_DIR, "meteoragent-groups.json");
  const raw = readFileSync(path, "utf8");
  assert.equal(raw.includes("first-secret"), false);
  assert.equal(raw.includes("second-secret"), false);
});

test("authorization index treats a missing snapshot as fail-closed", () => {
  const indexed = store.metadataForRelayKey(
    "a1",
    "meteor21c-a1-k7",
    { id: 7, key: "sk-first-secret", name: "first" },
    1,
    undefined,
    undefined,
    ["grok-4.3", "grok-4.5", "grok-4.6"],
  );
  const legacy = store.metadataForRelayKey("a1", "meteor21c-a1-k8", { id: 8, key: "sk-second-secret", name: "legacy" }, 1);
  const authorized = store.relayAuthorizedModelIdsByProvider([indexed, legacy]);

  assert.deepEqual([...authorized.get("meteor21c-a1-k7")], ["grok-4.3", "grok-4.5", "grok-4.6"]);
  assert.deepEqual([...authorized.get("meteor21c-a1-k8")], []);
});
