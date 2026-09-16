/** Account-scoped relay key synchronization. Full API keys never leave this server module. */
import { getRelayBaseUrl } from "./relay-config";
import { resolveMixedRelayModels } from "./relay-models";
import { readModelsConfig } from "./models-config-store";
import { persistRelayProvider, removeRelayProvider, dominantFamily, protocolFor } from "./relay-config-save";
import { testRelayConnection } from "./relay-config-test";
import {
  checkRelaySession,
  readRelaySessionFile,
  relayListKeys,
  RelayAuthError,
  relayOperationEpoch,
  sameRelayAccount,
  type RelayKey,
  type RelaySessionFile,
  withRelaySessionMutation,
} from "./relay-auth";
import {
  metadataForRelayKey,
  providerAccountSegment,
  readRelayGroups,
  replaceRelayGroupsForAccount,
  stableRelayAccountId,
  type RelayGroupMetadata,
} from "./relay-group-store";

type AccountSession = RelaySessionFile;

export interface RelayProviderSummary {
  providerId: string;
  displayName: string;
  family: "claude" | "gpt" | "other";
  accountId: string;
  keyId: string;
  maskedKey: string;
  groupId: number | string | undefined;
  groupName?: string;
  platform?: string;
  rateMultiplier?: number;
  longContextPricingEnabled?: boolean;
  modelCount: number;
}

export interface RelaySyncResult {
  ok: boolean;
  reason?: "unauthenticated" | "network" | "no-key" | "no-usable-key" | "save-failed";
  message?: string;
  accountId?: string;
  providers?: RelayProviderSummary[];
  totalModelCount?: number;
  warnings?: Array<{ providerId: string; reason: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providersNow(): Record<string, unknown> {
  const value = readModelsConfig().providers;
  return isRecord(value) ? value : {};
}

async function readSession(accountId?: string): Promise<AccountSession | null> {
  return readRelaySessionFile(accountId);
}

async function validateSession(accountId?: string): Promise<Record<string, unknown>> {
  return checkRelaySession(accountId);
}

function sessionAccountId(session: AccountSession, requested?: string): string {
  return session.accountId || requested || stableRelayAccountId(session.email);
}

function legacyProviderIds(keyId: string): string[] {
  return [`meteor21c-k${keyId}`, `meteor21c-k-k${keyId}`];
}

function providerIdFor(
  accountId: string,
  keyId: string,
  existing: Record<string, unknown>,
  indexed: RelayGroupMetadata[],
): string {
  const previous = indexed.find((entry) => entry.accountId === accountId && entry.keyId === keyId);
  if (previous) return previous.providerId;

  for (const candidate of legacyProviderIds(keyId)) {
    const owner = indexed.find((entry) => entry.providerId === candidate)?.accountId;
    if (Object.hasOwn(existing, candidate) && (!owner || owner === accountId)) return candidate;
  }

  const candidate = `meteor21c-a${providerAccountSegment(accountId)}-k${keyId}`;
  const owner = indexed.find((entry) => entry.providerId === candidate)?.accountId;
  if (!owner || owner === accountId) return candidate;
  const collision = stableRelayAccountId(`${accountId}:${keyId}`).slice(0, 8);
  return `${candidate}-${collision}`;
}

function displayNameFor(key: RelayKey): string {
  return key.name?.trim() || `key-${key.id}`;
}

function summaryFor(
  accountId: string,
  key: RelayKey,
  providerId: string,
  family: RelayProviderSummary["family"],
  modelCount: number,
): RelayProviderSummary {
  const metadata = metadataForRelayKey(accountId, providerId, key);
  return {
    providerId,
    displayName: metadata.keyName,
    family,
    accountId,
    keyId: metadata.keyId,
    maskedKey: metadata.maskedKey,
    groupId: metadata.groupId,
    groupName: metadata.groupName,
    platform: metadata.platform,
    rateMultiplier: metadata.rateMultiplier,
    longContextPricingEnabled: metadata.longContextPricingEnabled,
    modelCount,
  };
}

type SyncGlobal = { tasks: Map<string, Promise<RelaySyncResult>> };
const syncGlobal = globalThis as typeof globalThis & { __meteorRelaySync?: SyncGlobal };
const state = syncGlobal.__meteorRelaySync ??= { tasks: new Map() };

export async function syncRelayProviders(requestedAccountId?: string): Promise<RelaySyncResult> {
  let session = await readSession(requestedAccountId);
  if (session && session.accessTokenExpiresAt <= Date.now()) {
    const validation = await validateSession(requestedAccountId);
    if (!validation.ok) {
      return {
        ok: false,
        reason: validation.reason === "network" || validation.reason === "relay-error" ? "network" : "unauthenticated",
      };
    }
    session = await readSession(requestedAccountId);
  }
  if (!session?.accessToken) return { ok: false, reason: "unauthenticated" };

  const accountId = sessionAccountId(session, requestedAccountId);
  const epoch = relayOperationEpoch();
  const identity = `${epoch}:${accountId}:${session.generation ?? session.accessToken}`;
  const previous = state.tasks.get(identity);
  if (previous) return previous;
  const task = run(session, accountId, epoch);
  state.tasks.set(identity, task);
  try {
    return await task;
  } finally {
    if (state.tasks.get(identity) === task) state.tasks.delete(identity);
  }
}

async function run(session: AccountSession, accountId: string, epoch: number): Promise<RelaySyncResult> {
  let keys: Array<RelayKey & { id: number | string }>;
  try {
    const raw = await relayListKeys(session.accessToken);
    keys = raw.map((key) => ({ ...key, id: key.id! }));
  } catch (error) {
    return {
      ok: false,
      accountId,
      reason: error instanceof RelayAuthError && [401, 403].includes(error.status ?? 0) ? "unauthenticated" : "network",
    };
  }

  const initial = providersNow();
  const initialIndex = readRelayGroups();
  const gathered: Array<{
    key: RelayKey & { id: number | string };
    providerId: string;
    models: ReturnType<typeof resolveMixedRelayModels>;
    failure?: string;
  }> = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, keys.length) }, async () => {
    while (cursor < keys.length) {
      if (epoch !== relayOperationEpoch()) return;
      const key = keys[cursor++];
      const providerId = providerIdFor(accountId, String(key.id), initial, initialIndex);
      const test = await testRelayConnection(key.key);
      const models = test.ok ? resolveMixedRelayModels(test.modelIds ?? [], getRelayBaseUrl()) : [];
      gathered.push({ key, providerId, models, failure: !test.ok ? test.reason : !models.length ? "empty-catalog" : undefined });
    }
  }));

  return withRelaySessionMutation(async () => {
    const current = await readSession(accountId);
    if (epoch !== relayOperationEpoch() || !sameRelayAccount(current, session)) {
      return { ok: false, reason: "unauthenticated", accountId };
    }

    const summaries: RelayProviderSummary[] = [];
    const warnings: NonNullable<RelaySyncResult["warnings"]> = [];
    try {
      const nextMetadata = gathered.map(({ key, providerId }) => metadataForRelayKey(accountId, providerId, key));
      const presentProviderIds = new Set(nextMetadata.map((entry) => entry.providerId));

      for (const previous of initialIndex.filter((entry) => entry.accountId === accountId)) {
        if (!presentProviderIds.has(previous.providerId)) await removeRelayProvider(previous.providerId);
      }

      for (const item of gathered) {
        const { key, providerId, models, failure } = item;
        if (epoch !== relayOperationEpoch()) return { ok: false, reason: "unauthenticated", accountId };
        if (failure) {
          warnings.push({ providerId, reason: failure });
          if (failure === "invalid-key") await removeRelayProvider(providerId);
          continue;
        }
        const family = dominantFamily(models.map((model) => model.id));
        await persistRelayProvider({
          providerId,
          displayName: displayNameFor(key),
          apiKey: key.key,
          ...protocolFor(family),
          models,
        });
        summaries.push(summaryFor(accountId, key, providerId, family, models.length));
      }

      if (epoch !== relayOperationEpoch()) return { ok: false, reason: "unauthenticated", accountId };
      replaceRelayGroupsForAccount(accountId, nextMetadata);
    } catch {
      return {
        ok: false,
        reason: "save-failed",
        accountId,
        message: "Configuration could not be saved; retry synchronization.",
      };
    }

    if (!keys.length) return { ok: false, reason: "no-key", accountId, providers: [], totalModelCount: 0 };
    if (!summaries.length) {
      return { ok: false, reason: "no-usable-key", accountId, providers: [], totalModelCount: 0, warnings };
    }
    return {
      ok: true,
      accountId,
      providers: summaries,
      totalModelCount: summaries.reduce((count, provider) => count + provider.modelCount, 0),
      warnings,
    };
  });
}
