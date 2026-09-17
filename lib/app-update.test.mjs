import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getPiWebReleaseUrl, isNewerStableVersion, parseAppUpdateManifest } = await jiti.import("./app-update.ts");

test("detects newer stable Pi Web versions", () => {
  assert.equal(isNewerStableVersion("0.8.8", "0.8.7"), true);
  assert.equal(isNewerStableVersion("0.9.0", "0.8.7"), true);
  assert.equal(isNewerStableVersion("1.0.0", "0.9.9"), true);
});

test("does not report equal, older, or unsupported versions as updates", () => {
  assert.equal(isNewerStableVersion("0.8.7", "0.8.7"), false);
  assert.equal(isNewerStableVersion("0.8.6", "0.8.7"), false);
  assert.equal(isNewerStableVersion("0.8.8-beta.1", "0.8.7"), false);
  assert.equal(isNewerStableVersion("invalid", "0.8.7"), false);
});

test("builds a release-notes URL only for stable versions", () => {
  assert.equal(
    getPiWebReleaseUrl("0.8.8"),
    "https://dl.meteor21c.fun/",
  );
  assert.equal(getPiWebReleaseUrl("0.8.8-beta.1"), null);
});

test("accepts only the exact update artifact declared for a stable version", () => {
  const parsed = parseAppUpdateManifest({
    version: "0.8.8",
    artifact: "meteor21c-webagent-0.8.8.tgz",
    sha256: "a".repeat(64),
    bytes: 1024,
    releaseNotes: ["  Better updates  ", 42, ""],
    publishedAt: "2026-09-17T09:00:00.000Z",
  });
  assert.deepEqual(parsed, {
    version: "0.8.8",
    artifact: "meteor21c-webagent-0.8.8.tgz",
    sha256: "a".repeat(64),
    bytes: 1024,
    releaseNotes: ["Better updates"],
    publishedAt: "2026-09-17T09:00:00.000Z",
  });
});

test("rejects manifests that could redirect the privileged updater", () => {
  const base = {
    version: "0.8.8",
    artifact: "meteor21c-webagent-0.8.8.tgz",
    sha256: "a".repeat(64),
    bytes: 1024,
  };
  assert.equal(parseAppUpdateManifest({ ...base, artifact: "https://evil.example/update.tgz" }), null);
  assert.equal(parseAppUpdateManifest({ ...base, sha256: "not-a-hash" }), null);
  assert.equal(parseAppUpdateManifest({ ...base, bytes: 0 }), null);
  assert.equal(parseAppUpdateManifest({ ...base, version: "0.8.8-beta.1" }), null);
});
