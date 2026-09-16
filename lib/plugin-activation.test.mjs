import assert from "node:assert/strict";
import test from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const {
  createSessionScopedSettingsManager,
  getPluginActivationMode,
  isDisabledPackage,
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
