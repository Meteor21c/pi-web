"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useRelaySession } from "@/hooks/useRelaySession";
import {
  ConfigButton,
  ConfigDetail,
  ConfigField,
  ConfigSectionTitle,
} from "./SettingsUi";
import { RelayAdvancedSettings } from "./RelayAdvancedSettings";
import { syncRelayConfig } from "@/lib/relay-client";

interface RelayOnboardingProps {
  /** Called as soon as synchronization succeeds. Defaults to a full page reload. */
  onSuccess?: () => void;
  /** 阶段变化上报：AuthGate 据此把 busy 阶段（auto）切换到品牌启动屏。 */
  onPhaseChange?: (phase: Phase) => void;
}

interface RelayTestResult {
  ok: boolean;
  modelCount?: number;
  reason?: string;
  message?: string;
}

type Phase = "login" | "auto" | "waiting" | "manual" | "error";
type NoKeyReason = "no-key" | "no-usable-key";

const REGISTER_URL = "https://api.meteor21c.fun";

/**
 * meteor21c 中转站"登录即用"引导。
 *
 * 状态机（props 保持兼容 { onSuccess }）：
 *  - login  ：email+password 登录（调 useRelaySession().login）+ 去注册外链
 *  - auto   ：登录后调 /api/relay-config/auto，同步全部账号渠道目录
 *  - waiting：账号无 key / 全部 key 不可用 → 引导去控制台处理后点"更新密钥"
 *  - manual ：贴 key 流程（门禁关时默认进入，或用户主动选择）
 *  - error  ：保留登录态，提供重试、控制台与重新登录
 *  - 同步成功：立即调用 onSuccess 进入工作区，不停留在完成页
 *
 * 门禁（AuthGate）：useRelaySession().status 为 "disabled"（门禁未启用）时走 manual；
 * 为 "authenticated" 时走 auto。
 */
export type RelayOnboardingPhase = Phase;

export function RelayOnboarding({ onSuccess, onPhaseChange }: RelayOnboardingProps) {
  const { t } = useI18n();
  const { status, login, logout, recheck, generation } = useRelaySession();

  const [phase, setPhase] = useState<Phase>("login");

  useEffect(() => {
    onPhaseChange?.(phase);
  }, [phase, onPhaseChange]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const [autoError, setAutoError] = useState<string | null>(null);
  const [noKeyReason, setNoKeyReason] = useState<NoKeyReason>("no-key");

  // M2 手动贴 key 流程状态
  const [apiKey, setApiKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tested, setTested] = useState<RelayTestResult | null>(null);
  const [manualError, setManualError] = useState<string | null>(null);

  // 依据门禁会话状态决定入口：disabled→manual；authenticated→auto；其余→login。
  useEffect(() => {
    if (status === "disabled") setPhase("manual");
    else if (status === "authenticated") setPhase("auto");
    else setPhase("login");
  }, [status, generation]);

  const mapLoginError = useCallback(
    (message?: string): string => {
      switch (message) {
        case "invalid-credentials":
          return t("brand.auth.loginFailed");
        case "captcha-required":
          return t("brand.auth.captchaRequired");
        case "network":
          return t("brand.auth.networkError");
        default:
          return message ? message : t("brand.auth.loginFailed");
      }
    },
    [t],
  );

  const handleLogin = useCallback(async () => {
    if (loggingIn || !email.trim() || !password) return;
    setLoggingIn(true);
    setLoginError(null);
    try {
      const res = await login(email.trim(), password);
      if (!res.ok) {
        setLoginError(mapLoginError(res.message));
        return;
      }
      // 登录成功 → useRelaySession 将 status 置为 authenticated → 上方 effect 进入 auto
    } finally {
      setLoggingIn(false);
    }
  }, [loggingIn, email, password, login, mapLoginError]);

  // 自动配置：进入 auto 阶段后执行。
  // 服务端拉取全部 key 并验证各自目录；目录探测不代表付费推理测试。
  // "更新密钥"按钮 = 重新进入 auto（重跑该流程）。
  useEffect(() => {
    if (phase !== "auto") return;
    let cancelled = false;

    const run = async () => {
      try {
        const body = await syncRelayConfig(generation);
        if (cancelled) return;

        if (body.ok && (body.totalModelCount ?? 0) > 0) {
          if (onSuccess) onSuccess();
          else window.location.reload();
          return;
        }
        if (body.reason === "no-key" || body.reason === "no-usable-key" || body.ok) {
          setNoKeyReason(body.reason === "no-usable-key" ? "no-usable-key" : "no-key");
          setPhase("waiting");
          return;
        }
        setAutoError(body.reason === "unauthenticated" ? "brand.keys.needLogin" : "brand.keys.refreshFailed");
        setPhase("error");
      } catch {
        if (cancelled) return;
        setAutoError("brand.auth.networkError");
        setPhase("error");
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [phase, generation, onSuccess]);

  const handleTest = useCallback(() => {
    if (!apiKey.trim() || testing || saving) return;
    setTesting(true);
    setManualError(null);
    setTested(null);
    fetch("/api/relay-config/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: apiKey.trim() }),
    })
      .then((res) => res.json() as Promise<RelayTestResult>)
      .then((data) => {
        setTested(data);
        if (!data.ok) setManualError(data.message ?? t("relay.onboarding.invalidKey"));
      })
      .catch(() => setManualError(t("relay.onboarding.networkError")))
      .finally(() => setTesting(false));
  }, [apiKey, testing, saving, t]);

  const handleSave = useCallback(() => {
    if (!tested?.ok || testing || saving) return;
    setSaving(true);
    setManualError(null);
    fetch("/api/relay-config/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: apiKey.trim() }),
    })
      .then((res) => res.json() as Promise<RelayTestResult>)
      .then((data) => {
        if (!data.ok) {
          setManualError(data.message ?? t("relay.onboarding.invalidKey"));
          return;
        }
        window.dispatchEvent(new Event("relay-config-updated"));
        if (onSuccess) onSuccess();
        else window.location.reload();
      })
      .catch(() => setManualError(t("relay.onboarding.networkError")))
      .finally(() => setSaving(false));
  }, [tested, testing, saving, apiKey, onSuccess, t]);

  // ---- 登录步骤 ----
  if (status === "loading" || status === "error") {
    return <ConfigDetail>
      <p role="status">{t(status === "loading" ? "brand.auth.checking" : "brand.auth.networkError")}</p>
      {status === "error" && <ConfigButton onClick={() => void recheck()}>{t("brand.auth.retry")}</ConfigButton>}
    </ConfigDetail>;
  }
  if (phase === "error") {
    return <ConfigDetail>
      <ConfigSectionTitle>{t("brand.setup.title")}</ConfigSectionTitle>
      <p role="alert">{t(autoError ?? "brand.keys.refreshFailed")}</p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <ConfigButton variant="primary" onClick={() => setPhase("auto")}>{t("brand.auth.retry")}</ConfigButton>
        <ConfigButton onClick={() => void logout().catch(() => setAutoError("auth.logoutFailed"))}>{t("brand.account.switchLogout")}</ConfigButton>
        <a href={REGISTER_URL} target="_blank" rel="noreferrer">{t("brand.keys.consoleLink")}</a>
      </div>
    </ConfigDetail>;
  }
  if (phase === "login") {
    return (
      <ConfigDetail>
        <ConfigSectionTitle>{t("brand.auth.title")}</ConfigSectionTitle>
        <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
          {t("brand.auth.description")}
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <ConfigField label={t("brand.auth.email")}>
            <input
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setLoginError(null);
              }}
              placeholder="you@example.com"
              autoComplete="email"
              spellCheck={false}
              style={inputStyle}
            />
          </ConfigField>

          <ConfigField label={t("brand.auth.password")}>
            <input
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setLoginError(null);
              }}
              placeholder="••••••••"
              autoComplete="current-password"
              spellCheck={false}
              style={inputStyle}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleLogin();
              }}
            />
          </ConfigField>

          {loginError && (
            <p style={{ margin: 0, fontSize: 12, color: "#f87171", lineHeight: 1.5 }}>{loginError}</p>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
            <ConfigButton variant="primary" onClick={() => void handleLogin()} disabled={loggingIn || !email.trim() || !password}>
              {loggingIn ? t("brand.auth.loggingIn") : t("brand.auth.login")}
            </ConfigButton>
            <a
              href={REGISTER_URL}
              target="_blank"
              rel="noreferrer"
              style={{ alignSelf: "center", fontSize: 12, color: "var(--accent)" }}
            >
              {t("brand.auth.registerHint")}
            </a>
          </div>
        </div>

        <RelayAdvancedSettings />
      </ConfigDetail>
    );
  }

  // ---- 自动配置步骤 ----
  if (phase === "auto") {
    return (
      <ConfigDetail>
        <ConfigSectionTitle>{t("brand.setup.title")}</ConfigSectionTitle>
        <p style={{ margin: "0 0 8px", fontSize: 13, color: "#4ade80", lineHeight: 1.6 }}>
          {t("brand.auth.autoSetup")}
        </p>
      </ConfigDetail>
    );
  }

  // ---- 等待密钥：账号下无可用 key，请用户到控制台处理后点"更新密钥" ----
  if (phase === "waiting") {
    const title = noKeyReason === "no-usable-key" ? t("brand.keys.noUsableKey") : t("brand.keys.noKeyTitle");
    return (
      <ConfigDetail>
        <ConfigSectionTitle>{t("brand.setup.title")}</ConfigSectionTitle>
        <p style={{ margin: "0 0 6px", fontSize: 13, color: "var(--text)", lineHeight: 1.6, fontWeight: 600 }}>
          {title}
        </p>
        <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
          {t("brand.keys.noKeyHint")}
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <ConfigButton variant="primary" onClick={() => setPhase("auto")}>
              {t("brand.keys.refresh")}
            </ConfigButton>
            <a
              href={REGISTER_URL}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 12, color: "var(--accent)" }}
            >
              {t("brand.keys.consoleLink")}
            </a>
          </div>
          <ConfigButton variant="secondary" onClick={() => setPhase("manual")}>
            {t("brand.keys.manualEntry")}
          </ConfigButton>
        </div>

        <RelayAdvancedSettings />
      </ConfigDetail>
    );
  }

  // ---- 手动贴 key 步骤（默认 / 自动配置降级） ----
  const canTest = apiKey.trim().length > 0 && !testing && !saving;
  const canSave = tested?.ok === true && !testing && !saving;

  return (
    <ConfigDetail>
      <ConfigSectionTitle>{t("relay.onboarding.title")}</ConfigSectionTitle>
      <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
        {t("relay.onboarding.description")}
      </p>

      {autoError && (
        <p style={{ margin: "0 0 10px", fontSize: 12, color: "#fbbf24", lineHeight: 1.5 }}>{t(autoError)}</p>
      )}

      <ConfigField label={t("relay.onboarding.tokenLabel")}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              setTested(null);
              setManualError(null);
            }}
            placeholder={t("relay.onboarding.tokenPlaceholder")}
            autoComplete="off"
            spellCheck={false}
            style={inputStyle}
          />
          <a
            href={REGISTER_URL}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: 12, color: "var(--accent)" }}
          >
            {t("relay.onboarding.getToken")}
          </a>
        </div>
      </ConfigField>

      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <ConfigButton variant="secondary" onClick={handleTest} disabled={!canTest}>
          {testing ? t("relay.onboarding.testing") : t("relay.onboarding.test")}
        </ConfigButton>
        <ConfigButton variant="primary" onClick={handleSave} disabled={!canSave}>
          {saving ? t("relay.onboarding.saving") : t("relay.onboarding.save")}
        </ConfigButton>
      </div>

      {tested?.ok === true && (
        <p style={{ margin: "10px 0 0", fontSize: 12, color: "#4ade80", lineHeight: 1.5 }}>
          {t("relay.onboarding.modelsFound").replace("{count}", String(tested.modelCount ?? 0))}
        </p>
      )}
      {manualError && (
        <p style={{ margin: "10px 0 0", fontSize: 12, color: "#f87171", lineHeight: 1.5 }}>{manualError}</p>
      )}

      <RelayAdvancedSettings />
    </ConfigDetail>
  );
}

const inputStyle: CSSProperties = {
  flex: 1,
  width: "100%",
  padding: "6px 9px",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 5,
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
  fontFamily: "var(--font-mono)",
  boxSizing: "border-box",
};
