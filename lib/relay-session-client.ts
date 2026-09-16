import type { RelayUserInfo } from "./relay-auth";

export type RelaySessionStatus = "disabled" | "loading" | "authenticated" | "unauthenticated" | "error";
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
  const post = (path: string, body: object = {}) => request(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
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
    login: async (email: string, password: string): Promise<{ ok: boolean; message?: string }> => {
      const generation = ++epoch;
      try {
        const res = await post("/api/relay-auth/login", { email, password });
        const body = await res.json();
        if (generation !== epoch) return { ok: false, message: "session-changed" };
        if (res.ok && body.ok && body.user) {
          publish({ status: "authenticated", user: body.user, expired: false, error: null, generation });
          notifyOtherTabs();
          return { ok: true };
        }
        return { ok: false, message: body.message };
      } catch { return { ok: false, message: "network" }; }
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
