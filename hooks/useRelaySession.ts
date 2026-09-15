"use client";

/**
 * relay 登录会话 hook（品牌门禁用）。
 *
 * 实现契约（W-D 填充，AuthGate 依赖，勿改签名）：
 *   const { status, user, login, logout } = useRelaySession();
 *   status: "disabled"（门禁未启用，直通）| "loading" | "authenticated" | "unauthenticated"
 *   login(email, password) → { ok, message? }（内部走 POST /api/relay-auth/login，
 *     成功后设置本地会话状态；错误 message 已本地化）
 */
import { useCallback, useEffect, useState } from "react";
import type { RelayUserInfo } from "@/lib/relay-auth";

export type RelaySessionStatus = "disabled" | "loading" | "authenticated" | "unauthenticated";

export interface RelaySessionState {
  status: RelaySessionStatus;
  user: RelayUserInfo | null;
  /** true = 会话曾存在但 token 过期且刷新失败（登录页显示"会话已过期"提示）。 */
  expired: boolean;
  login: (email: string, password: string) => Promise<{ ok: boolean; message?: string }>;
  logout: () => Promise<void>;
}

const GATE_ENABLED = process.env.NEXT_PUBLIC_AUTH_GATE === "1";

export function useRelaySession(): RelaySessionState {
  const [status, setStatus] = useState<RelaySessionStatus>(GATE_ENABLED ? "loading" : "disabled");
  const [user, setUser] = useState<RelayUserInfo | null>(null);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    if (!GATE_ENABLED) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/relay-auth/me", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
        const body = (await res.json()) as { ok?: boolean; user?: RelayUserInfo; reason?: string };
        if (cancelled) return;
        if (body.ok && body.user) {
          setUser(body.user);
          setExpired(false);
          setStatus("authenticated");
        } else {
          setExpired(body.reason === "session-expired");
          setStatus("unauthenticated");
        }
      } catch {
        if (!cancelled) setStatus("unauthenticated");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    try {
      const res = await fetch("/api/relay-auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const body = (await res.json()) as { ok?: boolean; user?: RelayUserInfo; message?: string };
      if (body.ok && body.user) {
        setUser(body.user);
        setExpired(false);
        setStatus("authenticated");
        return { ok: true };
      }
      return { ok: false, message: body.message };
    } catch {
      return { ok: false, message: "network" };
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch("/api/relay-auth/logout", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    } catch { /* best-effort */ }
    setUser(null);
    setExpired(false);
    setStatus("unauthenticated");
  }, []);

  return { status, user, expired, login, logout };
}
