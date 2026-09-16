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
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

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
  current_concurrency?: number;
  usage_1d?: number;
  usage_5h?: number;
  usage_7d?: number;
  group?: {
    id?: number | string;
    name?: string;
    description?: string;
    platform?: string;
    rate_multiplier?: number;
    long_context_pricing_enabled?: boolean;
  };
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

function optionalFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function optionalId(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

async function request(path: string, init: RequestInit, deps?: RelayAuthDeps): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetcher(deps)(`${base(deps)}${path}`, { ...init, signal: AbortSignal.timeout(15_000), redirect: "error" });
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
    user: normalizeRelayUser(data.user),
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
  const user = normalizeRelayUser(data);
  if (!user) throw new RelayAuthError("relay-error", "Invalid account response");
  return user;
}

/** GET /api/v1/keys —— 列出用户全部 key（明文）。 */
export async function relayListKeys(accessToken: string, deps?: RelayAuthDeps): Promise<RelayKey[]> {
  const result: RelayKey[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= 100; page++) {
    const data = await request(
    `/api/v1/keys?page_size=100&page=${page}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    deps,
  );
  if (!Array.isArray(data.items)) throw new RelayAuthError("relay-error", "Invalid key list");
  const items = data.items;
  const mapped = items
    .map((x: Record<string, unknown>) => {
      if (!x || typeof x !== "object" || typeof x.key !== "string" || !x.key ||
        !["string", "number"].includes(typeof x.id) || !/^[a-zA-Z0-9_-]+$/.test(String(x.id)) || String(x.id).startsWith("sk-") || x.id === x.key) {
        throw new RelayAuthError("relay-error", "Key list contains an invalid public ID");
      }
      const id = String(x.id);
      if (seen.has(id)) throw new RelayAuthError("relay-error", "Key pagination repeated an ID");
      seen.add(id);
      return x;
    })
    .map((x) => {
      const group = x.group && typeof x.group === "object" && !Array.isArray(x.group)
        ? x.group as Record<string, unknown>
        : undefined;
      return {
        id: x.id as number | string | undefined,
        key: x.key as string,
        name: typeof x.name === "string" ? x.name : undefined,
        status: optionalId(x.status),
        group_id: optionalId(x.group_id),
        current_concurrency: optionalFiniteNumber(x.current_concurrency),
        usage_1d: optionalFiniteNumber(x.usage_1d),
        usage_5h: optionalFiniteNumber(x.usage_5h),
        usage_7d: optionalFiniteNumber(x.usage_7d),
        group: group ? {
          id: optionalId(group.id),
          name: typeof group.name === "string" ? group.name : undefined,
          description: typeof group.description === "string" ? group.description : undefined,
          platform: typeof group.platform === "string" ? group.platform : undefined,
          rate_multiplier: optionalFiniteNumber(group.rate_multiplier),
          long_context_pricing_enabled: typeof group.long_context_pricing_enabled === "boolean"
            ? group.long_context_pricing_enabled
            : undefined,
        } : undefined,
      };
    });
    result.push(...mapped);
    const total = typeof data.total === "number" ? data.total : undefined;
    if (data.total !== undefined && (total === undefined || !Number.isSafeInteger(total) || total < result.length)) {
      throw new RelayAuthError("relay-error", "Inconsistent key pagination total");
    }
    if (total !== undefined && result.length >= total) return result;
    if (items.length < 100) {
      if (total !== undefined && result.length < total) throw new RelayAuthError("relay-error", "Incomplete key list");
      return result;
    }
  }
  throw new RelayAuthError("relay-error", "Key pagination limit exceeded");
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
  /** Stable local account identity. Legacy single-session files omit this until migrated. */
  accountId?: string;
  generation?: string;
  email: string;
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken?: string;
  updatedAt: number;
  /** Last verified upstream profile; never exposed with a token. */
  user?: RelayUserInfo;
}

export interface RelayAccountSummary {
  accountId: string;
  email: string;
  username?: string;
  balance?: number;
  status?: number | string;
  accessTokenExpiresAt: number;
  updatedAt: number;
  user?: RelayUserInfo;
}

interface RelaySessionStoreFile {
  version: 2;
  activeAccountId: string | null;
  accounts: Record<string, RelaySessionFile>;
}

const relayAccountIdPattern = /^[a-zA-Z0-9_-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRelayAccountId(value: unknown): value is string {
  return typeof value === "string" && relayAccountIdPattern.test(value)
    && value !== "__proto__" && value !== "constructor" && value !== "prototype";
}

/** Matches the account ID used by relay group metadata without persisting an email as an identifier. */
export function relayAccountIdForEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 12);
}

function normalizeRelayUser(value: unknown): RelayUserInfo | undefined {
  if (!isRecord(value) || !["string", "number"].includes(typeof value.id)) return undefined;
  const email = typeof value.email === "string" ? value.email.trim() : "";
  if (!email) return undefined;
  return {
    id: value.id as string | number,
    email,
    username: typeof value.username === "string" ? value.username : undefined,
    role: optionalId(value.role),
    balance: optionalFiniteNumber(value.balance),
    status: optionalId(value.status),
  };
}

function normalizeRelaySession(value: unknown, forcedAccountId?: string): RelaySessionFile | null {
  if (!isRecord(value)) return null;
  const email = typeof value.email === "string" ? value.email.trim() : "";
  const accessToken = typeof value.accessToken === "string" ? value.accessToken : "";
  const accessTokenExpiresAt = optionalFiniteNumber(value.accessTokenExpiresAt);
  if (!email || !accessToken || accessTokenExpiresAt === undefined) return null;

  const cachedUser = normalizeRelayUser(value.user);
  const user = cachedUser && cachedUser.email.toLowerCase() === email.toLowerCase() ? cachedUser : undefined;
  const accountId = forcedAccountId ?? (isRelayAccountId(value.accountId) ? value.accountId : relayAccountIdForEmail(email));
  return {
    accountId,
    generation: typeof value.generation === "string" && value.generation ? value.generation : undefined,
    email,
    accessToken,
    accessTokenExpiresAt,
    refreshToken: typeof value.refreshToken === "string" && value.refreshToken ? value.refreshToken : undefined,
    updatedAt: optionalFiniteNumber(value.updatedAt) ?? 0,
    user,
  };
}

function emptyRelaySessionStore(): RelaySessionStoreFile {
  return { version: 2, activeAccountId: null, accounts: Object.create(null) as Record<string, RelaySessionFile> };
}

function newestRelayAccountId(accounts: Record<string, RelaySessionFile>): string | null {
  return Object.entries(accounts)
    .sort(([leftId, left], [rightId, right]) => right.updatedAt - left.updatedAt || leftId.localeCompare(rightId))[0]?.[0] ?? null;
}

function normalizeRelaySessionStore(value: unknown): { store: RelaySessionStoreFile; migrated: boolean } {
  if (isRecord(value) && value.version === 2 && isRecord(value.accounts)) {
    const accounts: Record<string, RelaySessionFile> = Object.create(null) as Record<string, RelaySessionFile>;
    let migrated = false;
    for (const [accountId, session] of Object.entries(value.accounts)) {
      if (!isRelayAccountId(accountId)) {
        migrated = true;
        continue;
      }
      const normalized = normalizeRelaySession(session, accountId);
      if (!normalized) {
        migrated = true;
        continue;
      }
      accounts[accountId] = normalized;
      if (!isRecord(session) || session.accountId !== accountId) migrated = true;
    }
    const requestedActive = isRelayAccountId(value.activeAccountId) ? value.activeAccountId : null;
    const activeAccountId = requestedActive && accounts[requestedActive]
      ? requestedActive
      : newestRelayAccountId(accounts);
    if (activeAccountId !== value.activeAccountId) migrated = true;
    return { store: { version: 2, activeAccountId, accounts }, migrated };
  }

  const legacy = normalizeRelaySession(value);
  if (!legacy?.accountId) return { store: emptyRelaySessionStore(), migrated: false };
  return {
    store: { version: 2, activeAccountId: legacy.accountId, accounts: { [legacy.accountId]: legacy } },
    migrated: true,
  };
}

async function sessionPath(): Promise<string> {
  // 动态 import（与 lib/relay-usage.ts 相同模式）：运行时解析 pi 的 agent 目录，
  // 纯 fetch 单元测试不触发 pi 依赖加载。
  const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
  return join(getAgentDir(), "meteoragent-session.json");
}

async function writeRelaySessionStore(store: RelaySessionStoreFile): Promise<void> {
  const file = await sessionPath();
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(store, null, 2), { encoding: "utf-8", mode: 0o600 });
  renameSync(temporary, file);
  chmodSync(file, 0o600);
}

async function readRelaySessionStore(): Promise<RelaySessionStoreFile> {
  try {
    const file = await sessionPath();
    if (!existsSync(file)) return emptyRelaySessionStore();
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const { store, migrated } = normalizeRelaySessionStore(parsed);
    // A read remains useful even when the one-time migration write cannot be
    // completed (for example, a transient permissions/lock failure).
    if (migrated) {
      try { await writeRelaySessionStore(store); } catch { /* retry on the next write */ }
    }
    return store;
  } catch {
    return emptyRelaySessionStore();
  }
}

function existingRelayAccountId(store: RelaySessionStoreFile, session: RelaySessionFile): string {
  if (isRelayAccountId(session.accountId) && store.accounts[session.accountId]) return session.accountId;
  const canonicalEmail = session.email.trim().toLowerCase();
  const byEmail = Object.entries(store.accounts).find(([, candidate]) => candidate.email.toLowerCase() === canonicalEmail)?.[0];
  return byEmail ?? (isRelayAccountId(session.accountId) ? session.accountId : relayAccountIdForEmail(session.email));
}

function upsertRelaySession(store: RelaySessionStoreFile, input: RelaySessionFile, activate: boolean): RelaySessionFile | null {
  const accountId = existingRelayAccountId(store, input);
  const existing = store.accounts[accountId];
  const normalized = normalizeRelaySession({ ...existing, ...input, accountId }, accountId);
  if (!normalized) return null;
  store.accounts[accountId] = normalized;
  if (activate || !store.activeAccountId || !store.accounts[store.activeAccountId]) store.activeAccountId = accountId;
  return normalized;
}

async function replaceRelaySessionIfCurrent(previous: RelaySessionFile, next: RelaySessionFile): Promise<boolean> {
  const accountId = next.accountId ?? previous.accountId;
  if (!accountId) return false;
  const store = await readRelaySessionStore();
  const current = store.accounts[accountId];
  if (!sameRelayAccount(current, previous)) return false;
  const normalized = normalizeRelaySession({ ...current, ...next, accountId }, accountId);
  if (!normalized) return false;
  store.accounts[accountId] = normalized;
  await writeRelaySessionStore(store);
  return true;
}

function removeRelayAccountFromStore(store: RelaySessionStoreFile, accountId: string): boolean {
  if (!store.accounts[accountId]) return false;
  delete store.accounts[accountId];
  if (store.activeAccountId === accountId) store.activeAccountId = newestRelayAccountId(store.accounts);
  return true;
}

/** Read a requested account, or the active account when no ID is supplied. */
export async function readRelaySessionFile(accountId?: string): Promise<RelaySessionFile | null> {
  if (accountId !== undefined && !isRelayAccountId(accountId)) return null;
  const store = await readRelaySessionStore();
  const targetAccountId = accountId ?? store.activeAccountId;
  return targetAccountId ? store.accounts[targetAccountId] ?? null : null;
}

/**
 * Compatibility writer for older callers. It retains other accounts and makes
 * the written account active, matching the old single-session behavior.
 */
export async function writeRelaySessionFile(session: RelaySessionFile): Promise<void> {
  await withRelaySessionMutation(async () => {
    const store = await readRelaySessionStore();
    if (!upsertRelaySession(store, session, true)) return;
    await writeRelaySessionStore(store);
  });
}

/** Remove one account (or the active account), retaining every other login. */
export async function clearRelaySessionFile(accountId?: string): Promise<void> {
  if (accountId !== undefined && !isRelayAccountId(accountId)) return;
  invalidateRelayOperations();
  await withRelaySessionMutation(async () => {
    const store = await readRelaySessionStore();
    const targetAccountId = accountId ?? store.activeAccountId;
    if (!targetAccountId || !removeRelayAccountFromStore(store, targetAccountId)) return;
    await writeRelaySessionStore(store);
    try {
      const { removeRelayAccountConfiguration } = await import("./relay-group-store");
      await removeRelayAccountConfiguration(targetAccountId);
    } catch {
      // Authentication state is already cleared; stale provider cleanup can be retried by sync.
    }
  });
}

type AuthState = { epoch: number; tail: Promise<unknown>; checks: Map<string, Promise<Record<string, unknown>>> };
const authGlobal = globalThis as typeof globalThis & { __meteorRelayAuth?: AuthState };
const authState = authGlobal.__meteorRelayAuth ??= { epoch: 0, tail: Promise.resolve(), checks: new Map() };
export function relayOperationEpoch(): number { return authState.epoch; }
export function invalidateRelayOperations(): number { return ++authState.epoch; }
export function withRelaySessionMutation<T>(work: () => Promise<T>): Promise<T> {
  const task = authState.tail.then(work, work);
  authState.tail = task.catch(() => {});
  return task;
}
export function sameRelayAccount(a: RelaySessionFile | null, b: RelaySessionFile): boolean {
  if (!a) return false;
  if (a.accountId && b.accountId) {
    if (a.accountId !== b.accountId) return false;
  } else if (a.email.trim().toLowerCase() !== b.email.trim().toLowerCase()) {
    return false;
  }
  return (a.generation ?? a.accessToken) === (b.generation ?? b.accessToken);
}

export async function commitRelayLogin(session: RelaySessionFile, epoch: number): Promise<boolean> {
  return withRelaySessionMutation(async () => {
    if (epoch !== authState.epoch) return false;
    const store = await readRelaySessionStore();
    const committed = upsertRelaySession(store, { ...session, generation: randomUUID() }, true);
    if (!committed || epoch !== authState.epoch) return false;
    await writeRelaySessionStore(store);
    return true;
  });
}

/** Token-free account list for account selection UI. */
export async function listRelayAccounts(): Promise<{ accounts: RelayAccountSummary[]; activeAccountId: string | null }> {
  const store = await readRelaySessionStore();
  const accounts = Object.entries(store.accounts)
    .map(([accountId, session]) => ({
      accountId,
      email: session.email,
      username: session.user?.username,
      balance: session.user?.balance,
      status: session.user?.status,
      accessTokenExpiresAt: session.accessTokenExpiresAt,
      updatedAt: session.updatedAt,
      user: session.user,
    }))
    .sort((left, right) => Number(right.accountId === store.activeAccountId) - Number(left.accountId === store.activeAccountId)
      || right.updatedAt - left.updatedAt || left.accountId.localeCompare(right.accountId));
  return { accounts, activeAccountId: store.activeAccountId };
}

/** One validation/refresh per session across routes and tabs (survives HMR). */
export async function checkRelaySession(accountId?: string): Promise<Record<string, unknown>> {
  const session = await readRelaySessionFile(accountId);
  if (!session) return { ok: false, reason: "unauthenticated" };
  const epoch = authState.epoch;
  const id = `${epoch}:${session.accountId ?? relayAccountIdForEmail(session.email)}:${session.generation ?? session.accessToken}:${session.updatedAt}`;
  const pending = authState.checks.get(id);
  if (pending) return pending;
  const task = validate();
  authState.checks.set(id, task);
  try { return await task; } finally { if (authState.checks.get(id) === task) authState.checks.delete(id); }

  async function validate(): Promise<Record<string, unknown>> {
    let current = session!;
    let refreshed = false;
    const active = async () => epoch === authState.epoch && sameRelayAccount(await readRelaySessionFile(current.accountId), current);
    try {
      let user: RelayUserInfo;
      try { user = await relayFetchMe(current.accessToken); }
      catch (error) {
        if (!(error instanceof RelayAuthError) || ![401, 403].includes(error.status ?? 0) || !current.refreshToken) throw error;
        const tokens = await relayRefresh(current.refreshToken);
        const saved = await withRelaySessionMutation(async () => {
          if (!(await active())) return false;
          const previous = current;
          current = { ...current, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? current.refreshToken,
            accessTokenExpiresAt: Date.now() + tokens.expiresIn * 1000, updatedAt: Date.now() };
          return replaceRelaySessionIfCurrent(previous, current);
        });
        if (!saved) return { ok: false, reason: "unauthenticated" };
        refreshed = true;
        user = await relayFetchMe(current.accessToken);
      }
      if (!(await active())) return { ok: false, reason: "unauthenticated" };
      await withRelaySessionMutation(async () => {
        if (!(await active())) return;
        const previous = current;
        const next = { ...current, user };
        if (await replaceRelaySessionIfCurrent(previous, next)) current = next;
      });
      return await active() ? { ok: true, user, refreshed } : { ok: false, reason: "unauthenticated" };
    } catch (error) {
      if (!(await active())) return { ok: false, reason: "unauthenticated" };
      if (error instanceof RelayAuthError && [400, 401, 403].includes(error.status ?? 0)) {
        await withRelaySessionMutation(async () => {
          if (!(await active())) return;
          invalidateRelayOperations();
          const store = await readRelaySessionStore();
          if (current.accountId && removeRelayAccountFromStore(store, current.accountId)) {
            await writeRelaySessionStore(store);
            try {
              const { removeRelayAccountConfiguration } = await import("./relay-group-store");
              await removeRelayAccountConfiguration(current.accountId);
            } catch {
              // Authentication state is already cleared; stale provider cleanup is best effort.
            }
          }
        });
        return { ok: false, reason: "session-expired" };
      }
      if (current.accessTokenExpiresAt > Date.now()) return { ok: true, user: current.user ?? { email: current.email }, offlineGrace: true, refreshed };
      return { ok: false, reason: error instanceof RelayAuthError && error.kind === "network" ? "network" : "relay-error" };
    }
  }
}
