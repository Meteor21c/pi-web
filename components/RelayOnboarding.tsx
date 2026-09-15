"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  ConfigButton,
  ConfigDetail,
  ConfigField,
  ConfigSectionTitle,
} from "./SettingsUi";

interface RelayOnboardingProps {
  /** Called after a successful save. Defaults to a full page reload. */
  onSuccess?: () => void;
}

interface RelayTestResult {
  ok: boolean;
  modelCount?: number;
  gptCount?: number;
  claudeCount?: number;
  reason?: string;
  message?: string;
}

/**
 * Onboarding wizard for the meteor21c relay: paste key → test connection →
 * save. Saving writes the two relay provider fragments into models.json and
 * stores the credential for both providers via /api/relay-config/save.
 */
export function RelayOnboarding({ onSuccess }: RelayOnboardingProps) {
  const { t } = useI18n();
  const [apiKey, setApiKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tested, setTested] = useState<RelayTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const canTest = apiKey.trim().length > 0 && !testing && !saving;
  const canSave = tested?.ok === true && !testing && !saving;

  function handleTest() {
    if (!canTest) return;
    setTesting(true);
    setError(null);
    setTested(null);
    fetch("/api/relay-config/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: apiKey.trim() }),
    })
      .then((res) => res.json() as Promise<RelayTestResult>)
      .then((data) => {
        setTested(data);
        if (!data.ok) setError(data.message ?? t("relay.onboarding.invalidKey"));
      })
      .catch(() => setError(t("relay.onboarding.networkError")))
      .finally(() => setTesting(false));
  }

  function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    fetch("/api/relay-config/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: apiKey.trim() }),
    })
      .then((res) => res.json() as Promise<RelayTestResult & { ok: boolean }>)
      .then((data) => {
        if (!data.ok) {
          setError(data.message ?? t("relay.onboarding.invalidKey"));
          return;
        }
        setDone(true);
        if (onSuccess) onSuccess();
        else window.location.reload();
      })
      .catch(() => setError(t("relay.onboarding.networkError")))
      .finally(() => setSaving(false));
  }

  if (done) {
    return (
      <ConfigDetail>
        <ConfigSectionTitle>{t("relay.onboarding.title")}</ConfigSectionTitle>
        <p style={{ margin: 0, fontSize: 13, color: "#4ade80", lineHeight: 1.5 }}>
          {t("relay.onboarding.success")}
        </p>
      </ConfigDetail>
    );
  }

  return (
    <ConfigDetail>
      <ConfigSectionTitle>{t("relay.onboarding.title")}</ConfigSectionTitle>
      <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
        {t("relay.onboarding.description")}
      </p>

      <ConfigField label={t("relay.onboarding.tokenLabel")}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              setTested(null);
              setError(null);
            }}
            placeholder={t("relay.onboarding.tokenPlaceholder")}
            autoComplete="off"
            spellCheck={false}
            style={{
              flex: 1,
              padding: "6px 9px",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 5,
              color: "var(--text)",
              fontSize: 12,
              outline: "none",
              fontFamily: "var(--font-mono)",
              boxSizing: "border-box",
            }}
          />
          <a
            href="https://api.meteor21c.fun"
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
      {error && (
        <p style={{ margin: "10px 0 0", fontSize: 12, color: "#f87171", lineHeight: 1.5 }}>
          {error}
        </p>
      )}
    </ConfigDetail>
  );
}
