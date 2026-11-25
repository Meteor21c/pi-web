import assert from "node:assert/strict";
import test from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const {
  createSessionScopedSettingsManager,
  getPluginActivationMode,
  getSessionPluginEnabled,
  isDisabledPackage,
  readSessionPluginSelections,
  setPluginActivationMode,
  setPluginPackageDisabled,
  updateSessionPluginSelection,
} = await createJiti(import.meta.url).import("./plugin-activation.ts");

function makeSession(entries = []) {
  return {
    entries,
    getEntries() { return this.entries; },
    appendCustomEntry(type, data) {
      this.entries.push({ type: "custom", customType: type, data });
      return "entry";
    },
  };
}

test("activation mode defaults to global and can be persisted without losing package source", async () => {
  const manager = SettingsManager.inMemory({ packages: ["npm:one"] });
  assert.equal(getPluginActivationMode(manager.getGlobalSettings().packages[0]), "global");
  assert.equal(setPluginActivationMode(manager, "npm:one", "global", "session"), true);
  await manager.flush();
  const configured = manager.getGlobalSettings().packages[0];
  assert.equal(configured.source, "npm:one");
  assert.equal(configured.activationMode, "session");
  assert.equal(isDisabledPackage(configured), false);
});

test("disable and enable preserve session activation mode", async () => {
  const manager = SettingsManager.inMemory({ packages: [{ source: "npm:one", activationMode: "session" }] });
  assert.equal(setPluginPackageDisabled(manager, "npm:one", "global", true), true);
  await manager.flush();
  let configured = manager.getGlobalSettings().packages[0];
  assert.equal(configured.activationMode, "session");
  assert.equal(isDisabledPackage(configured), true);
  assert.equal(setPluginPackageDisabled(manager, "npm:one", "global", false), true);
  await manager.flush();
  configured = manager.getGlobalSettings().packages[0];
  assert.equal(configured.activationMode, "session");
  assert.equal(isDisabledPackage(configured), false);
});

test("disable and enable preserve explicit package resource filters", async () => {
  const manager = SettingsManager.inMemory({ packages: [{
    source: "npm:filtered",
    activationMode: "session",
    autoload: false,
    extensions: ["extensions/safe.ts"],
    skills: ["skills/review"],
    prompts: ["prompts/plan.md"],
    themes: [],
  }] });
  assert.equal(setPluginPackageDisabled(manager, "npm:filtered", "global", true), true);
  await manager.flush();
  assert.equal(isDisabledPackage(manager.getGlobalSettings().packages[0]), true);

  assert.equal(setPluginPackageDisabled(manager, "npm:filtered", "global", false), true);
  await manager.flush();
  const configured = manager.getGlobalSettings().packages[0];
  assert.equal(configured.activationMode, "session");
  assert.equal(configured.autoload, false);
  assert.deepEqual(configured.extensions, ["extensions/safe.ts"]);
  assert.deepEqual(configured.skills, ["skills/review"]);
  assert.deepEqual(configured.prompts, ["prompts/plan.md"]);
  assert.deepEqual(configured.themes, []);
  assert.equal("meteorAgentBeforeDisable" in configured, false);
});

test("session scoped settings exclude local-mode packages until selected", () => {
  const manager = SettingsManager.inMemory({ packages: [
    "npm:global",
    { source: "npm:local", activationMode: "session" },
  ] });
  const session = makeSession();
  const scoped = createSessionScopedSettingsManager(manager, session);
  let packages = scoped.getGlobalSettings().packages;
  assert.equal(packages.length, 2);
  assert.equal(isDisabledPackage(packages[0]), false);
  assert.equal(isDisabledPackage(packages[1]), true);

  updateSessionPluginSelection(session, "npm:local", "global", true);
  packages = scoped.getGlobalSettings().packages;
  assert.equal(isDisabledPackage(packages[1]), false);

  updateSessionPluginSelection(session, "npm:local", "global", false);
  packages = scoped.getGlobalSettings().packages;
  assert.equal(isDisabledPackage(packages[1]), true);
});

test("project package filtering is scoped separately from global packages", () => {
  const manager = SettingsManager.inMemory({ packages: [
    { source: "npm:global-local", activationMode: "session" },
  ] });
  manager.setProjectPackages([{ source: "npm:project-local", activationMode: "session" }]);
  const session = makeSession();
  const scoped = createSessionScopedSettingsManager(manager, session);
  assert.equal(isDisabledPackage(scoped.getGlobalSettings().packages[0]), true);
  assert.equal(isDisabledPackage(scoped.getProjectSettings().packages[0]), true);

  updateSessionPluginSelection(session, "npm:project-local", "project", true);
  assert.equal(isDisabledPackage(scoped.getGlobalSettings().packages[0]), true);
  assert.equal(isDisabledPackage(scoped.getProjectSettings().packages[0]), false);
});

test("Computer Use starts on for ordinary conversations and respects old session choices and global off", async () => {
  const source = "npm:@amaster.ai/pi-computer-use@0.1.17";
  const manager = SettingsManager.inMemory({ packages: [{ source, activationMode: "session" }] });
  manager.setProjectPackages([{ source, activationMode: "session" }]);
  const oldSession = makeSession();
  updateSessionPluginSelection(oldSession, "npm:another-tool", "global", true);
  const scoped = createSessionScopedSettingsManager(manager, oldSession);
  assert.equal(getSessionPluginEnabled(readSessionPluginSelections(oldSession), source, "global"), true);
  assert.equal(isDisabledPackage(scoped.getGlobalSettings().packages[0]), false);
  assert.equal(isDisabledPackage(scoped.getProjectSettings().packages[0]), true);

  updateSessionPluginSelection(oldSession, source, "global", false);
  assert.equal(getSessionPluginEnabled(readSessionPluginSelections(oldSession), source, "global"), false);
  assert.equal(isDisabledPackage(scoped.getGlobalSettings().packages[0]), true);

  updateSessionPluginSelection(oldSession, source, "global", true);
  assert.equal(isDisabledPackage(scoped.getGlobalSettings().packages[0]), false);
  setPluginPackageDisabled(manager, source, "global", true);
  await manager.flush();
  assert.equal(isDisabledPackage(scoped.getGlobalSettings().packages[0]), true);
});

test("an extension-enabled child does not inherit the Computer Use default", () => {
  const source = "npm:@amaster.ai/pi-computer-use";
  const manager = SettingsManager.inMemory({ packages: [
    { source, activationMode: "session" },
    { source: "npm:another-tool", activationMode: "session" },
  ] });
  const parent = makeSession();
  const scoped = createSessionScopedSettingsManager(manager, parent, { useStarterDefaults: false, onlyStarterDefaults: true });
  assert.equal(getSessionPluginEnabled(readSessionPluginSelections(parent), source, "global", false), false);
  assert.equal(isDisabledPackage(scoped.getGlobalSettings().packages[0]), true);
  assert.equal(isDisabledPackage(scoped.getGlobalSettings().packages[1]), false);

  updateSessionPluginSelection(parent, source, "global", true);
  assert.equal(isDisabledPackage(scoped.getGlobalSettings().packages[0]), false);
});

test("session-scoped settings bind SDK methods to the underlying manager", async () => {
  const manager = SettingsManager.inMemory({ packages: [
    { source: "npm:local", activationMode: "session" },
  ] });
  const scoped = createSessionScopedSettingsManager(manager, makeSession());

  // ResourceLoader invokes reload through the proxy, while callers may also
  // retain a method reference. Both paths must keep SettingsManager's `this`.
  const reload = scoped.reload;
  await assert.doesNotReject(() => reload());
  const setDefaultModel = scoped.setDefaultModel;
  setDefaultModel("bound-model");
  await manager.flush();
  assert.equal(scoped.getDefaultModel(), "bound-model");
});
