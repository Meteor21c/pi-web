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

interface RelayOnboardingProps {
  /** Called after a successful save. Defaults to a full page reload. */
  onSuccess?: () => void;
}

interface RelayKey {
  key: string;
  name?: string;
  status?: number | string;
}

interface RelayTestResult {
  ok: boolean;
  modelCount?: number;
  reason?: string;
  message?: string;
}

type Phase = "login" | "auto" | "waiting" | "manual" | "done";

const REGISTER_URL = "https://api.meteor21c.fun";

/** 有 status 字段时，是否算"正常可用"。 */
function isKeyActive(status: number | string): boolean {
  if (typeof status === "number") return status >= 200 && status < 400;
  const s = String(status).toLowerCase().trim();
  return s === "ok" || s === "active" || s === "valid" || s === "normal" || s === "200";
}

/** 选一个 key：优先 status 正常的第一个；没有 status 字段就取第一个。 */
function pickKey(keys: RelayKey[]): RelayKey | null {
  if (keys.length === 0) return null;
  const withStatus = keys.filter((k) => k.status !== undefined && k.status !== null);
  if (withStatus.length > 0) {
    const ok = withStatus.find((k) => isKeyActive(k.status as number | string));
    if (ok) return ok;
  }
  return keys[0];
}

/**
 * meteor21c 中转站"登录即用"引导。
 *
 * 状态机（props 保持兼容 { onSuccess }）：
 *  - login：email+password 登录（调 useRelaySession().login）+ 去注册外链
 *  - auto ：登录成功后自动拉取 key → 空则建 key → 选 key → relay-config/save
 *  - manual：M2 贴 key 流程（门禁关时默认进入；自动配置失败时降级到此）
 *  - done ：成功页（显示 modelCount + 开始使用）
 *
 * 门禁（AuthGate）契约由同事实现：useRelaySession().status 为 "disabled"
 * 时表示门禁未启用，直接走 manual；为 "authenticated" 时直接走 auto。
 */
export function RelayOnboarding({ onSuccess }: RelayOnboardingProps) {
  const { t } = useI18n();
  const { status, login } = useRelaySession();

  const [phase, setPhase] = useState<Phase>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const [modelCount, setModelCount] = useState(0);
  const [autoError, setAutoError] = useState<string | null>(null);

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
  }, [status]);

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

  // 自动配置：进入 auto 阶段后执行（拉取用户 key → 有则保存；无则进入 waiting 等待用户在控制台创建）。
  // "更新密钥"按钮 = 重新进入 auto（重新拉取覆盖配置）。
  useEffect(() => {
    if (phase !== "auto") return;
    let cancelled = false;

    const run = async () => {
      try {
        const res = await fetch("/api/relay-auth/keys", {
          method: "GET",
          headers: { "Content-Type": "application/json" },
        });
        const body = (await res.json()) as { ok?: boolean; keys?: RelayKey[]; message?: string };
        if (cancelled) return;
        if (!body.ok || !Array.isArray(body.keys)) {
          setAutoError(t("brand.auth.manualFallback"));
          setPhase("manual");
          return;
        }

        const keys = body.keys;
        if (keys.length === 0) {
          // 不自动创建：请用户到控制台创建后点"更新密钥"重新拉取。
          setPhase("waiting");
          return;
        }

        const chosen = pickKey(keys);
        if (!chosen) {
          setAutoError(t("brand.auth.manualFallback"));
          setPhase("manual");
          return;
        }

        const sRes = await fetch("/api/relay-config/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey: chosen.key }),
        });
        const sBody = (await sRes.json()) as RelayTestResult;
        if (cancelled) return;
        if (!sBody.ok) {
          setAutoError(t("brand.auth.manualFallback"));
          setPhase("manual");
          return;
        }

        setModelCount(sBody.modelCount ?? 0);
        setPhase("done");
      } catch {
        if (cancelled) return;
        setAutoError(t("brand.auth.manualFallback"));
        setPhase("manual");
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [phase, t]);

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
        setModelCount(data.modelCount ?? 0);
        setPhase("done");
        if (onSuccess) onSuccess();
        else window.location.reload();
      })
      .catch(() => setManualError(t("relay.onboarding.networkError")))
      .finally(() => setSaving(false));
  }, [tested, testing, saving, apiKey, onSuccess, t]);

  // ---- 登录步骤 ----
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
        <ConfigSectionTitle>{t("brand.auth.title")}</ConfigSectionTitle>
        <p style={{ margin: "0 0 8px", fontSize: 13, color: "#4ade80", lineHeight: 1.6 }}>
          {t("brand.auth.autoSetup")}
        </p>
        <RelayAdvancedSettings />
      </ConfigDetail>
    );
  }

  // ---- 等待密钥：账号下无 key，请用户到控制台创建后点"更新密钥" ----
  if (phase === "waiting") {
    return (
      <ConfigDetail>
        <ConfigSectionTitle>{t("brand.auth.title")}</ConfigSectionTitle>
        <p style={{ margin: "0 0 6px", fontSize: 13, color: "var(--text)", lineHeight: 1.6, fontWeight: 600 }}>
          {t("brand.keys.noKeyTitle")}
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

  // ---- 完成步骤 ----
  if (phase === "done") {
    return (
      <ConfigDetail>
        <ConfigSectionTitle>{t("brand.auth.title")}</ConfigSectionTitle>
        <p style={{ margin: "0 0 12px", fontSize: 13, color: "#4ade80", lineHeight: 1.6 }}>
          {t("brand.auth.ready").replace("{count}", String(modelCount))}
        </p>
        <ConfigButton
          variant="primary"
          onClick={() => {
            if (onSuccess) onSuccess();
            else window.location.reload();
          }}
        >
          {t("workspace.getStarted")}
        </ConfigButton>
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
        <p style={{ margin: "0 0 10px", fontSize: 12, color: "#fbbf24", lineHeight: 1.5 }}>{autoError}</p>
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
