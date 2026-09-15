/**
 * relay 密钥同步核心：以"每个 API key = 一个 provider"为单位组织。
 *
 * 产品语义（用户要求）：客户在中转站创建 key 时选分组并命名，
 * 客户端按 key 的名字区分渠道、展示所属分组，数据与中转站实时一致。
 *
 * 协议判定不依赖分组名（分组名客户端拿不到，且名字会骗人——实测
 * 名为 "deepseek" 的 key 实际是 gemini 分组），而是按该 key 模型目录的
 * 主导家族判定：
 *   claude 主导 → anthropic-messages（baseUrl 根域名）
 *   gpt/codex 主导 → openai-responses（baseUrl 带 /v1）
 *   其他/混杂 → openai-completions（baseUrl 带 /v1）
 *
 * provider id 约定：
 *   - `meteor21c-k<keyId>`：由密钥同步管理（key 删除后随之清理）
 *   - `meteor21c`：手动贴 key（save 路由创建，同步不清理）
 */
import { getRelayBaseUrl, RELAY_MODELS_ENDPOINT } from "./relay-config";
import { resolveRelayModels } from "./relay-models";
import { readModelsConfig } from "./models-config-store";
import { persistRelayProvider, removeRelayProvider, dominantFamily, protocolFor } from "./relay-config-save";
import {
  readRelaySessionFile,
  relayListKeys,
  writeRelaySessionFile,
} from "./relay-auth";

const SYNC_PREFIX = "meteor21c-k";
const LEGACY_IDS = ["meteor21c-claude", "meteor21c-openai"];

export interface RelayKeyInfo {
  id: number | string;
  key: string;
  name?: string;
  status?: number | string;
  groupId?: number | string;
}

export interface RelayProviderSummary {
  providerId: string;
  displayName: string;
  family: "claude" | "gpt" | "other";
  groupId: number | string | undefined;
  modelCount: number;
}

export interface RelaySyncResult {
  ok: boolean;
  reason?: "unauthenticated" | "network" | "no-key" | "no-usable-key" | "save-failed";
  message?: string;
  providers?: RelayProviderSummary[];
  totalModelCount?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerIdFor(keyId: number | string): string {
  return `${SYNC_PREFIX}-k${keyId}`;
}

function displayNameFor(key: RelayKeyInfo): string {
  const name = key.name?.trim() || `key-${key.id}`;
  // 分组标记语言无关（G<id>）；分组名待 sub2api 暴露分组端点后替换。
  return key.groupId !== undefined ? `${name} · G${key.groupId}` : name;
}

/** 用某个 key 拉取它实际可见的模型目录（失败返回 null）。 */
async function fetchVisibleModelIds(apiKey: string): Promise<string[] | null> {
  try {
    const res = await fetch(`${getRelayBaseUrl()}${RELAY_MODELS_ENDPOINT}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as { data?: Array<{ id?: string }> } | null;
    const ids = (json && Array.isArray(json.data) ? json.data : [])
      .map((m) => String(m.id ?? ""))
      .filter(Boolean);
    return ids;
  } catch {
    return null;
  }
}

/**
 * 同步：keys → 每 key 实测可见目录 → 每 key 一个 provider → 增量写入/清理。
 * 全部 key 实测失败 → no-usable-key（前端引导去控制台检查）。
 */
export async function syncRelayProviders(): Promise<RelaySyncResult> {
  const session = await readRelaySessionFile();
  if (!session?.accessToken) {
    return { ok: false, reason: "unauthenticated" };
  }

  let keys: RelayKeyInfo[];
  try {
    const raw = await relayListKeys(session.accessToken);
    keys = raw.map((k) => ({
      id: k.id ?? k.key,
      key: k.key,
      name: k.name,
      status: k.status,
      groupId: k.group_id,
    }));
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Network error")) {
      return { ok: false, reason: "network" };
    }
    return { ok: false, reason: "unauthenticated" };
  }

  if (keys.length === 0) {
    return { ok: false, reason: "no-key" };
  }

  const summaries: RelayProviderSummary[] = [];
  const failures: string[] = [];

  // 清理：已删除 key 的 provider/凭据 + 旧格式固定 id（迁移）。
  const existing = readModelsConfig();
  const existingProviderIds = isRecord(existing.providers) ? Object.keys(existing.providers) : [];
  const staleIds = existingProviderIds.filter((id) => {
    const isSynced = id.startsWith(`${SYNC_PREFIX}-k`);
    const isLegacy = LEGACY_IDS.includes(id);
    const stillExists = keys.some((k) => providerIdFor(k.id) === id);
    return (isSynced && !stillExists) || (isLegacy && keys.length > 0);
  });
  for (const id of staleIds) {
    await removeRelayProvider(id);
  }

  // 每 key：实测可见目录 → 家族判定 → persist（内部写 models.json + 凭据）。
  for (const key of keys) {
    const modelIds = await fetchVisibleModelIds(key.key);
    if (!modelIds || modelIds.length === 0) {
      failures.push(`${displayNameFor(key)}: no visible models`);
      continue; // 该 key 不可用 → 跳过（不写入 provider）
    }
    const family = dominantFamily(modelIds);
    const { api, baseUrl } = protocolFor(family);
    const providerId = providerIdFor(key.id);
    await persistRelayProvider({
      providerId,
      displayName: displayNameFor(key),
      apiKey: key.key,
      api,
      baseUrl,
      models: resolveRelayModels(family, modelIds),
    });
    summaries.push({
      providerId,
      displayName: displayNameFor(key),
      family,
      groupId: key.groupId,
      modelCount: modelIds.length,
    });
  }

  if (summaries.length === 0) {
    return {
      ok: false,
      reason: "no-usable-key",
      message: failures.slice(0, 3).join("; "),
    };
  }

  // 会话文件保持最新（CLI 门禁读它）。
  await writeRelaySessionFile({
    email: session.email,
    accessToken: session.accessToken,
    accessTokenExpiresAt: session.accessTokenExpiresAt,
    refreshToken: session.refreshToken,
    updatedAt: Date.now(),
  }).catch(() => {});

  return {
    ok: true,
    providers: summaries,
    totalModelCount: summaries.reduce((sum, p) => sum + p.modelCount, 0),
  };
}
