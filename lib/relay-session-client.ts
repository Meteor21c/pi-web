import type { RelayUserInfo } from "./relay-auth";

export type RelaySessionStatus = "disabled" | "loading" | "authenticated" | "unauthenticated" | "error";
export type BrowserLoginResult =
  | { status: "started"; id: string; verificationUrl: string; userCode: string; expiresIn: number; interval: number }
  | { status: "authenticated"; accountId: string }
  | { status: "pending" | "cancelled" | "expired" | "denied" | "unavailable" }
  | { status: "error"; message?: string };

export function relayLoginMessageKey(message?: string): string {
  switch (message) {
    case "invalid-credentials": return "brand.auth.loginFailed";
    case "captcha-required": return "brand.auth.captchaRequired";
    case "second-factor-required": return "brand.auth.secondFactorRequired";
    case "rate-limited": return "brand.auth.rateLimited";
    case "network": return "brand.auth.networkError";
    case "session-changed":
    case "login-cancelled": return "brand.auth.browserCancelled";
    default: return "brand.auth.relayError";
  }
}

interface Snapshot {
  status: RelaySessionStatus;
  user: RelayUserInfo | null;
  expired: boolean;
  error: string | null;
  generation: number;
}

/** Tab-local single flight; server generation is authoritative across tabs. */
export function createRelaySessionClient(enabled: boolean, request: typeof fetch = (...args) => fetch(...args)) {
  const initial: Snapshot = { status: enabled ? "loading" : "disabled", user: null, expired: false, error: null, generation: 0 };
  let snapshot = initial;
  let initialized = false;
  let epoch = 0;
  let pending: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: Snapshot) => { snapshot = next; listeners.forEach((listener) => listener()); };
  const notifyOtherTabs = () => {
    try { window.localStorage.setItem("relay-session-changed", String(Date.now()) + Math.random()); } catch { /* storage is optional */ }
  };
  const post = (path: string, body: object = {}, signal?: AbortSignal) => request(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  });
  const acceptLogin = (body: { ok?: boolean; user?: RelayUserInfo; accountId?: string }, generation: number) => {
    if (!body.ok || !body.user || typeof body.accountId !== "string" || !body.accountId) return null;
    publish({ status: "authenticated", user: body.user, expired: false, error: null, generation });
    notifyOtherTabs();
    return body.accountId;
  };
  const recheck = (): Promise<void> => {
    if (!enabled) return Promise.resolve();
    if (pending) return pending;
    const generation = ++epoch;
    publish({ ...snapshot, status: "loading", error: null, generation });
    const run = async () => {
      try {
        const res = await post("/api/relay-auth/me");
        const body = await res.json();
        if (generation !== epoch) return;
        if (res.ok && body.ok && body.user) {
          publish({ status: "authenticated", user: body.user, expired: false, error: null, generation });
        } else if (body.reason === "unauthenticated" || body.reason === "session-expired") {
          publish({ status: "unauthenticated", user: null, expired: body.reason === "session-expired", error: null, generation });
        } else {
          publish({ ...snapshot, status: "error", error: "network", generation });
        }
      } catch {
        if (generation === epoch) publish({ ...snapshot, status: "error", error: "network", generation });
      }
    };
    pending = run().finally(() => { pending = null; });
    return pending;
  };
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => initial,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    initialize: () => { if (initialized) return pending ?? Promise.resolve(); initialized = true; return recheck(); },
    recheck,
    login: async (email: string, password: string): Promise<{ ok: boolean; accountId?: string; message?: string }> => {
      const generation = ++epoch;
      try {
        const res = await post("/api/relay-auth/login", { email, password });
        const body = await res.json();
        if (generation !== epoch) return { ok: false, message: "session-changed" };
        const accountId = res.ok ? acceptLogin(body, generation) : null;
        if (accountId) return { ok: true, accountId };
        return { ok: false, message: body.message };
      } catch { return { ok: false, message: "network" }; }
    },
    browserLogin: async (action: "start" | "poll" | "cancel", id?: string, signal?: AbortSignal): Promise<BrowserLoginResult> => {
      const generation = epoch;
      try {
        const res = await post("/api/relay-auth/browser", { action, id }, signal);
        const body = await res.json();
        if (signal?.aborted || generation !== epoch) return { status: "cancelled" };
        if (!res.ok) return { status: "error", message: body.message };
        if (body.status === "authenticated") {
          const accountId = acceptLogin(body, ++epoch);
          return accountId ? { status: "authenticated", accountId } : { status: "error" };
        }
        return body as BrowserLoginResult;
      } catch {
        return signal?.aborted ? { status: "cancelled" } : { status: "error", message: "network" };
      }
    },
    logout: async (): Promise<void> => {
      const generation = ++epoch;
      const res = await post("/api/relay-auth/logout");
      if (!res.ok) throw new Error("logout-failed");
      const body = await res.json() as { nextSession?: { ok?: boolean; user?: RelayUserInfo } };
      if (generation !== epoch) return;
      if (body.nextSession?.ok && body.nextSession.user) {
        publish({ status: "authenticated", user: body.nextSession.user, expired: false, error: null, generation });
      } else {
        publish({ status: "unauthenticated", user: null, expired: false, error: null, generation });
      }
      notifyOtherTabs();
      if (typeof window !== "undefined") window.dispatchEvent(new Event("relay-config-updated"));
    },
  };
}
