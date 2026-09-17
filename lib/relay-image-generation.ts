import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { getRelayBaseUrl } from "./relay-config";
import { readRelayGroups, type RelayGroupMetadata } from "./relay-group-store";
import { readStoredApiKey } from "./provider-credential-store";
import { readSessionImageModelSelection } from "./session-image-model-selection";
import type { SessionEntry } from "./types";

export const RELAY_IMAGE_PLUGIN_PACKAGE = "@amaster.ai/pi-image-gen";
export const RELAY_IMAGE_PLUGIN_SOURCE = `npm:${RELAY_IMAGE_PLUGIN_PACKAGE}`;

const MANAGED_PROVIDER_PREFIX = "magent-relay-";
const SETTINGS_KEY = "pi-image-gen";
const ACTIVE_MODEL_ENV = "MAGENT_RELAY_IMAGE_MODEL";
const ACTIVE_MODEL_PLACEHOLDER = `$${ACTIVE_MODEL_ENV}`;
const MANAGED_DEFAULT_KEY = "magentDefaultModel";

interface ImagePluginProvider {
  api: "openai";
  baseUrl: string;
  apiKey: string;
  name: string;
  models: Array<{ id: string; alias: string; name: string }>;
}

interface ImagePluginSettings {
  defaultModel?: string;
  magentDefaultModel?: string;
  outputDir?: string;
  customProviders?: Record<string, unknown>;
  [key: string]: unknown;
}

function configuredDefault(settings: ImagePluginSettings): string | undefined {
  if (settings.defaultModel === ACTIVE_MODEL_PLACEHOLDER || settings.defaultModel === `\${${ACTIVE_MODEL_ENV}}`) {
    return typeof settings.magentDefaultModel === "string" ? settings.magentDefaultModel : undefined;
  }
  return typeof settings.defaultModel === "string" ? settings.defaultModel : undefined;
}

export interface RelayImageModelStatus {
  providerId: string;
  groupName: string;
  modelId: string;
  alias: string;
  isDefault: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shortHash(value: string, length = 12): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

/**
 * Identify dedicated image-generation endpoints without treating multimodal
 * chat models as image generators. The rules intentionally cover provider-
 * neutral names used by relays (image/imagen/flux/seedream/etc.), not only
 * OpenAI's gpt-image family.
 */
export function isRelayImageGenerationModel(modelId: string): boolean {
  const id = modelId.trim().toLocaleLowerCase();
  if (!id) return false;
  if (id === "image" || id === "images" || id === "image-generation" || id === "image_gen") return true;
  return /(?:^|[-_.\/])(?:image|images|imagegen|image-gen|imagine)(?:$|[-_.\/])/i.test(id)
    || /^(?:dall-e|imagen|flux|stable-diffusion|sd3)(?:$|[-_.\/])/i.test(id)
    || /^(?:seedream|doubao-seedream|qwen-image)(?:$|[-_.\/])/i.test(id);
}

export function partitionRelayModelIds(modelIds: readonly string[]): {
  chatModelIds: string[];
  imageModelIds: string[];
} {
  const unique = [...new Set(modelIds.map((id) => id.trim()).filter(Boolean))];
  return {
    chatModelIds: unique.filter((id) => !isRelayImageGenerationModel(id)),
    imageModelIds: unique.filter(isRelayImageGenerationModel),
  };
}

export function relayImageProviderName(providerId: string): string {
  return `${MANAGED_PROVIDER_PREFIX}${shortHash(providerId, 10)}`;
}

export function relayImageModelAlias(providerId: string, modelId: string): string {
  const readable = modelId
    .toLocaleLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "image";
  return `meteor-${readable}-${shortHash(`${providerId}\0${modelId}`, 8)}`;
}

export function relayImageKeyEnvironmentName(providerId: string): string {
  return `MAGENT_RELAY_IMAGE_KEY_${shortHash(providerId).toUpperCase()}`;
}

function settingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "settings.json");
}

function readSettings(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isRecord(parsed)) throw new Error("Invalid settings.json: expected an object");
  return parsed;
}

function imageModels(groups: readonly RelayGroupMetadata[]): RelayImageModelStatus[] {
  return groups.flatMap((group) => (group.imageModels ?? []).map((modelId) => ({
    providerId: group.providerId,
    groupName: group.keyName || group.groupName || group.providerId,
    modelId,
    alias: relayImageModelAlias(group.providerId, modelId),
    isDefault: false,
  })));
}

function managedProviders(groups: readonly RelayGroupMetadata[]): Record<string, ImagePluginProvider> {
  return Object.fromEntries(groups.flatMap((group) => {
    const models = group.imageModels ?? [];
    if (!models.length) return [];
    const provider: ImagePluginProvider = {
      // Meteor exposes every upstream image family through one OpenAI-compatible
      // relay endpoint. Model ids remain untouched, so future Grok/Gemini/Qwen
      // image models do not require a Magent release.
      api: "openai",
      baseUrl: `${getRelayBaseUrl()}/v1`,
      apiKey: `$${relayImageKeyEnvironmentName(group.providerId)}`,
      name: `流星 API · ${group.keyName || group.groupName || group.providerId}`,
      models: models.map((modelId) => ({
        id: modelId,
        alias: relayImageModelAlias(group.providerId, modelId),
        name: modelId,
      })),
    };
    return [[relayImageProviderName(group.providerId), provider]];
  }));
}

/** Keep only Magent-owned providers in sync while preserving user providers/settings. */
export function syncRelayImageGenerationSettings(
  groups: readonly RelayGroupMetadata[] = readRelayGroups(),
  agentDir = getAgentDir(),
): void {
  const file = settingsPath(agentDir);
  const settings = readSettings(file);
  const current = isRecord(settings[SETTINGS_KEY])
    ? { ...(settings[SETTINGS_KEY] as ImagePluginSettings) }
    : {} as ImagePluginSettings;
  const currentProviders = isRecord(current.customProviders) ? { ...current.customProviders } : {};
  const previousManagedAliases = new Set<string>();
  for (const [name, provider] of Object.entries(currentProviders)) {
    if (!name.startsWith(MANAGED_PROVIDER_PREFIX)) continue;
    if (isRecord(provider) && Array.isArray(provider.models)) {
      for (const model of provider.models) {
        if (isRecord(model) && typeof model.alias === "string") previousManagedAliases.add(model.alias);
      }
    }
    delete currentProviders[name];
  }

  const nextProviders = managedProviders(groups);
  Object.assign(currentProviders, nextProviders);
  const nextModels = imageModels(groups);
  const nextAliases = new Set(nextModels.map((model) => model.alias));
  const currentDefault = configuredDefault(current);
  const shouldChooseManagedDefault = !currentDefault
    || (previousManagedAliases.has(currentDefault) && !nextAliases.has(currentDefault))
    || (currentDefault.startsWith("meteor-") && !nextAliases.has(currentDefault));

  if (nextModels.length) {
    current.customProviders = currentProviders;
    if (!current.outputDir) current.outputDir = ".pi/images";
    current.magentDefaultModel = shouldChooseManagedDefault ? nextModels[0].alias : currentDefault;
    // pi-image-gen reads settings.json itself instead of Pi's SettingsManager.
    // An environment placeholder lets Magent provide one model only while a
    // particular session is loading, after which the extension keeps its own
    // immutable settings snapshot.
    current.defaultModel = ACTIVE_MODEL_PLACEHOLDER;
    settings[SETTINGS_KEY] = current;
  } else {
    if (Object.keys(currentProviders).length) current.customProviders = currentProviders;
    else delete current.customProviders;
    if (current.defaultModel === ACTIVE_MODEL_PLACEHOLDER) {
      if (currentDefault && !previousManagedAliases.has(currentDefault)) current.defaultModel = currentDefault;
      else delete current.defaultModel;
    } else if (currentDefault && previousManagedAliases.has(currentDefault)) {
      delete current.defaultModel;
    }
    delete current.magentDefaultModel;
    const meaningfulKeys = Object.keys(current).filter((key) => key !== "outputDir");
    if (meaningfulKeys.length) settings[SETTINGS_KEY] = current;
    else delete settings[SETTINGS_KEY];
  }

  const parent = dirname(file);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(file, JSON.stringify(settings, null, 2));
  chmodSync(file, 0o600);
}

const hydratedEnvironmentNames = new Set<string>();

/** Hydrate settings placeholders immediately before Pi loads extensions. */
export function hydrateRelayImageGenerationEnvironment(
  groups: readonly RelayGroupMetadata[] = readRelayGroups(),
  agentDir = getAgentDir(),
): void {
  const activeNames = new Set<string>();
  for (const group of groups) {
    if (!(group.imageModels?.length)) continue;
    const name = relayImageKeyEnvironmentName(group.providerId);
    activeNames.add(name);
    const key = readStoredApiKey(group.providerId, join(agentDir, "auth.json"));
    if (key) process.env[name] = key;
    else delete process.env[name];
  }
  for (const previous of hydratedEnvironmentNames) {
    if (!activeNames.has(previous)) delete process.env[previous];
  }
  hydratedEnvironmentNames.clear();
  for (const name of activeNames) hydratedEnvironmentNames.add(name);
  const defaultAlias = getRelayImageGenerationStatus(groups, agentDir).defaultAlias;
  if (defaultAlias) process.env[ACTIVE_MODEL_ENV] = defaultAlias;
  else delete process.env[ACTIVE_MODEL_ENV];
}

export function getRelayImageGenerationStatus(
  groups: readonly RelayGroupMetadata[] = readRelayGroups(),
  agentDir = getAgentDir(),
): { packageName: string; defaultAlias?: string; models: RelayImageModelStatus[] } {
  const settings = readSettings(settingsPath(agentDir));
  const imageSettings = isRecord(settings[SETTINGS_KEY]) ? settings[SETTINGS_KEY] : undefined;
  const defaultAlias = imageSettings && isRecord(imageSettings)
    ? configuredDefault(imageSettings as ImagePluginSettings)
    : undefined;
  return {
    packageName: RELAY_IMAGE_PLUGIN_PACKAGE,
    defaultAlias,
    models: imageModels(groups).map((model) => ({ ...model, isDefault: model.alias === defaultAlias })),
  };
}

export function setDefaultRelayImageModel(
  providerId: string,
  modelId: string,
  groups: readonly RelayGroupMetadata[] = readRelayGroups(),
  agentDir = getAgentDir(),
): RelayImageModelStatus {
  syncRelayImageGenerationSettings(groups, agentDir);
  const target = imageModels(groups).find((model) => model.providerId === providerId && model.modelId === modelId);
  if (!target) throw new Error("Image model is not available in the synchronized relay groups");
  const file = settingsPath(agentDir);
  const settings = readSettings(file);
  const imageSettings = isRecord(settings[SETTINGS_KEY]) ? { ...settings[SETTINGS_KEY] } : {};
  imageSettings.defaultModel = ACTIVE_MODEL_PLACEHOLDER;
  imageSettings[MANAGED_DEFAULT_KEY] = target.alias;
  settings[SETTINGS_KEY] = imageSettings;
  writePrivateFileAtomicSync(file, JSON.stringify(settings, null, 2));
  chmodSync(file, 0o600);
  return { ...target, isDefault: true };
}

let sessionLoadTail: Promise<void> = Promise.resolve();

/**
 * pi-image-gen loads settings directly from disk and snapshots them during an
 * extension reload. Serialize those short load windows and expose the selected
 * session alias through the settings placeholder. This keeps already-loaded
 * sessions independent without rewriting the shared settings file.
 */
export async function withRelayImageGenerationSession<T>(
  sessionManager: Pick<import("@earendil-works/pi-coding-agent").SessionManager, "getEntries">,
  operation: () => Promise<T>,
  groups: readonly RelayGroupMetadata[] = readRelayGroups(),
  agentDir = getAgentDir(),
): Promise<T> {
  const waitFor = sessionLoadTail;
  let release!: () => void;
  sessionLoadTail = new Promise<void>((resolve) => { release = resolve; });
  await waitFor;
  let globalAlias = process.env[ACTIVE_MODEL_ENV];
  try {
    hydrateRelayImageGenerationEnvironment(groups, agentDir);
    globalAlias = process.env[ACTIVE_MODEL_ENV];
    // A live SDK SessionManager always exposes getEntries(), but a few headless
    // integrations only provide the lifecycle methods needed by the wrapper.
    // Treat those as having no session override instead of failing the entire
    // extension-load window.
    const getEntries = (sessionManager as { getEntries?: () => unknown }).getEntries;
    const localEntries = typeof getEntries === "function" ? getEntries.call(sessionManager) : [];
    const local = readSessionImageModelSelection(localEntries as SessionEntry[]);
    const availableAliases = new Set(imageModels(groups).map((model) => model.alias));
    const effectiveAlias = local && availableAliases.has(local.alias) ? local.alias : globalAlias;
    if (effectiveAlias) process.env[ACTIVE_MODEL_ENV] = effectiveAlias;
    else delete process.env[ACTIVE_MODEL_ENV];
    return await operation();
  } finally {
    if (globalAlias) process.env[ACTIVE_MODEL_ENV] = globalAlias;
    else delete process.env[ACTIVE_MODEL_ENV];
    release();
  }
}
