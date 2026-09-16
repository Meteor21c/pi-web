"use client";

import { useEffect, useRef, useState } from "react";
import { useRelaySession } from "@/hooks/useRelaySession";
import { useI18n } from "@/hooks/useI18n";
import type { SettingsSection } from "@/lib/settings-navigation";
import { SettingsSectionIcon } from "./SettingsPanel";
import styles from "./SidebarAccountMenu.module.css";

const MENU_SECTIONS: Array<{
  id: SettingsSection;
  labelKey: "settings.general" | "common.models" | "common.skills" | "common.agents" | "common.plugins";
  requiresProject: boolean;
}> = [
  { id: "general", labelKey: "settings.general", requiresProject: false },
  { id: "models", labelKey: "common.models", requiresProject: false },
  { id: "skills", labelKey: "common.skills", requiresProject: true },
  { id: "agents", labelKey: "common.agents", requiresProject: true },
  { id: "plugins", labelKey: "common.plugins", requiresProject: true },
];

export function SidebarAccountMenu({
  cwd,
  onSelectSection,
}: {
  cwd: string | null;
  onSelectSection: (section: SettingsSection) => void;
}) {
  const { user } = useRelaySession();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const username = user?.username?.trim();
  const email = user?.email?.trim();
  const displayName = username || email || "MeteorAgent";
  const secondary = username && email ? email : t("settings.title");
  const avatarText = Array.from(displayName)[0]?.toLocaleUpperCase() || "M";

  return (
    <div ref={rootRef} className={styles.root}>
      {open && (
        <div role="menu" aria-label={t("settings.title")} className={styles.popover}>
          {MENU_SECTIONS.map((item) => {
            const disabled = item.requiresProject && !cwd;
            const label = t(item.labelKey);
            return (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                disabled={disabled}
                title={disabled ? t("settings.projectRequired") : label}
                className={styles.menuItem}
                onClick={() => {
                  setOpen(false);
                  onSelectSection(item.id);
                }}
              >
                <SettingsSectionIcon section={item.id} size={16} strokeWidth={1.8} />
                <span>{label}</span>
                {disabled && <span className={styles.menuHint}>{t("settings.projectRequired")}</span>}
              </button>
            );
          })}
        </div>
      )}

      <button
        type="button"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${displayName} · ${t("settings.title")}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.avatar} aria-hidden="true">{avatarText}</span>
        <span className={styles.identity}>
          <strong title={displayName}>{displayName}</strong>
          <small title={secondary}>{secondary}</small>
        </span>
        <svg className={`${styles.chevron}${open ? ` ${styles.chevronOpen}` : ""}`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m7 10 5 5 5-5" />
        </svg>
      </button>
    </div>
  );
}
