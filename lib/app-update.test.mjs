import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getMeteorAgentReleaseUrl, isNewerStableVersion, parseAppUpdateManifest, parseDesktopUpdateManifest } = await jiti.import("./app-update.ts");

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
    getMeteorAgentReleaseUrl("0.8.8"),
    "https://dl.meteor21c.fun/",
  );
  assert.equal(getMeteorAgentReleaseUrl("0.8.8-beta.1"), null);
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

test("each desktop platform can skip to its latest versioned installer", () => {
  const mac = { artifact: "MeteorAgent-Desktop-Beta-0.1.30-macOS-arm64.dmg", sha256: "a".repeat(64), bytes: 420_000_000 };
  const windows = { artifact: "MeteorAgent-Desktop-Beta-0.1.30-Windows-x64-Setup.exe", sha256: "b".repeat(64), bytes: 230_000_000 };
  const manifest = { version: "0.1.30", installers: { "macos-arm64": mac, "windows-x64": windows }, releaseNotes: ["Project chats"] };
  for (const [platform, artifact] of Object.entries(manifest.installers)) {
    const choice = parseDesktopUpdateManifest(manifest, platform);
    assert.equal(isNewerStableVersion(choice.version, "0.1.26"), true);
    assert.equal(isNewerStableVersion(choice.version, "0.1.30"), false);
    assert.equal(choice.releaseUrl, `https://dl.meteor21c.fun/desktop/0.1.30/${artifact.artifact}`);
    assert.equal(choice.bytes, artifact.bytes);
    assert.deepEqual(choice.releaseNotes, ["Project chats"]);
  }
  assert.equal(parseDesktopUpdateManifest(manifest, "linux-x64"), null);
  assert.equal(parseDesktopUpdateManifest({ ...manifest, version: "0.1.31" }, "macos-arm64"), null);
  assert.equal(parseDesktopUpdateManifest({ ...manifest, installers: { "windows-x64": mac } }, "windows-x64"), null);
});
