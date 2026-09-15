/**
 * relay 配置写入核心（供 save/auto 两个路由复用）。
 * 抽出原因：route 模块只允许导出 HTTP handler，业务函数必须放 lib。
 */
import { resolveRelayModels, type RelayModelDef } from "./relay-models";
import { getRelayBaseUrl } from "./relay-config";
import { readModelsConfig, writeModelsConfig } from "./models-config-store";
import { storeProviderCredential, removeStoredCredentialIfType } from "./provider-credential-store";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type RelayFamily = "claude" | "gpt" | "other";

/** 按模型 id 主导家族判定协议通道（claude 系→anthropic / gpt 系→responses / 其余→completions）。 */
export function dominantFamily(modelIds: string[]): RelayFamily {
  const claude = modelIds.filter((id) => /claude/i.test(id)).length;
  const gpt = modelIds.filter((id) => /gpt|codex/i.test(id)).length;
  const rest = modelIds.length - claude - gpt;
  if (claude > 0 && claude >= gpt && claude >= rest) return "claude";
  if (gpt > 0 && gpt > claude && gpt >= rest) return "gpt";
  return "other";
}

export function protocolFor(family: RelayFamily): { api: string; baseUrl: string } {
  const base = getRelayBaseUrl();
  if (family === "claude") return { api: "anthropic-messages", baseUrl: base };
  return { api: family === "gpt" ? "openai-responses" : "openai-completions", baseUrl: `${base}/v1` };
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
 * 写入/更新单个 relay provider（models.json + auth.json 凭据）。
 * - providerId：`meteor21c`（手动贴 key）或 `meteor21c-k<keyId>`（密钥同步）
 * - models：该 key 实际可见目录经家族过滤后的模型定义
 */
export async function persistRelayProvider(opts: {
  providerId: string;
  displayName: string;
  apiKey: string;
  api: string;
  baseUrl: string;
  models: RelayModelDef[];
}): Promise<void> {
  const config = readModelsConfig();
  const providers = isRecord(config.providers)
    ? { ...config.providers }
    : ({} as Record<string, unknown>);

  providers[opts.providerId] = {
    name: opts.displayName,
    baseUrl: opts.baseUrl,
    api: opts.api,
    models: opts.models,
  };

  writeModelsConfig({ ...config, providers });
  await storeProviderCredential(opts.providerId, { type: "api_key", key: opts.apiKey });
}

/** 删除一个 relay provider（密钥同步清理已删除的 key 时使用）。 */
export async function removeRelayProvider(providerId: string): Promise<void> {
  const config = readModelsConfig();
  const providers = isRecord(config.providers)
    ? { ...config.providers }
    : ({} as Record<string, unknown>);
  if (providerId in providers) {
    delete providers[providerId];
    writeModelsConfig({ ...config, providers });
  }
  await removeStoredCredentialIfType(providerId, "api_key").catch(() => {});
}
