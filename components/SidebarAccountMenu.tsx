"use client";

import { useEffect, useRef, useState } from "react";
import { useRelaySession } from "@/hooks/useRelaySession";
import { useI18n } from "@/hooks/useI18n";
import type { SettingsSection } from "@/lib/settings-navigation";
import type { AppRestartStatus } from "@/lib/api-types";
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

type RestartUiPhase = "checking" | "ready" | "unsupported" | "restarting" | "error";

function RestartLocalServiceButton() {
  const { t } = useI18n();
  const [status, setStatus] = useState<AppRestartStatus | null>(null);
  const [phase, setPhase] = useState<RestartUiPhase>("checking");
  const [error, setError] = useState<string | null>(null);
  const healthTimerRef = useRef<number | null>(null);
  const baselineInstanceRef = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let controller: AbortController | null = null;

    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch("/api/app-restart", {
          cache: "no-store",
          signal: controller.signal,
        });
        const next = await response.json() as AppRestartStatus & { error?: string };
        if (!response.ok || next.error) throw new Error(next.error ?? `HTTP ${response.status}`);
        if (disposed) return;
        setStatus(next);
        setPhase((current) => current === "restarting"
          ? current
          : next.automaticRestartSupported ? "ready" : "unsupported");
      } catch (cause) {
        if (disposed || (cause instanceof DOMException && cause.name === "AbortError")) return;
        // A temporary browser/network error should not make the button look
        // dangerous; retry on the next interval and keep it disabled meanwhile.
        setPhase((current) => current === "restarting" ? current : "checking");
      }
    };

    void load();
    const interval = window.setInterval(() => void load(), 5_000);
    return () => {
      disposed = true;
      controller?.abort();
      window.clearInterval(interval);
      if (healthTimerRef.current !== null) window.clearTimeout(healthTimerRef.current);
    };
  }, []);

  const pollUntilHealthy = () => {
    let attempts = 0;
    let sawDisconnect = false;
    const check = async () => {
      attempts += 1;
      try {
        const response = await fetch(`/api/relay-health?restart=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) throw new Error("offline");
        const health = await response.json() as { product?: string; status?: string; instanceId?: string };
        const instanceChanged = Boolean(
          baselineInstanceRef.current
          && health.instanceId
          && health.instanceId !== baselineInstanceRef.current,
        );
        if (
          health.product === "MeteorAgent"
          && health.status === "ok"
          && (sawDisconnect || instanceChanged)
        ) {
          window.location.reload();
          return;
        }
      } catch {
        sawDisconnect = true;
      }

      if (attempts >= 120) {
        setPhase("error");
        setError(t("restart.failed"));
        return;
      }
      healthTimerRef.current = window.setTimeout(() => void check(), 1_000);
    };

    healthTimerRef.current = window.setTimeout(() => void check(), 900);
  };

  const restart = async () => {
    if (phase === "checking" || phase === "unsupported" || phase === "restarting") return;
    const runningCount = status?.runningSessionIds.length ?? 0;
    if (runningCount > 0) return;
    if (!window.confirm(t("restart.confirm"))) return;

    setError(null);
    setPhase("restarting");
    try {
      // Capture an opaque process marker before the service is handed off. A
      // healthy response from the same PID must not be mistaken for success
      // if the helper failed to stop the old service.
      try {
        const healthResponse = await fetch(`/api/relay-health?restart=baseline-${Date.now()}`, { cache: "no-store" });
        if (healthResponse.ok) {
          const health = await healthResponse.json() as { instanceId?: string };
          baselineInstanceRef.current = typeof health.instanceId === "string" ? health.instanceId : null;
        }
      } catch {
        baselineInstanceRef.current = null;
      }
      const response = await fetch("/api/app-restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const result = await response.json() as AppRestartStatus & { error?: string };
      if (result.runningSessionIds) setStatus(result);
      if (!response.ok || result.error) {
        if (response.status === 409 && result.runningSessionIds?.length) {
          setPhase("ready");
          setError(t("restart.runningTasks", { count: result.runningSessionIds.length }));
          return;
        }
        throw new Error(result.error ?? `HTTP ${response.status}`);
      }
      pollUntilHealthy();
    } catch (cause) {
      setPhase("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const runningCount = status?.runningSessionIds.length ?? 0;
  const disabled = phase === "checking" || phase === "unsupported" || phase === "restarting" || runningCount > 0;
  const hint = phase === "unsupported"
    ? t("restart.unsupported")
    : runningCount > 0
      ? t("restart.runningTasks", { count: runningCount })
      : phase === "restarting"
        ? t("restart.waiting")
        : error;

  return (
    <>
      <button
        type="button"
        className={styles.restartButton}
        onClick={() => void restart()}
        disabled={disabled}
        title={hint ?? t("restart.description")}
        aria-label={t("restart.action")}
        data-restart-service="true"
      >
        <svg className={phase === "restarting" ? styles.restartIconSpinning : undefined} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 11a8.1 8.1 0 0 0-14.9-4L3 10" />
          <path d="M3 4v6h6" />
          <path d="M4 13a8.1 8.1 0 0 0 14.9 4L21 14" />
          <path d="M21 20v-6h-6" />
        </svg>
        <span>{phase === "restarting" ? t("restart.preparing") : t("restart.action")}</span>
      </button>
      {hint && <div className={styles.restartHint} role={phase === "error" ? "alert" : "status"}>{hint}</div>}
    </>
  );
}

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
      <RestartLocalServiceButton />
    </div>
  );
}
