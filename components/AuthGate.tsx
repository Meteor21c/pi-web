"use client";

/**
 * 品牌登录门禁（W-D 填充）。
 * 契约：<AuthGate>{ children }</AuthGate>
 * NEXT_PUBLIC_AUTH_GATE !== "1" 时直接放行（pi-web 主线默认无门禁）。
 * 启动校验 → 登录 → 渠道同步 → 直接进入工作区；校验中不挂载工作区。
 *
 * 校验与自动配置阶段共用单一 BootSplash 实例（进度连续不回跳）；
 * 阶段1（账号检查）与阶段2（自动配置）各有最短展示时间，节奏均衡；
 * RelayOnboarding 挂载后保持挂载（同步逻辑在其 effect 中驱动）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import Image from "next/image";
import { useRelaySession } from "@/hooks/useRelaySession";
import { useI18n } from "@/hooks/useI18n";
import { RelayOnboarding, type RelayOnboardingPhase } from "./RelayOnboarding";
import { BootSplash } from "./BootSplash";
import { MeteorAgentDownloadLink } from "./MeteorAgentDownloadLink";

const GATE_ENABLED = process.env.NEXT_PUBLIC_AUTH_GATE === "1";

const REGISTER_URL = "https://api.meteor21c.fun";

/** 启动屏最短展示时长（ms）：检测太快时进度条也能完整走完，不显突兀。 */
const SPLASH_MIN_VISIBLE_MS = 2000;
/** 第一阶段（账号检查）最短展示：避免第一行字一闪而过、第二行字干等。 */
const SPLASH_STAGE1_MIN_MS = 900;

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
  const [stage1MinDone, setStage1MinDone] = useState(false);
  const splashShownAtRef = useRef<number | null>(null);

  // 启动屏首次出现即计时：同步完成也至少让进度条走满 2s，观感完整。
  useEffect(() => {
    if (splashShownAtRef.current === null) splashShownAtRef.current = performance.now();
  }, []);

  // 第一阶段（账号检查文案）至少展示 0.9s，两行检测项节奏均衡。
  useEffect(() => {
    const id = window.setTimeout(() => setStage1MinDone(true), SPLASH_STAGE1_MIN_MS);
    return () => window.clearTimeout(id);
  }, []);

  // 启动屏最短展示闸门：同步完成也等进度条走满再进工作区。
  const enterWorkspace = useCallback(() => {
    const elapsed = splashShownAtRef.current === null
      ? SPLASH_MIN_VISIBLE_MS
      : performance.now() - splashShownAtRef.current;
    const wait = Math.max(0, SPLASH_MIN_VISIBLE_MS - elapsed);
    window.setTimeout(() => setReadyGeneration(generation), wait);
  }, [generation]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setErrorKey(null);
    try {
      const result = await login(email, password);
      if (!result.ok) {
        const mapped = errorKeyToMessage(result.message);
        setErrorKey(mapped ?? "brand.auth.loginFailed");
        return;
      }
      setPassword("");
    } catch {
      setErrorKey("brand.auth.networkError");
    } finally {
      setSubmitting(false);
    }
  };

  if (!GATE_ENABLED || status === "disabled") {
    return <>{children}</>;
  }
  if (readyGeneration === generation) {
    return <>{children}</>;
  }

  // 未登录 → 品牌登录卡片。
  if (status === "unauthenticated") {
    return (
      <div
        style={{
          height: "var(--vp-h, 100dvh)",
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
              <Image
                src="/icons/logo.png"
                alt="MeteorAgent"
                width={96}
                height={96}
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

            {errorKey !== null && (
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
            <span aria-hidden="true"> · </span>
            <MeteorAgentDownloadLink variant="inline" />
          </div>
        </div>
      </div>
    );
  }

  // 统一启动屏流程（status: loading | error | authenticated 未就绪）。
  // 单一 BootSplash 实例贯穿阶段1/阶段2，进度连续不回跳。
  // 注意：RelayOnboarding 一旦挂载就保持挂载（同步逻辑在其 effect 中驱动），
  // 启动屏只是覆盖在它上面的遮罩——条件卸载会让同步永不执行（死锁）。
  const stage1 = status === "loading" || !stage1MinDone;
  const mountOnboarding = status === "authenticated" && stage1MinDone;
  const onboardingBusy = onboardingPhase === null || onboardingPhase === "auto";
  const splashVisible = status === "loading" || status === "error" || stage1 || (mountOnboarding && onboardingBusy);
  const cardVisible = mountOnboarding && !onboardingBusy;
  const splashProgress = status === "error" || stage1 ? 0.5 : 0.92;
  const splashLabel = status === "error"
    ? t("brand.auth.networkError")
    : stage1
      ? t("brand.auth.checking")
      : t("brand.auth.autoSetup");

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
      {/* 启动屏常驻挂载（busy 结束随容器卸载），显示/隐藏用 CSS 切换——
          任何阶段变化都不会重建实例，rAF 进度因此严格连续。 */}
      <BootSplash
        progress={splashProgress}
        label={splashLabel}
        error={status === "error"}
        hidden={!splashVisible}
      >
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
      {mountOnboarding && (
        <div
          className="ui-msg-enter"
          aria-hidden={cardVisible ? undefined : true}
          style={{
            width: "100%",
            maxWidth: 520,
            padding: "28px 28px",
            borderRadius: 24,
            background: "var(--assistant-bg)",
            border: "0.5px solid color-mix(in srgb, var(--border) 70%, transparent)",
            boxShadow: "0 24px 60px rgba(0,0,0,0.14), 0 4px 16px rgba(0,0,0,0.06)",
            ...(cardVisible ? undefined : {
              position: "absolute",
              visibility: "hidden",
              pointerEvents: "none",
            }),
          }}
        >
          <RelayOnboarding key={generation} onSuccess={enterWorkspace} onPhaseChange={setOnboardingPhase} />
        </div>
      )}
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
