"use client";

/**
 * relay provider 详情区的"更新密钥"小组件。
 * 调用 /api/relay-config/auto：服务端重新拉取账号 key 并逐个实测，
 * 自动选用可用的那个并覆盖本地配置（status 字段不可信，必须实测）。
 * 挂点：components/ModelsConfig.tsx（isRelayProviderId 的 provider 详情区）。
 */
import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton } from "./SettingsUi";

type SyncState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "ok"; modelCount: number }
  | { kind: "no-key" }
  | { kind: "no-usable-key" }
  | { kind: "need-login" }
  | { kind: "failed"; message?: string };

export function RelayKeyRefresh({ providerId, enabled }: { providerId: string; enabled: boolean }) {
  const { t } = useI18n();
  const [state, setState] = useState<SyncState>({ kind: "idle" });

  if (!enabled) return null;

  const refresh = () => {
    if (state.kind === "busy") return;
    setState({ kind: "busy" });
    (async () => {
      try {
        const res = await fetch("/api/relay-config/auto", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        const body = (await res.json()) as {
          ok?: boolean;
          modelCount?: number;
          reason?: string;
          message?: string;
        };
        void providerId;
        if (body.ok) {
          setState({ kind: "ok", modelCount: body.modelCount ?? 0 });
          return;
        }
        if (body.reason === "no-key") {
          setState({ kind: "no-key" });
          return;
        }
        if (body.reason === "no-usable-key") {
          setState({ kind: "no-usable-key" });
          return;
        }
        if (body.reason === "unauthenticated") {
          setState({ kind: "need-login" });
          return;
        }
        setState({ kind: "failed", message: body.message });
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
      {(state.kind === "no-key" || state.kind === "no-usable-key") && (
        <p style={{ margin: 0, fontSize: 12, color: "#fbbf24", lineHeight: 1.5 }}>
          {state.kind === "no-usable-key" ? t("brand.keys.noUsableKey") : t("brand.keys.noKeyTitle")}{" "}
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
