import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import type { RelayKey } from "./relay-auth";

export interface RelayGroupMetadata {
  accountId: string;
  providerId: string;
  keyId: string;
  keyName: string;
  maskedKey: string;
  status?: number | string;
  groupId?: number | string;
  groupName?: string;
  platform?: string;
  rateMultiplier?: number;
  longContextPricingEnabled?: boolean;
  /** Exact first-tier max_tokens keyed by model id, sourced from the authenticated model plaza. */
  contextWindows?: Record<string, number>;
  /** Dedicated image-generation model ids exposed by this key. */
  imageModels?: string[];
  currentConcurrency?: number;
  usage1d?: number;
  usage5h?: number;
  usage7d?: number;
  syncedAt: number;
}

export interface SafeRelayKey {
  id: string;
  name: string;
  maskedKey: string;
  status?: number | string;
  groupId?: number | string;
  groupName?: string;
  platform?: string;
  rateMultiplier?: number;
  longContextPricingEnabled?: boolean;
  currentConcurrency?: number;
  usage1d?: number;
  usage5h?: number;
  usage7d?: number;
}

interface RelayGroupStoreFile {
  version: 1;
  groups: RelayGroupMetadata[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function groupStorePath(): string {
  return join(getAgentDir(), "meteoragent-groups.json");
}

function validMetadata(value: unknown): value is RelayGroupMetadata {
  if (!isRecord(value)) return false;
  return typeof value.accountId === "string" && value.accountId.length > 0
    && typeof value.providerId === "string" && value.providerId.length > 0
    && typeof value.keyId === "string" && value.keyId.length > 0
    && typeof value.keyName === "string"
    && typeof value.maskedKey === "string"
    && (value.imageModels === undefined || (Array.isArray(value.imageModels) && value.imageModels.every((model) => typeof model === "string" && model.length > 0)))
    && typeof value.syncedAt === "number" && Number.isFinite(value.syncedAt);
}

export function readRelayGroups(): RelayGroupMetadata[] {
  const file = groupStorePath();
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.groups)) return [];
    return parsed.groups.filter(validMetadata);
  } catch {
    return [];
  }
}

export function writeRelayGroups(groups: RelayGroupMetadata[]): void {
  const file = groupStorePath();
  const parent = dirname(file);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  const payload: RelayGroupStoreFile = { version: 1, groups };
  writePrivateFileAtomicSync(file, JSON.stringify(payload, null, 2));
  chmodSync(file, 0o600);
}

export function replaceRelayGroupsForAccount(accountId: string, groups: RelayGroupMetadata[]): void {
  const retained = readRelayGroups().filter((entry) => entry.accountId !== accountId);
  writeRelayGroups([...retained, ...groups.filter((entry) => entry.accountId === accountId)]);
}

export function removeRelayGroupsForAccount(accountId: string): RelayGroupMetadata[] {
  const all = readRelayGroups();
  const removed = all.filter((entry) => entry.accountId === accountId);
  if (removed.length) writeRelayGroups(all.filter((entry) => entry.accountId !== accountId));
  return removed;
}

/** Remove only providers whose ownership is proven by the private account index. */
export async function removeRelayAccountConfiguration(accountId: string): Promise<number> {
  const owned = readRelayGroups().filter((entry) => entry.accountId === accountId);
  if (!owned.length) return 0;
  const { removeRelayProvider } = await import("./relay-config-save");
  const providerIds = [...new Set(owned.map((entry) => entry.providerId))];
  for (const providerId of providerIds) await removeRelayProvider(providerId);
  removeRelayGroupsForAccount(accountId);
  const { syncRelayImageGenerationSettings, hydrateRelayImageGenerationEnvironment } = await import("./relay-image-generation");
  syncRelayImageGenerationSettings();
  hydrateRelayImageGenerationEnvironment();
  return providerIds.length;
}

export function stableRelayAccountId(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 12);
}

export function providerAccountSegment(accountId: string): string {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(accountId)
    ? accountId
    : createHash("sha256").update(accountId).digest("hex").slice(0, 12);
}

export function maskRelayKey(key: string): string {
  if (key.length <= 8) return `${key.slice(0, 2)}...${key.slice(-2)}`;
  const prefixLength = key.startsWith("sk-") ? 6 : 4;
  return `${key.slice(0, prefixLength)}...${key.slice(-4)}`;
}

export function safeRelayKey(key: RelayKey): SafeRelayKey {
  return {
    id: String(key.id),
    name: key.name?.trim() || `key-${key.id}`,
    maskedKey: maskRelayKey(key.key),
    status: key.status,
    groupId: key.group_id,
    groupName: key.group?.name,
    platform: key.group?.platform,
    rateMultiplier: key.group?.rate_multiplier,
    longContextPricingEnabled: key.group?.long_context_pricing_enabled,
    currentConcurrency: key.current_concurrency,
    usage1d: key.usage_1d,
    usage5h: key.usage_5h,
    usage7d: key.usage_7d,
  };
}

export function metadataForRelayKey(
  accountId: string,
  providerId: string,
  key: RelayKey,
  syncedAt = Date.now(),
  contextWindows?: Record<string, number>,
  imageModels?: string[],
): RelayGroupMetadata {
  const safe = safeRelayKey(key);
  return {
    accountId,
    providerId,
    keyId: safe.id,
    keyName: safe.name,
    maskedKey: safe.maskedKey,
    status: safe.status,
    groupId: safe.groupId,
    groupName: safe.groupName,
    platform: safe.platform,
    rateMultiplier: safe.rateMultiplier,
    longContextPricingEnabled: safe.longContextPricingEnabled,
    ...(contextWindows && Object.keys(contextWindows).length ? { contextWindows } : {}),
    ...(imageModels?.length ? { imageModels: [...new Set(imageModels)] } : {}),
    currentConcurrency: safe.currentConcurrency,
    usage1d: safe.usage1d,
    usage5h: safe.usage5h,
    usage7d: safe.usage7d,
    syncedAt,
  };
}
