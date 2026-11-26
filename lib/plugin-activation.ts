import type {
  PackageSource,
  SettingsManager,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  appendSessionPluginSelection,
  readSessionPluginSelection,
  selectionKey,
  type SessionPluginScope,
  type SessionPluginSelection,
} from "./session-plugin-selection";
import { COMPUTER_USE_PLUGIN_SOURCE, sameNpmPackageSource } from "./builtin-plugin-definitions";

export type PluginActivationMode = "global" | "session";
export type PluginPackageScope = "global" | "project";

/** Extra package metadata owned by pi-web and ignored by the Pi SDK loader. */
type PackageObject = Exclude<PackageSource, string>;
export type PluginPackageSource = PackageObject & {
  activationMode?: PluginActivationMode;
  /** Distinguishes new user selections from the old unmarked Computer Use default. */
  meteorAgentActivationModeExplicit?: true;
  /** Exact SDK package entry saved while the package is globally disabled. */
  meteorAgentBeforeDisable?: PackageSource;
};

function isPackageObject(entry: PackageSource): entry is PackageObject {
  return typeof entry !== "string";
}

export function getPluginPackageSource(entry: PackageSource): string {
  return typeof entry === "string" ? entry : entry.source;
}

export function getPluginActivationMode(
  entry: PackageSource,
  scope: PluginPackageScope,
): PluginActivationMode {
  if (!isPackageObject(entry) || (entry as PluginPackageSource).activationMode !== "session") return "global";
  // The installer used to save just these two fields. Treat that exact legacy
  // default as global without rewriting settings or touching custom filters.
  if (scope === "global" && entry.source === COMPUTER_USE_PLUGIN_SOURCE && Object.keys(entry).length === 2) {
    return "global";
  }
  return "session";
}

export function getPackageEntries(
  settingsManager: SettingsManager,
  scope: PluginPackageScope,
): PackageSource[] {
  return scope === "project"
    ? settingsManager.getProjectSettings().packages ?? []
    : settingsManager.getGlobalSettings().packages ?? [];
}

export function findPluginPackageEntry(
  settingsManager: SettingsManager,
  source: string,
  scope: PluginPackageScope,
): PackageSource | undefined {
  return getPackageEntries(settingsManager, scope)
    .find((entry) => getPluginPackageSource(entry) === source);
}

function withActivationMode(entry: PackageSource, mode: PluginActivationMode): PackageSource {
  if (mode === "global") {
    if (typeof entry === "string") return entry;
    const rest = { ...(entry as PluginPackageSource) };
    delete rest.activationMode;
    delete rest.meteorAgentActivationModeExplicit;
    // Preserve a filtered package object when it contains explicit resource
    // patterns. A bare object carrying only our metadata can be simplified back
    // to the SDK's string form.
    if (Object.keys(rest).length === 1 && typeof rest.source === "string") return rest.source;
    return rest as PackageSource;
  }
  const objectEntry: PackageObject = typeof entry === "string"
    ? { source: entry }
    : { ...entry };
  return { ...objectEntry, activationMode: mode } as PluginPackageSource;
}

function makePackageDisabled(entry: PackageSource): PackageSource {
  const previous = typeof entry === "string"
    ? entry
    : (entry as PluginPackageSource).meteorAgentBeforeDisable ?? entry;
  const objectEntry: PackageObject = typeof entry === "string"
    ? { source: entry }
    : { ...entry };
  return {
    ...objectEntry,
    meteorAgentBeforeDisable: previous,
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
  } as PluginPackageSource;
}

function restoreDisabledPackage(entry: PackageSource): PackageSource {
  if (typeof entry === "string") return entry;
  const previous = (entry as PluginPackageSource).meteorAgentBeforeDisable;
  return previous ?? entry.source;
}

/**
 * Set the package's persisted activation policy. Returns false when the exact
 * source/scope is not configured. Session mode deliberately makes a package
 * available to the runtime (while the session snapshot supplies its selection)
 * so a user can subsequently enable it for a selected conversation.
 */
export function setPluginActivationMode(
  settingsManager: SettingsManager,
  source: string,
  scope: PluginPackageScope,
  mode: PluginActivationMode,
): boolean {
  const current = getPackageEntries(settingsManager, scope);
  let changed = false;
  const next = current.map((entry) => {
    if (getPluginPackageSource(entry) !== source) return entry;
    changed = true;
    let nextEntry = withActivationMode(entry, mode);
    // A disabled package cannot be activated per-session. Switching to local
    // mode is therefore also the explicit opt-in that restores its package
    // resources; users can still use the regular disable action afterwards.
    if (mode === "session" && isDisabledPackage(nextEntry)) {
      nextEntry = withActivationMode(restoreDisabledPackage(nextEntry), mode);
    }
    if (mode === "session" && isPackageObject(nextEntry) && isGlobalComputerUsePackage(source, scope)) {
      return { ...nextEntry, meteorAgentActivationModeExplicit: true } as PluginPackageSource;
    }
    return nextEntry;
  });
  if (!changed) return false;
  if (scope === "project") settingsManager.setProjectPackages(next);
  else settingsManager.setPackages(next);
  return true;
}

export function isDisabledPackage(entry: PackageSource): boolean {
  if (typeof entry === "string") return false;
  return (
    Array.isArray(entry.extensions) && entry.extensions.length === 0
    && Array.isArray(entry.skills) && entry.skills.length === 0
    && Array.isArray(entry.prompts) && entry.prompts.length === 0
    && Array.isArray(entry.themes) && entry.themes.length === 0
  );
}

/** Preserve pi-web activation metadata when the existing disable/enable API is used. */
export function setPluginPackageDisabled(
  settingsManager: SettingsManager,
  source: string,
  scope: PluginPackageScope,
  disabled: boolean,
): boolean {
  const current = getPackageEntries(settingsManager, scope);
  let changed = false;
  const next = current.map((entry): PackageSource => {
    if (getPluginPackageSource(entry) !== source) return entry;
    changed = true;
    if (disabled) return makePackageDisabled(entry);
    const mode = getPluginActivationMode(entry, scope);
    return withActivationMode(restoreDisabledPackage(entry), mode);
  });
  if (!changed) return false;
  if (scope === "project") settingsManager.setProjectPackages(next);
  else settingsManager.setPackages(next);
  return true;
}

function packageKey(source: string, scope: PluginPackageScope): string {
  return selectionKey(source, scope as SessionPluginScope);
}

export function readSessionPluginSelections(
  sessionManager: Pick<SessionManager, "getEntries"> | null,
): Map<string, boolean> {
  const selection = sessionManager ? readSessionPluginSelection(sessionManager.getEntries() as never) : undefined;
  return new Map((selection ?? []).map((plugin) => [packageKey(plugin.source, plugin.scope), plugin.enabled]));
}

function isGlobalComputerUsePackage(source: string, scope: PluginPackageScope): boolean {
  return scope === "global" && sameNpmPackageSource(COMPUTER_USE_PLUGIN_SOURCE, source);
}

export function sessionPluginEnabledByDefault(
  entry: PackageSource,
  scope: PluginPackageScope,
): boolean {
  // Preserve the old default within customized Computer Use session policies.
  return isPackageObject(entry)
    && getPluginActivationMode(entry, scope) === "session"
    && isGlobalComputerUsePackage(entry.source, scope)
    && !(entry as PluginPackageSource).meteorAgentActivationModeExplicit;
}

interface SessionPluginSettingsOptions {
  useStarterDefaults?: boolean;
  onlyStarterDefaults?: boolean;
}

export function isPluginEnabledForSession(
  entry: PackageSource,
  scope: PluginPackageScope,
  selected: ReadonlyMap<string, boolean>,
  { useStarterDefaults = true, onlyStarterDefaults = false }: SessionPluginSettingsOptions = {},
): boolean {
  if (isDisabledPackage(entry)) return false;
  const source = getPluginPackageSource(entry);
  const computerUse = isGlobalComputerUsePackage(source, scope);
  if (onlyStarterDefaults && !computerUse) return true;
  const sessionSelection = selected.get(packageKey(source, scope));
  if (getPluginActivationMode(entry, scope) === "session") {
    return sessionSelection ?? (useStarterDefaults && sessionPluginEnabledByDefault(entry, scope));
  }
  if (!computerUse) return true;
  // A saved session opt-out still applies after the built-in switches to global
  // activation. Extension-enabled children retain their prior opt-in default.
  return sessionSelection ?? (source !== COMPUTER_USE_PLUGIN_SOURCE || useStarterDefaults);
}

function filterPackageSettings(
  settings: ReturnType<SettingsManager["getGlobalSettings"]>,
  scope: PluginPackageScope,
  selected: Map<string, boolean>,
  options: SessionPluginSettingsOptions,
): ReturnType<SettingsManager["getGlobalSettings"]> {
  if (!settings.packages?.length) return settings;
  const packages = settings.packages.map((entry) => (
    isDisabledPackage(entry) || isPluginEnabledForSession(entry, scope, selected, options)
      ? entry
      : makePackageDisabled(entry)
  ));
  return { ...settings, packages };
}

/**
 * Give one AgentSession a dynamic settings view. The SDK's package manager
 * reads global/project settings directly, so a resource-loader override would
 * be too late (extension code would already have executed). Filtering package
 * entries here prevents local-mode extensions from loading at all. The view
 * reads the latest session custom entry on every call, allowing a normal
 * session reload to apply a pending toggle without hot-unloading anything.
 */
export function createSessionScopedSettingsManager(
  settingsManager: SettingsManager,
  sessionManager: Pick<SessionManager, "getEntries">,
  options: SessionPluginSettingsOptions = {},
): SettingsManager {
  return new Proxy(settingsManager, {
    get(target, property) {
      if (property === "getGlobalSettings") {
        return () => filterPackageSettings(
          target.getGlobalSettings(),
          "global",
          readSessionPluginSelections(sessionManager),
          options,
        );
      }
      if (property === "getProjectSettings") {
        return () => filterPackageSettings(
          target.getProjectSettings(),
          "project",
          readSessionPluginSelections(sessionManager),
          options,
        );
      }
      const value = Reflect.get(target, property, target);
      // SettingsManager methods read mutable instance fields (and should also
      // remain safe if a caller stores `reload`/another method before calling
      // it). Bind them to the real manager instead of the Proxy receiver.
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as SettingsManager;
}

export function updateSessionPluginSelection(
  sessionManager: Pick<SessionManager, "getEntries"> & {
    appendCustomEntry: (customType: string, data: unknown) => string;
  },
  source: string,
  scope: PluginPackageScope,
  enabled: boolean,
): SessionPluginSelection[] {
  const existing = readSessionPluginSelection(sessionManager.getEntries() as never) ?? [];
  const byKey = new Map(existing.map((plugin) => [packageKey(plugin.source, plugin.scope), plugin]));
  const next: SessionPluginSelection = { source, scope, enabled };
  byKey.set(packageKey(source, scope), next);
  const plugins = [...byKey.values()];
  appendSessionPluginSelection(sessionManager, plugins);
  return plugins;
}
