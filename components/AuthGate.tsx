"use client";

/**
 * 品牌登录门禁（W-D 填充）。
 * 契约：<AuthGate>{ children }</AuthGate>
 * NEXT_PUBLIC_AUTH_GATE !== "1" 时直接放行（pi-web 主线默认无门禁）。
 * 启动校验 → 登录 → 渠道同步 → 直接进入工作区；校验中不挂载工作区。
 * 校验与自动配置阶段统一使用 BootSplash 品牌启动屏（合并原先先后闪现的两页）。
 */
import { useCallback, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useRelaySession } from "@/hooks/useRelaySession";
import { useI18n } from "@/hooks/useI18n";
import { RelayOnboarding, type RelayOnboardingPhase } from "./RelayOnboarding";
import { BootSplash } from "./BootSplash";

const GATE_ENABLED = process.env.NEXT_PUBLIC_AUTH_GATE === "1";

const REGISTER_URL = "https://api.meteor21c.fun";

function errorKeyToMessage(message?: string): string | null {
  switch (message) {
    case "invalid-credentials":
      return "brand.auth.loginFailed";
    case "captcha-required":
      return "brand.auth.captchaRequired";
    case "network":
      return "brand.auth.networkError";
    default:
      return null;
  }
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { status, expired, login, recheck, generation } = useRelaySession();
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [logoFailed, setLogoFailed] = useState(false);
  const [readyGeneration, setReadyGeneration] = useState<number | null>(null);
  const [onboardingPhase, setOnboardingPhase] = useState<RelayOnboardingPhase | null>(null);
  const enterWorkspace = useCallback(() => setReadyGeneration(generation), [generation]);

  if (!GATE_ENABLED || status === "disabled") {
    return <>{children}</>;
  }
  // No workspace effects or historical content until startup is complete.
  if (status === "loading" || status === "error") {
    return (
      <BootSplash progress={0.35} label={t(status === "loading" ? "brand.auth.checking" : "brand.auth.networkError")} error={status === "error"}>
        {status === "error" && (
          <button
            type="button"
            className="ui-send-btn"
            onClick={() => void recheck()}
            style={{
              border: "none",
              borderRadius: 999,
              padding: "9px 26px",
              background: "var(--accent)",
              color: "var(--accent-contrast)",
              cursor: "pointer",
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            {t("brand.auth.retry")}
          </button>
        )}
      </BootSplash>
    );
  }
  if (status === "authenticated") {
    if (readyGeneration === generation) return <>{children}</>;
    // busy（未上报首帧/auto）→ 启动屏遮罩；交互阶段 → 居中卡片。
    // RelayOnboarding 必须始终挂载：自动配置的同步在它的 effect 里驱动，
    // 若被条件渲染移除，同步永远不会执行、阶段也永远不会推进（会卡死在启动屏）。
    const busy = onboardingPhase === null || onboardingPhase === "auto";
    return (
      <div
        style={{
          height: "var(--vp-h, 100dvh)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: "var(--bg)",
          color: "var(--text)",
          position: "relative",
        }}
      >
        {busy && <BootSplash progress={0.75} label={t("brand.auth.autoSetup")} />}
        <div
          className="ui-msg-enter"
          aria-hidden={busy || undefined}
          style={{
            width: "100%",
            maxWidth: 520,
            padding: "28px 28px",
            borderRadius: 24,
            background: "var(--assistant-bg)",
            border: "0.5px solid color-mix(in srgb, var(--border) 70%, transparent)",
            boxShadow: "0 24px 60px rgba(0,0,0,0.14), 0 4px 16px rgba(0,0,0,0.06)",
            ...(busy ? {
              position: "absolute",
              visibility: "hidden",
              pointerEvents: "none",
            } : undefined),
          }}
        >
          <RelayOnboarding key={generation} onSuccess={enterWorkspace} onPhaseChange={setOnboardingPhase} />
        </div>
      </div>
    );
  }

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setErrorKey(null);
    try {
      const result = await login(email, password);
      if (result.ok) {
        setPassword("");
        return;
      }
      const mapped = errorKeyToMessage(result.message);
      setErrorKey(mapped ?? "brand.auth.loginFailed");
    } catch {
      setErrorKey("brand.auth.networkError");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "radial-gradient(120% 120% at 50% 0%, #1b2030 0%, #0d1018 60%)",
        color: "#e7e9ee",
        fontFamily: "var(--font-sans, ui-sans-serif, system-ui, sans-serif)",
      }}
    >
      <div
        className="ui-msg-enter"
        style={{
          width: "100%",
          maxWidth: 384,
          padding: "32px 28px",
          borderRadius: 24,
          background: "rgba(22, 26, 38, 0.92)",
          border: "1px solid rgba(255,255,255,0.08)",
          boxShadow: "0 24px 60px rgba(0,0,0,0.45)",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, marginBottom: 24 }}>
          {logoFailed ? (
            <div
              style={{
                width: 96,
                height: 96,
                borderRadius: 24,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 700,
                fontSize: 20,
                letterSpacing: 0.5,
                color: "#fff",
                background: "linear-gradient(135deg, #5b8cff 0%, #8a5bff 100%)",
              }}
            >
              MeteorAgent
            </div>
          ) : (
            <img
              src="/icons/logo.png"
              alt="MeteorAgent"
              style={{ width: 96, height: 96, borderRadius: 24, objectFit: "cover" }}
              onError={() => setLogoFailed(true)}
            />
          )}
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 20, fontWeight: 600 }}>{t("brand.auth.title")}</div>
            <div style={{ marginTop: 6, fontSize: 13, color: "rgba(231,233,238,0.65)" }}>
              {t("brand.auth.description")}
            </div>
          </div>
        </div>

        <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {expired && (
            <div
              role="status"
              style={{
                fontSize: 13,
                color: "#ffd48a",
                background: "rgba(255,190,90,0.12)",
                border: "1px solid rgba(255,190,90,0.28)",
                borderRadius: 10,
                padding: "8px 12px",
              }}
            >
              {t("brand.auth.sessionExpired")}
            </div>
          )}
          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, color: "rgba(231,233,238,0.8)" }}>
            {t("brand.auth.email")}
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              style={inputStyle}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, color: "rgba(231,233,238,0.8)" }}>
            {t("brand.auth.password")}
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              style={inputStyle}
            />
          </label>

          {errorKey && (
            <div
              role="alert"
              style={{
                fontSize: 13,
                color: "#ff9a9a",
                background: "rgba(255,90,90,0.12)",
                border: "1px solid rgba(255,90,90,0.25)",
                borderRadius: 10,
                padding: "8px 12px",
              }}
            >
              {t(errorKey)}
            </div>
          )}

          <button type="submit" disabled={submitting} className="ui-send-btn" style={buttonStyle(submitting)}>
            {submitting ? t("brand.auth.loggingIn") : t("brand.auth.login")}
          </button>
        </form>

        <div style={{ marginTop: 18, textAlign: "center", fontSize: 13, color: "rgba(231,233,238,0.6)" }}>
          {t("brand.auth.registerHint")}{" "}
          <a
            href={REGISTER_URL}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#8ab4ff", textDecoration: "underline" }}
          >
            {REGISTER_URL}
          </a>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  height: 40,
  padding: "0 12px",
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(13,16,24,0.8)",
  color: "#e7e9ee",
  fontSize: 14,
  outline: "none",
};

function buttonStyle(disabled: boolean): React.CSSProperties {
  return {
    height: 44,
    marginTop: 4,
    borderRadius: 999,
    border: "none",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.7 : 1,
    background: "linear-gradient(135deg, #5b8cff 0%, #8a5bff 100%)",
    color: "#fff",
    fontSize: 15,
    fontWeight: 600,
  };
}
