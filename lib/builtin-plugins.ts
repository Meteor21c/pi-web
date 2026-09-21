import { existsSync, mkdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager,
  type ProgressEvent,
} from "@earendil-works/pi-coding-agent";
import type {
  BuiltinPluginInfo,
  BuiltinPluginsResponse,
  BuiltinPluginInstallState,
  PluginScope,
} from "./api-types";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { setPluginActivationMode } from "./plugin-activation";
import { getProjectTrustStatus } from "./project-trust";
import { withPluginOperationLock } from "./plugin-operation-lock";
import {
  BUILTIN_PLUGIN_DEFINITIONS,
  builtinRecommendedUpdateSource,
  npmPackageName,
  sameNpmPackageSource,
  type BuiltinPluginDefinition,
} from "./builtin-plugin-definitions";

const BUILTIN_STATE_VERSION = 1 as const;
const DEFAULT_NPM_REGISTRY = "https://registry.npmmirror.com";
const BUILTIN_STATE_FILE = "meteoragent-builtins.json";

type SavedBuiltinPlugin = Partial<Pick<
  BuiltinPluginInfo,
  | "state"
  | "configuredSource"
  | "configuredScope"
  | "installedPath"
  | "installedVersion"
  | "error"
  | "startedAt"
  | "finishedAt"
>> & { id: string };

interface SavedBuiltinState {
  version: typeof BUILTIN_STATE_VERSION;
  running: boolean;
  state: BuiltinPluginsResponse["state"];
  registry: string;
  currentPluginId?: string;
  startedAt?: string;
  finishedAt?: string;
  plugins: SavedBuiltinPlugin[];
}

type BuiltinBootstrapGlobal = {
  task?: Promise<BuiltinPluginsResponse>;
};

type ConfiguredPackage = ReturnType<DefaultPackageManager["listConfiguredPackages"]>[number];

const globalState = globalThis as typeof globalThis & {
  __magentBuiltinPluginBootstrap?: BuiltinBootstrapGlobal;
};

function statePath(): string {
  return join(getAgentDir(), BUILTIN_STATE_FILE);
}

function defaultRegistry(): string {
  const configured = process.env.METEORAGENT_NPM_REGISTRY?.trim();
  return configured || DEFAULT_NPM_REGISTRY;
}

function configuredNpmRegistry(cwd: string): string | undefined {
  const environmentRegistry = process.env.NPM_CONFIG_REGISTRY?.trim()
    || process.env.npm_config_registry?.trim();
  if (environmentRegistry) return environmentRegistry;

  const userConfig = process.env.NPM_CONFIG_USERCONFIG?.trim()
    || process.env.npm_config_userconfig?.trim();
  const candidates = [
    userConfig,
    join(homedir(), ".npmrc"),
    join(resolve(cwd), ".npmrc"),
  ].filter((path, index, paths): path is string => Boolean(path) && paths.indexOf(path) === index);
  for (const path of candidates) {
    try {
      const line = readFileSync(path, "utf8")
        .split(/\r?\n/)
        .find((entry) => /^\s*registry\s*=\s*\S+/i.test(entry) && !/^\s*[#;]/.test(entry));
      const match = line?.match(/^\s*registry\s*=\s*(\S+)/i);
      if (match?.[1]) return match[1].trim();
    } catch {
      // Missing .npmrc is the normal case.
    }
  }
  return undefined;
}

function registryForBootstrap(cwd: string): string {
  return configuredNpmRegistry(cwd) ?? defaultRegistry();
}

function packageInfo(
  definition: BuiltinPluginDefinition,
  saved?: SavedBuiltinPlugin,
): BuiltinPluginInfo {
  const { id, name, source, purpose, purposeEn, recommendedVersion, downloadsMonthly, officialUrl, repositoryUrl, requiresNetwork } = definition;
  return {
    id,
    name,
    source,
    purpose,
    purposeEn,
    recommendedVersion,
    downloadsMonthly,
    officialUrl,
    ...(repositoryUrl ? { repositoryUrl } : {}),
    requiresNetwork,
    state: saved?.state ?? "pending",
    ...(saved?.configuredSource ? { configuredSource: saved.configuredSource } : {}),
    ...(saved?.configuredScope ? { configuredScope: saved.configuredScope } : {}),
    ...(saved?.installedPath ? { installedPath: saved.installedPath } : {}),
    ...(saved?.installedVersion ? { installedVersion: saved.installedVersion } : {}),
    ...(saved?.error ? { error: saved.error } : {}),
    ...(saved?.startedAt ? { startedAt: saved.startedAt } : {}),
    ...(saved?.finishedAt ? { finishedAt: saved.finishedAt } : {}),
  };
}

function initialState(): SavedBuiltinState {
  return {
    version: BUILTIN_STATE_VERSION,
    running: false,
    state: "idle",
    registry: defaultRegistry(),
    plugins: BUILTIN_PLUGIN_DEFINITIONS.map(({ id }) => ({ id })),
  };
}

function readSavedState(): SavedBuiltinState {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), "utf8")) as Partial<SavedBuiltinState>;
    if (
      parsed.version !== BUILTIN_STATE_VERSION
      || !Array.isArray(parsed.plugins)
      || typeof parsed.registry !== "string"
    ) return initialState();
    const plugins = parsed.plugins.filter((plugin): plugin is SavedBuiltinPlugin => (
      Boolean(plugin)
      && typeof plugin === "object"
      && typeof plugin.id === "string"
    ));
    return {
      version: BUILTIN_STATE_VERSION,
      running: parsed.running === true,
      state: parsed.state === "running" || parsed.state === "ready" || parsed.state === "partial"
        ? parsed.state
        : "idle",
      registry: parsed.registry || defaultRegistry(),
      ...(typeof parsed.currentPluginId === "string" ? { currentPluginId: parsed.currentPluginId } : {}),
      ...(typeof parsed.startedAt === "string" ? { startedAt: parsed.startedAt } : {}),
      ...(typeof parsed.finishedAt === "string" ? { finishedAt: parsed.finishedAt } : {}),
      plugins,
    };
  } catch {
    return initialState();
  }
}

function saveState(state: SavedBuiltinState): void {
  const agentDir = getAgentDir();
  mkdirSync(agentDir, { recursive: true });
  writePrivateFileAtomicSync(statePath(), `${JSON.stringify(state, null, 2)}\n`);
}

function savedPlugin(state: SavedBuiltinState, id: string): SavedBuiltinPlugin | undefined {
  return state.plugins.find((plugin) => plugin.id === id);
}

function mergeSavedPlugin(state: SavedBuiltinState, next: BuiltinPluginInfo): void {
  const existing = savedPlugin(state, next.id);
  const value: SavedBuiltinPlugin = {
    ...(existing ?? { id: next.id }),
    id: next.id,
    state: next.state,
    ...(next.configuredSource ? { configuredSource: next.configuredSource } : {}),
    ...(next.configuredScope ? { configuredScope: next.configuredScope } : {}),
    ...(next.installedPath ? { installedPath: next.installedPath } : {}),
    ...(next.installedVersion ? { installedVersion: next.installedVersion } : {}),
    ...(next.error ? { error: next.error } : {}),
    ...(next.startedAt ? { startedAt: next.startedAt } : {}),
    ...(next.finishedAt ? { finishedAt: next.finishedAt } : {}),
  };
  // A successful retry must not keep presenting the previous error. Likewise,
  // a package that was removed should not retain a stale installed path.
  if (next.state !== "error" && next.state !== "conflict") delete value.error;
  if (next.state !== "ready") {
    delete value.installedPath;
    delete value.installedVersion;
  }
  const index = state.plugins.findIndex((plugin) => plugin.id === next.id);
  if (index === -1) state.plugins.push(value);
  else state.plugins[index] = value;
}

function readInstalledVersion(installedPath?: string): string | undefined {
  if (!installedPath) return undefined;
  try {
    const path = statSync(installedPath).isDirectory()
      ? join(installedPath, "package.json")
      : join(installedPath, "package.json");
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

function readInstalledPackageName(installedPath?: string): string | undefined {
  if (!installedPath) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(join(installedPath, "package.json"), "utf8")) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

function userPackageForDefinition(
  packages: readonly ConfiguredPackage[],
  definition: BuiltinPluginDefinition,
): ConfiguredPackage | undefined {
  return packages.find((pkg) => pkg.scope === "user" && sameNpmPackageSource(pkg.source, definition.source));
}

function conflictingPackageForDefinition(
  packages: readonly ConfiguredPackage[],
  definition: BuiltinPluginDefinition,
): ConfiguredPackage | undefined {
  const expectedName = npmPackageName(definition.source);
  if (!expectedName) return undefined;
  return packages.find((pkg) => (
    pkg.scope === "user"
    &&
    !sameNpmPackageSource(pkg.source, definition.source)
    && readInstalledPackageName(pkg.installedPath) === expectedName
  ));
}

function packageScope(scope: ConfiguredPackage["scope"]): PluginScope {
  return scope === "project" ? "project" : "global";
}

function inspectInstalled(
  cwd: string,
  saved: SavedBuiltinState,
): { state: SavedBuiltinState; packages: BuiltinPluginInfo[]; manager?: DefaultPackageManager; settings?: SettingsManager } {
  const agentDir = getAgentDir();
  const projectTrusted = getProjectTrustStatus(cwd, agentDir).trusted;
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted });
  const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
  let configured: ConfiguredPackage[] = [];
  try {
    configured = manager.listConfiguredPackages();
  } catch {
    // Keep the persisted installation state visible when npm is unavailable.
  }

  const packages = BUILTIN_PLUGIN_DEFINITIONS.map((definition) => {
    const savedPluginState = savedPlugin(saved, definition.id);
    const configuredPackage = userPackageForDefinition(configured, definition);
    const conflictingPackage = configuredPackage
      ? undefined
      : conflictingPackageForDefinition(configured, definition);
    const installedPath = configuredPackage?.installedPath;
    let state: BuiltinPluginInstallState = savedPluginState?.state ?? "pending";
    if (configuredPackage && installedPath) state = "ready";
    else if (configuredPackage && state !== "error") state = "missing";
    else if (conflictingPackage) state = "conflict";
    else if (!configuredPackage && state === "ready") state = "pending";
    const info = packageInfo(definition, {
      ...(configuredPackage || savedPluginState?.state === "error" || savedPluginState?.state === "conflict"
        ? (savedPluginState ?? { id: definition.id })
        : { id: definition.id }),
      state,
      ...(state !== "error" && state !== "conflict" ? { error: undefined } : {}),
      ...(configuredPackage ? {
        configuredSource: configuredPackage.source,
        configuredScope: packageScope(configuredPackage.scope),
      } : {}),
      ...(installedPath ? {
        installedPath,
        installedVersion: readInstalledVersion(installedPath),
      } : {}),
      ...(conflictingPackage ? {
        error: `检测到同名插件已由 ${conflictingPackage.source} 提供，未自动覆盖。`,
      } : {}),
    });
    return info;
  });
  return { state: saved, packages, manager, settings };
}

function responseFromState(
  saved: SavedBuiltinState,
  packages: BuiltinPluginInfo[],
): BuiltinPluginsResponse {
  const running = Boolean(globalState.__magentBuiltinPluginBootstrap?.task);
  const effectivePackages = packages.map((plugin) => {
    // A process restart during installation must not leave a misleading
    // spinner forever. The next explicit bootstrap call can retry it.
    if (!running && saved.running && plugin.state === "installing") {
      return {
        ...plugin,
        state: "error" as const,
        error: "上次基础能力准备被中断，请点击重试。",
      };
    }
    return plugin;
  });
  const allReady = effectivePackages.every((plugin) => plugin.state === "ready");
  const hasError = effectivePackages.some((plugin) => (
    plugin.state === "error" || plugin.state === "missing" || plugin.state === "conflict"
  ));
  const incomplete = effectivePackages.some((plugin) => plugin.state !== "ready");
  const completedCount = effectivePackages.filter((plugin) => plugin.state === "ready").length;
  return {
    version: BUILTIN_STATE_VERSION,
    running,
    state: running
      ? "running"
      : allReady
        ? "ready"
        : hasError || (saved.state === "ready" && incomplete)
          ? "partial"
          : saved.state,
    registry: saved.registry || defaultRegistry(),
    ...(running && saved.currentPluginId ? { currentPluginId: saved.currentPluginId } : {}),
    completedCount,
    totalCount: effectivePackages.length,
    ...(saved.startedAt ? { startedAt: saved.startedAt } : {}),
    ...(saved.finishedAt ? { finishedAt: saved.finishedAt } : {}),
    plugins: effectivePackages,
  };
}

export function getBuiltinPluginStatus(cwd = process.cwd()): BuiltinPluginsResponse {
  const saved = readSavedState();
  try {
    const inspected = inspectInstalled(cwd, saved);
    return responseFromState(saved, inspected.packages);
  } catch {
    return responseFromState(
      saved,
      BUILTIN_PLUGIN_DEFINITIONS.map((definition) => packageInfo(definition, savedPlugin(saved, definition.id))),
    );
  }
}

function npmCommandForBootstrap(settings: SettingsManager, cwd: string, registry: string): void {
  // Respect an explicit npm/pnpm/bun command. Only the product default is
  // filled in on first run, so advanced users retain complete control.
  if (settings.getNpmCommand()?.length) return;
  // A user's .npmrc or NPM_CONFIG_REGISTRY must win over Magent's convenient
  // mirror. Leaving npmCommand unset lets npm/pnpm/bun apply those settings.
  if (configuredNpmRegistry(cwd)) return;
  settings.setNpmCommand(["npm", `--registry=${registry}`, "--no-audit", "--no-fund"]);
}

function updateProgressState(
  saved: SavedBuiltinState,
  definition: BuiltinPluginDefinition,
  state: BuiltinPluginInstallState,
  patch: Partial<Pick<BuiltinPluginInfo, "configuredSource" | "configuredScope" | "installedPath" | "installedVersion" | "error" | "startedAt" | "finishedAt">> = {},
): void {
  mergeSavedPlugin(saved, packageInfo(definition, { id: definition.id, state, ...patch }));
  saveState(saved);
}

function progressFor(
  definition: BuiltinPluginDefinition,
  saved: SavedBuiltinState,
): (event: ProgressEvent) => void {
  return (event) => {
    if (!sameNpmPackageSource(event.source, definition.source)) return;
    if (event.type === "start" || event.type === "progress") {
      updateProgressState(saved, definition, "installing", { startedAt: new Date().toISOString() });
    }
  };
}

async function runBuiltinBootstrap(cwd: string, force = false): Promise<BuiltinPluginsResponse> {
  const saved = readSavedState();
  const startedAt = new Date().toISOString();
  const registry = registryForBootstrap(cwd);
  saved.running = true;
  saved.state = "running";
  saved.registry = registry;
  saved.startedAt = startedAt;
  delete saved.currentPluginId;
  delete saved.finishedAt;
  saveState(saved);

  let inspected: ReturnType<typeof inspectInstalled>;
  try {
    inspected = inspectInstalled(cwd, saved);
    npmCommandForBootstrap(inspected.settings!, cwd, registry);
    await inspected.settings!.flush();
  } catch (error) {
    saved.running = false;
    saved.state = "partial";
    saved.finishedAt = new Date().toISOString();
    for (const definition of BUILTIN_PLUGIN_DEFINITIONS) {
      updateProgressState(saved, definition, "error", { error: error instanceof Error ? error.message : String(error), finishedAt: saved.finishedAt });
    }
    saveState(saved);
    return getBuiltinPluginStatus(cwd);
  }

  for (const definition of BUILTIN_PLUGIN_DEFINITIONS) {
    saved.currentPluginId = definition.id;
    saveState(saved);
    let packages: ConfiguredPackage[];
    try {
      packages = inspected.manager!.listConfiguredPackages();
    } catch (error) {
      updateProgressState(saved, definition, "error", {
        error: error instanceof Error ? error.message : String(error),
        finishedAt: new Date().toISOString(),
      });
      continue;
    }
    const configured = userPackageForDefinition(packages, definition);
    // A previously-ready package that is no longer configured was removed by
    // the user. A catalog migration may install a newly introduced starter,
    // but must not silently restore older packages. Explicit Retry may do so.
    if (!force && !configured && savedPlugin(saved, definition.id)?.state === "ready") {
      continue;
    }
    const conflict = configured ? undefined : conflictingPackageForDefinition(packages, definition);
    if (conflict) {
      updateProgressState(saved, definition, "conflict", {
        error: `检测到同名插件已由 ${conflict.source} 提供，已保留现有版本。`,
        finishedAt: new Date().toISOString(),
      });
      continue;
    }
    updateProgressState(saved, definition, "installing", {
      startedAt: new Date().toISOString(),
      ...(configured ? {
        configuredSource: configured.source,
        configuredScope: packageScope(configured.scope),
      } : {}),
    });
    try {
      inspected.manager!.setProgressCallback(progressFor(definition, saved));
      if (configured) {
        // Never rewrite a user's pinned/ranged source. Repair only the missing
        // checkout, using exactly the source they configured.
        if (!configured.installedPath) {
          await inspected.manager!.install(configured.source, { local: configured.scope === "project" });
        } else {
          const recommendedSource = builtinRecommendedUpdateSource(
            definition,
            configured.source,
            readInstalledVersion(configured.installedPath),
          );
          if (recommendedSource) {
            // Install the exact version audited with this Magent release while
            // preserving the unpinned settings entry for later user updates.
            await inspected.manager!.install(recommendedSource);
          }
        }
      } else {
        // Unpinned official source: the user can update it later from the same
        // Installed view, and a future release does not need to vendor files.
        await inspected.manager!.installAndPersist(definition.source);
      }
      if (!configured && "activationMode" in definition && definition.activationMode === "session") {
        setPluginActivationMode(inspected.settings!, definition.source, "global", "session");
      }
      await inspected.settings!.flush();
      const refreshed = userPackageForDefinition(inspected.manager!.listConfiguredPackages(), definition);
      if (!refreshed?.installedPath) throw new Error("插件已配置，但安装目录尚未可用。");
      updateProgressState(saved, definition, "ready", {
        configuredSource: refreshed.source,
        configuredScope: packageScope(refreshed.scope),
        installedPath: refreshed.installedPath,
        installedVersion: readInstalledVersion(refreshed.installedPath),
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      updateProgressState(saved, definition, "error", {
        error: error instanceof Error ? error.message : String(error),
        finishedAt: new Date().toISOString(),
      });
      // A failed optional capability must not prevent the remaining starters
      // from being attempted or the main workspace from opening.
    } finally {
      inspected.manager!.setProgressCallback(undefined);
    }
  }

  saved.running = false;
  delete saved.currentPluginId;
  saved.finishedAt = new Date().toISOString();
  saved.state = saved.plugins.every((plugin) => plugin.state === "ready") ? "ready" : "partial";
  saveState(saved);
  return getBuiltinPluginStatus(cwd);
}

function recordUnexpectedBootstrapFailure(error: unknown): void {
  const saved = readSavedState();
  const message = error instanceof Error ? error.message : String(error);
  const finishedAt = new Date().toISOString();
  saved.running = false;
  saved.state = "partial";
  saved.finishedAt = finishedAt;
  for (const definition of BUILTIN_PLUGIN_DEFINITIONS) {
    const current = savedPlugin(saved, definition.id);
    // Preserve a package that was already ready or deliberately skipped due
    // to a source conflict. Only an interrupted/pending item needs an error
    // marker so the next launch cannot present a false endless spinner.
    if (current?.state === "ready" || current?.state === "conflict" || current?.state === "error") continue;
    mergeSavedPlugin(saved, packageInfo(definition, {
      id: definition.id,
      state: "error",
      error: message,
      finishedAt,
    }));
  }
  saveState(saved);
}

/**
 * Start (or join) the one global starter-package install. The promise is kept
 * in globalThis so Next.js hot reloads and duplicate browser requests cannot
 * start concurrent npm writes. Callers may await it, but the API intentionally
 * starts it in the background so a failed optional package never blocks chat.
 */
export function ensureBuiltinPlugins(
  cwd = process.cwd(),
  options: { force?: boolean } = {},
): Promise<BuiltinPluginsResponse> {
  const current = getBuiltinPluginStatus(cwd);
  const saved = readSavedState();
  const tracksEveryDefinition = BUILTIN_PLUGIN_DEFINITIONS.every((definition) => Boolean(savedPlugin(saved, definition.id)));
  if (!current.running && current.state === "ready") {
    if (!tracksEveryDefinition) {
      current.plugins.forEach((plugin) => mergeSavedPlugin(saved, plugin));
      saved.state = "ready";
      saveState(saved);
    }
    return Promise.resolve(current);
  }
  // A user may intentionally remove a starter package. Once the bootstrap has
  // completed successfully, a normal app start must not silently reinstall it;
  // the explicit Retry action passes force:true when the user wants it back.
  if (!options.force && !current.running && saved.state === "ready" && tracksEveryDefinition) return Promise.resolve(current);
  // A package from another source is deliberately left untouched. Once that
  // decision has been recorded, do not show a retry loop on every app launch;
  // the explicit Retry action can re-check after the user changes the package.
  if (!options.force && !current.running && saved.state === "partial"
    && current.plugins.every((plugin) => plugin.state === "ready" || plugin.state === "conflict")) {
    return Promise.resolve(current);
  }
  const existing = globalState.__magentBuiltinPluginBootstrap?.task;
  if (existing) return existing;
  const safeCwd = existsSync(cwd) ? cwd : process.cwd();
  const task = withPluginOperationLock(resolve(getAgentDir()), () => runBuiltinBootstrap(safeCwd, options.force === true)).catch((error) => {
    try {
      recordUnexpectedBootstrapFailure(error);
    } catch {
      // A filesystem failure should still leave the workspace usable; the
      // next status request can fall back to the in-memory package list.
    }
    console.error("[meteoragent] built-in plugin bootstrap failed:", error instanceof Error ? error.message : error);
    return getBuiltinPluginStatus(safeCwd);
  }).finally(() => {
    if (globalState.__magentBuiltinPluginBootstrap?.task === task) {
      globalState.__magentBuiltinPluginBootstrap = {};
    }
  });
  globalState.__magentBuiltinPluginBootstrap = { task };
  return task;
}

export function builtinBootstrapRunning(): boolean {
  return Boolean(globalState.__magentBuiltinPluginBootstrap?.task);
}
