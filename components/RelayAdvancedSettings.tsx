"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getRelayBaseUrl } from "@/lib/relay-config";
import { ConfigField } from "./SettingsUi";

/**
 * 高级设置折叠组，挂在 RelayOnboarding 卡片底部。
 * 默认收起：中转地址（只读，来自 lib/relay-config）、连接排障、模型目录说明。
 * 面向小白：文案用大白话，不暴露任何可改的危险项。
 */
export function RelayAdvancedSettings() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const baseUrl = getRelayBaseUrl();

  return (
    <div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          width: "100%",
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
          color: "var(--text)",
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        <span>{t("relay.advanced.title")}</span>
        <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 10 }}>
          <ConfigField label={t("relay.advanced.baseUrl")}>
            <code
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 5,
                padding: "5px 8px",
                color: "var(--text)",
                wordBreak: "break-all",
              }}
            >
              {baseUrl}
            </code>
            <p style={{ margin: "6px 0 0", fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {t("relay.advanced.baseUrlHint")}
            </p>
          </ConfigField>

          <ConfigField label={t("relay.advanced.proxy")}>
            <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.6 }}>
              {t("relay.advanced.proxyHint")}
            </p>
          </ConfigField>

          <ConfigField label={t("relay.advanced.modelsSync")}>
            <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.6 }}>
              {t("relay.advanced.modelsSync")}
            </p>
          </ConfigField>
        </div>
      )}
    </div>
  );
}
