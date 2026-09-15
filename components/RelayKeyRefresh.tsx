"use client";

/**
 * relay provider 详情区的"更新密钥"小组件。
 * 用户在中转站控制台创建/更换 key 后，点击即可重新拉取并覆盖本地配置。
 * 挂点：components/ModelsConfig.tsx（isRelayProviderId 的 provider 详情区）。
 */
import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton } from "./SettingsUi";

interface RelayKey {
  key: string;
  name?: string;
  status?: number | string;
}

function isKeyActive(status: number | string | undefined): boolean {
  if (status === undefined || status === null) return true;
  if (typeof status === "number") return status >= 200 && status < 400;
  const s = String(status).toLowerCase().trim();
  return s === "ok" || s === "active" || s === "valid" || s === "normal" || s === "200";
}

function pickKey(keys: RelayKey[]): RelayKey | null {
  if (keys.length === 0) return null;
  const active = keys.find((k) => isKeyActive(k.status));
  return active ?? keys[0];
}

type SyncState = { kind: "idle" } | { kind: "busy" } | { kind: "ok"; modelCount: number } | { kind: "no-key" } | { kind: "need-login" } | { kind: "failed"; message?: string };

export function RelayKeyRefresh({ providerId, enabled }: { providerId: string; enabled: boolean }) {
  const { t } = useI18n();
  const [state, setState] = useState<SyncState>({ kind: "idle" });

  if (!enabled) return null;

  const refresh = () => {
    if (state.kind === "busy") return;
    setState({ kind: "busy" });
    (async () => {
      try {
        const kRes = await fetch("/api/relay-auth/keys", { headers: { "Content-Type": "application/json" } });
        const kBody = (await kRes.json()) as { ok?: boolean; keys?: RelayKey[] };
        if (!kBody.ok) {
          setState({ kind: "need-login" });
          return;
        }
        const keys = Array.isArray(kBody.keys) ? kBody.keys : [];
        if (keys.length === 0) {
          setState({ kind: "no-key" });
          return;
        }
        const chosen = pickKey(keys);
        if (!chosen) {
          setState({ kind: "no-key" });
          return;
        }
        const sRes = await fetch("/api/relay-config/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey: chosen.key }),
        });
        const sBody = (await sRes.json()) as { ok?: boolean; modelCount?: number; message?: string };
        if (!sBody.ok) {
          setState({ kind: "failed", message: sBody.message });
          return;
        }
        void providerId;
        setState({ kind: "ok", modelCount: sBody.modelCount ?? 0 });
      } catch {
        setState({ kind: "failed" });
      }
    })();
  };

  const busy = state.kind === "busy";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, margin: "10px 0" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <ConfigButton variant="secondary" onClick={refresh} disabled={busy}>
          {busy ? t("brand.keys.refreshing") : t("brand.keys.refresh")}
        </ConfigButton>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("brand.keys.hint")}</span>
      </div>

      {state.kind === "ok" && (
        <p style={{ margin: 0, fontSize: 12, color: "#4ade80", lineHeight: 1.5 }}>
          {t("brand.keys.updated").replace("{count}", String(state.modelCount))}
        </p>
      )}
      {state.kind === "no-key" && (
        <p style={{ margin: 0, fontSize: 12, color: "#fbbf24", lineHeight: 1.5 }}>
          {t("brand.keys.noKeyTitle")}{" "}
          <a href="https://api.meteor21c.fun" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
            {t("brand.keys.consoleLink")}
          </a>
        </p>
      )}
      {state.kind === "need-login" && (
        <p style={{ margin: 0, fontSize: 12, color: "#fbbf24", lineHeight: 1.5 }}>{t("brand.keys.needLogin")}</p>
      )}
      {state.kind === "failed" && (
        <p style={{ margin: 0, fontSize: 12, color: "#f87171", lineHeight: 1.5 }}>
          {t("brand.keys.refreshFailed")}
          {state.message ? ` (${state.message})` : ""}
        </p>
      )}
    </div>
  );
}
