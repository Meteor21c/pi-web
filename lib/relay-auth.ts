/**
 * meteor21c relay 账号认证封装（服务端模块，Node fetch）。
 *
 * 端点契约（源码级确认 2026-09-15，sub2api routes/auth.go + api_key_handler.go）：
 *   POST /api/v1/auth/login    { email, password } → data: { access_token, refresh_token?, expires_in, user }
 *   POST /api/v1/auth/refresh  { refresh_token }    → data: 同上（轮转，旧 refresh 失效）
 *   GET  /api/v1/auth/me       Bearer               → data: { id, email, username, role, balance, status, ... }
 *   GET  /api/v1/keys          Bearer（分页）        → data: { items: [{ key(明文), name, status, group_id, ... }] }
 *   POST /api/v1/keys          Bearer { name, ... }  → data: 新 key
 *
 * 响应统一为 { code?, message?, data? } 包装，这里做宽容解析（data ?? body）。
 * 错误统一归类为 RelayAuthError.kind，供路由与 UI 分别处理。
 * deps.fetch 可注入（单元测试用）。
 */
import { getRelayBaseUrl } from "./relay-config";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RelayUserInfo {
  id: number | string;
  email: string;
  username?: string;
  role?: string | number;
  balance?: number;
  status?: number | string;
}

export interface RelayLoginTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
}

export interface RelayKey {
  id?: number | string;
  key: string;
  name?: string;
  status?: number | string;
  group_id?: string | number;
}

export type RelayAuthErrorKind =
  | "invalid-credentials"
  | "captcha-required"
  | "network"
  | "relay-error";

export class RelayAuthError extends Error {
  kind: RelayAuthErrorKind;
  status?: number;
  constructor(kind: RelayAuthErrorKind, message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export interface RelayAuthDeps {
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
}

function fetcher(deps?: RelayAuthDeps): typeof globalThis.fetch {
  return deps?.fetch ?? fetch;
}

function base(deps?: RelayAuthDeps): string {
  return (deps?.baseUrl ?? getRelayBaseUrl()).replace(/\/+$/, "");
}

function unwrap(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === "object" && "data" in payload) {
    const data = (payload as { data?: unknown }).data;
    if (data && typeof data === "object") return data as Record<string, unknown>;
  }
  return (payload ?? {}) as Record<string, unknown>;
}

function classify(status: number): RelayAuthErrorKind {
  if (status === 401 || status === 403) return "invalid-credentials";
  if (status === 422 || status === 400) return "invalid-credentials";
  return "relay-error";
}

async function request(path: string, init: RequestInit, deps?: RelayAuthDeps): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetcher(deps)(`${base(deps)}${path}`, init);
  } catch (err) {
    throw new RelayAuthError("network", `Network error: ${err}`);
  }
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      (body && typeof body === "object" && "message" in body && typeof (body as { message?: unknown }).message === "string"
        ? (body as { message: string }).message
        : `HTTP ${res.status}`);
    throw new RelayAuthError(classify(res.status), message, res.status);
  }
  return unwrap(body);
}

/** POST /api/v1/auth/login —— 账号密码登录。 */
export async function relayLogin(email: string, password: string, deps?: RelayAuthDeps): Promise<RelayLoginTokens & { user?: RelayUserInfo }> {
  const data = await request(
    "/api/v1/auth/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    },
    deps,
  );
  const accessToken = typeof data.access_token === "string" ? data.access_token : "";
  if (!accessToken) throw new RelayAuthError("relay-error", "Login response missing access_token");
  return {
    accessToken,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    expiresIn: typeof data.expires_in === "number" ? data.expires_in : 24 * 3600,
    user: (data.user as RelayUserInfo | undefined) ?? undefined,
  };
}

/** POST /api/v1/auth/refresh —— 轮换取新 token 对。 */
export async function relayRefresh(refreshToken: string, deps?: RelayAuthDeps): Promise<RelayLoginTokens> {
  const data = await request(
    "/api/v1/auth/refresh",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    },
    deps,
  );
  const accessToken = typeof data.access_token === "string" ? data.access_token : "";
  if (!accessToken) throw new RelayAuthError("relay-error", "Refresh response missing access_token");
  return {
    accessToken,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    expiresIn: typeof data.expires_in === "number" ? data.expires_in : 24 * 3600,
  };
}

/** GET /api/v1/auth/me —— 校验 token 并取用户信息。 */
export async function relayFetchMe(accessToken: string, deps?: RelayAuthDeps): Promise<RelayUserInfo> {
  const data = await request(
    "/api/v1/auth/me",
    { headers: { Authorization: `Bearer ${accessToken}` } },
    deps,
  );
  return {
    id: (data.id as number | string) ?? "",
    email: (data.email as string) ?? "",
    username: data.username as string | undefined,
    role: data.role as string | number | undefined,
    balance: data.balance as number | undefined,
    status: data.status as number | string | undefined,
  };
}

/** GET /api/v1/keys —— 列出用户全部 key（明文）。 */
export async function relayListKeys(accessToken: string, deps?: RelayAuthDeps): Promise<RelayKey[]> {
  const data = await request(
    "/api/v1/keys?page_size=100",
    { headers: { Authorization: `Bearer ${accessToken}` } },
    deps,
  );
  const items = Array.isArray(data.items) ? data.items : [];
  return items
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && typeof (x as { key?: unknown }).key === "string")
    .map((x) => ({
      id: x.id as number | string | undefined,
      key: x.key as string,
      name: x.name as string | undefined,
      status: x.status as number | string | undefined,
      group_id: x.group_id as string | number | undefined,
    }));
}

/** POST /api/v1/keys —— 为用户创建新 key。 */
export async function relayCreateKey(accessToken: string, name: string, deps?: RelayAuthDeps): Promise<RelayKey> {
  const data = await request(
    "/api/v1/keys",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    },
    deps,
  );
  const key = typeof data.key === "string" ? data.key : "";
  if (!key) throw new RelayAuthError("relay-error", "Create-key response missing key");
  return { key, name: (data.name as string | undefined) ?? name, status: data.status as number | string | undefined };
}

// ---- 登录态文件（WebUI 写入，agent-pack CLI 读取做门禁） --------------------

export interface RelaySessionFile {
  email: string;
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken?: string;
  updatedAt: number;
}

async function sessionPath(): Promise<string> {
  // 动态 import（与 lib/relay-usage.ts 相同模式）：运行时解析 pi 的 agent 目录，
  // 纯 fetch 单元测试不触发 pi 依赖加载。
  const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
  return join(getAgentDir(), "meteoragent-session.json");
}

export async function readRelaySessionFile(): Promise<RelaySessionFile | null> {
  try {
    const file = await sessionPath();
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as RelaySessionFile;
    if (!parsed?.accessTokenExpiresAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeRelaySessionFile(session: RelaySessionFile): Promise<void> {
  const file = await sessionPath();
  const dir = file.slice(0, file.lastIndexOf("/"));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(session, null, 2), { encoding: "utf-8", mode: 0o600 });
  chmodSync(file, 0o600);
}

export async function clearRelaySessionFile(): Promise<void> {
  try {
    const file = await sessionPath();
    if (existsSync(file)) unlinkSync(file);
  } catch { /* best-effort */ }
}
