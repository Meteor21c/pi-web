/**
 * relay 配置写入核心逻辑（从 app/api/relay-config/save/route.ts 抽出）。
 *
 * 抽出原因：route 模块只允许导出 HTTP handler；自动挑选路由与手动保存路由
 * 都要复用这段逻辑，放在 lib 里由两个路由共同 import。
 */
import { buildRelayProviderConfigs } from "./relay-models";
import { readModelsConfig, writeModelsConfig } from "./models-config-store";
import { storeProviderCredential } from "./provider-credential-store";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Format-only validation for a client-supplied relay base URL override. */
export function sanitizeBaseUrlOverride(base?: unknown): string | null {
  if (typeof base !== "string" || !base.trim()) return null;
  const trimmed = base.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    new URL(trimmed);
  } catch {
    return null;
  }
  return trimmed;
}

/**
 * Upsert the dual relay providers into models.json and persist the credential
 * for both provider ids. `baseOverride` (already sanitized) replaces the
 * env-derived baseUrl values when present. `remoteModelIds` (the key's actually
 * visible /v1/models catalog) narrows the written model lists so users cannot
 * pick models their plan cannot use.
 */
export async function persistRelayConfig(
  apiKey: string,
  baseOverride?: string | null,
  remoteModelIds?: string[],
): Promise<void> {
  const config = readModelsConfig();
  const providers = isRecord(config.providers)
    ? { ...config.providers }
    : ({} as Record<string, unknown>);

  Object.assign(providers, buildRelayProviderConfigs(remoteModelIds));

  // Responses channel keeps /v1, Claude channel uses the root domain.
  if (baseOverride) {
    const gpt = providers["meteor21c"];
    const claude = providers["meteor21c-claude"];
    if (isRecord(gpt)) gpt.baseUrl = `${baseOverride}/v1`;
    if (isRecord(claude)) claude.baseUrl = baseOverride;
  }

  writeModelsConfig({ ...config, providers });

  await storeProviderCredential("meteor21c", { type: "api_key", key: apiKey });
  await storeProviderCredential("meteor21c-claude", { type: "api_key", key: apiKey });
}
