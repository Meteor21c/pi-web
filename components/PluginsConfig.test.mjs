import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const source = await readFile(new URL("./PluginsConfig.tsx", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");
const {
  COMMUNITY_PLUGIN_CATEGORY_ORDER,
  filterCommunityPluginCatalog,
  sameCommunityPluginSource,
} = await createJiti(import.meta.url).import("../lib/plugin-catalog.ts");

test("plugin settings load the official community catalog before installed packages", () => {
  assert.deepEqual(COMMUNITY_PLUGIN_CATEGORY_ORDER, ["skill", "prompt", "tool"]);
  assert.match(source, /<PluginViewTabs/);
  assert.match(source, /view === "community"/);
  assert.match(source, /<CommunityPluginPanel/);
  assert.match(source, /data-plugin-community-category=/);
  assert.match(source, /filterCommunityPluginCatalog/);
  assert.match(source, /sameCommunityPluginSource/);
  assert.match(source, /fetch\(`\/api\/plugins\/catalog/);
  assert.match(source, /\/api\/plugins\/catalog\?q=\$\{encodeURIComponent\(normalizedQuery\)\}/);
  assert.match(source, /controller\.abort\(\)/);
  assert.match(source, /onRefreshCatalog/);
  assert.match(source, /window\.setInterval\(\(\) => void loadCatalog\(\), COMMUNITY_CATALOG_REFRESH_MS\)/);
  assert.doesNotMatch(source, /pluginLowRiskNotice/);
});

test("plugin settings expose the official starter capability bootstrap", () => {
  assert.match(source, /<BuiltinPluginsPanel cwd=\{cwd\}/);
  assert.match(source, /\/api\/plugins\/builtins\?cwd=/);
  assert.match(source, /body: JSON\.stringify\(\{ cwd, \.\.\.\(force \? \{ force: true \} : \{\}\) \}\)/);
  assert.match(source, /builtinPluginProgress/);
  assert.match(source, /builtinPluginRetry/);
});

test("first-run starter installation discloses local permissions without blocking chat", () => {
  assert.match(appShellSource, /function BuiltinSetupNotice/);
  assert.match(appShellSource, /BUILTIN_SETUP_NOTICE_KEY/);
  assert.match(appShellSource, /builtinNoticeBody/);
  assert.match(appShellSource, /builtinNoticeManage/);
  assert.match(appShellSource, /<BuiltinSetupNotice/);
  assert.match(cssSource, /\.builtin-setup-notice \{/);
  assert.match(cssSource, /\.builtin-setup-notice-dismiss/);
});

test("community installation keeps a disclaimer, progress steps, and the existing install API", () => {
  assert.match(source, /<PluginInstallWarningDialog/);
  assert.match(source, /pluginInstallWarningBody/);
  assert.match(source, /data-plugin-install-progress/);
  assert.match(source, /pluginInstallStagePreparing/);
  assert.match(source, /pluginInstallStageDownloading/);
  assert.match(source, /pluginInstallStageInstalling/);
  assert.match(source, /pluginInstallStageFinalizing/);
  assert.match(source, /fetch\("\/api\/plugins"/);
  assert.match(source, /body: JSON\.stringify\(\{ action: "install"/);
  assert.match(cssSource, /\.plugin-install-progress \{/);
  assert.match(cssSource, /\.plugin-install-warning-backdrop \{/);
});

test("installed package activation scope calls the dedicated API and keeps reload guidance", () => {
  assert.match(source, /pluginActivationMode/);
  assert.match(source, /role="radiogroup"/);
  assert.match(source, /pluginActivationGlobal/);
  assert.match(source, /pluginActivationSession/);
  assert.match(source, /fetch\("\/api\/plugins\/activation"/);
  assert.match(source, /method: "PATCH"/);
  assert.match(source, /pluginActivationSaved/);
  assert.match(source, /sessionId=\$\{encodeURIComponent\(sessionId\)\}/);
});

test("community catalog filtering preserves low-risk category order", () => {
  const entries = [
    { id: "tool-review", source: "npm:tool-review", name: "tool-review", category: "tool", risk: "review", description: { en: "tool", "zh-CN": "工具", "zh-TW": "工具" }, packageUrl: "https://example.test/tool", capabilities: [] },
    { id: "prompt-low", source: "npm:prompt-low", name: "prompt-low", category: "prompt", risk: "low", description: { en: "prompt", "zh-CN": "提示词", "zh-TW": "提示詞" }, packageUrl: "https://example.test/prompt", capabilities: [] },
    { id: "skill-low", source: "npm:skill-low", name: "skill-low", category: "skill", risk: "low", description: { en: "skill", "zh-CN": "技能", "zh-TW": "技能" }, packageUrl: "https://example.test/skill", capabilities: [] },
  ];
  assert.deepEqual(
    filterCommunityPluginCatalog(entries).map((entry) => entry.id),
    ["skill-low", "prompt-low", "tool-review"],
  );
  assert.deepEqual(
    filterCommunityPluginCatalog(entries, "tool").map((entry) => entry.id),
    ["tool-review"],
  );
  assert.equal(sameCommunityPluginSource("npm:foo", "foo"), true);
  assert.equal(sameCommunityPluginSource("npm:foo", "npm:bar"), false);
});
