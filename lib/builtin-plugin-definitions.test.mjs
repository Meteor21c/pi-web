import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const {
  BUILTIN_PLUGIN_DEFINITIONS,
  builtinRecommendedUpdateSource,
  npmPackageName,
  sameNpmPackageSource,
} = await createJiti(import.meta.url).import("./builtin-plugin-definitions.ts");
const builtinSource = await readFile(new URL("./builtin-plugins.ts", import.meta.url), "utf8");

test("starter capabilities remain official, unpinned npm sources", () => {
  assert.deepEqual(
    BUILTIN_PLUGIN_DEFINITIONS.map((plugin) => plugin.source),
    [
      "npm:pi-web-access",
      "npm:pi-docparser",
      "npm:@amaster.ai/pi-image-gen",
      "npm:@amaster.ai/pi-computer-use",
    ],
  );
  assert.ok(BUILTIN_PLUGIN_DEFINITIONS.every((plugin) => !plugin.source.match(/@(?:\^|~|\d)/)));
  assert.ok(BUILTIN_PLUGIN_DEFINITIONS.every((plugin) => plugin.officialUrl.startsWith("https://pi.dev/packages/")));
  assert.deepEqual(
    BUILTIN_PLUGIN_DEFINITIONS.map((plugin) => plugin.recommendedVersion),
    ["0.30.0", "4.0.0", "0.1.17", "0.1.17"],
  );
  assert.equal(
    BUILTIN_PLUGIN_DEFINITIONS.find((plugin) => plugin.id === "computer-use")?.activationMode,
    "session",
  );
});

test("package matching preserves a user's version range or pin", () => {
  assert.equal(npmPackageName("npm:@scope/tool@^1.2"), "@scope/tool");
  assert.equal(npmPackageName("pi-web-access@latest"), "pi-web-access");
  assert.equal(sameNpmPackageSource("npm:pi-web-access", "npm:pi-web-access@0.29.0"), true);
  assert.equal(sameNpmPackageSource("npm:pi-web-access", "git:https://example.test/pi-web-access"), false);
});

test("starter migrations update only older unpinned official packages", () => {
  const web = BUILTIN_PLUGIN_DEFINITIONS.find((plugin) => plugin.id === "web-access");
  assert.ok(web);
  assert.equal(
    builtinRecommendedUpdateSource(web, "npm:pi-web-access", "0.29.0"),
    "npm:pi-web-access@0.30.0",
  );
  assert.equal(builtinRecommendedUpdateSource(web, "npm:pi-web-access", "0.30.0"), undefined);
  assert.equal(builtinRecommendedUpdateSource(web, "npm:pi-web-access", "0.31.0"), undefined);
  assert.equal(builtinRecommendedUpdateSource(web, "npm:pi-web-access@^0.29", "0.29.0"), undefined);
  assert.equal(builtinRecommendedUpdateSource(web, "git:https://example.test/web", "0.29.0"), undefined);
});

test("starter conflicts are reported as preserved packages, not retryable failures", () => {
  assert.match(builtinSource, /updateProgressState\(saved, definition, "conflict"/);
  assert.match(builtinSource, /已保留现有版本/);
  assert.match(builtinSource, /scope === "user"/);
  assert.match(builtinSource, /recordUnexpectedBootstrapFailure/);
  assert.match(builtinSource, /saved\.running = false/);
  assert.match(builtinSource, /setPluginActivationMode/);
  assert.match(builtinSource, /tracksEveryDefinition/);
});
