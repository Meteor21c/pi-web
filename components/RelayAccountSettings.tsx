"use client";

import { useState } from "react";
import { useRelaySession } from "@/hooks/useRelaySession";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton } from "./SettingsUi";
import { MeteorAgentDownloadLink } from "./MeteorAgentDownloadLink";

/** Separate from MeteorAgent's optional local web-password session. */
export function RelayAccountSettings() {
  const { status, user, logout } = useRelaySession();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  if (status !== "authenticated") return null;
  const leave = async () => {
    if (!window.confirm(t("brand.account.confirmLogout"))) return;
    setBusy(true);
    setError(false);
    try { await logout(); } catch { setError(true); } finally { setBusy(false); }
  };
  return (
    <section className="settings-general-section">
      <h3 className="settings-general-heading">{t("brand.account.title")}</h3>
      <p>{user?.email}</p>
      <p className="settings-general-description">{t("brand.account.logoutHint")}</p>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <ConfigButton variant="secondary" disabled={busy} onClick={() => void leave()}>
          {busy ? t("auth.loggingOut") : t("brand.account.switchLogout")}
        </ConfigButton>
        <a href="https://api.meteor21c.fun" target="_blank" rel="noreferrer">{t("brand.keys.consoleLink")}</a>
        <MeteorAgentDownloadLink variant="inline" />
      </div>
      {error && <p role="alert">{t("auth.logoutFailed")}</p>}
    </section>
  );
}
