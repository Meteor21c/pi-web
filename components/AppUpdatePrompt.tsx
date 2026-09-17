"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { AppUpdateInstallStatus, AppUpdateResponse } from "@/lib/api-types";

const SNOOZE_KEY = "magent-update-snooze";
const SNOOZE_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

function readSnooze(version: string): boolean {
  try {
    const value = JSON.parse(localStorage.getItem(SNOOZE_KEY) ?? "null") as { version?: unknown; until?: unknown } | null;
    return value?.version === version && typeof value.until === "number" && value.until > Date.now();
  } catch {
    return false;
  }
}

function formatBytes(bytes: number | undefined, locale: string): string | null {
  if (!bytes || bytes <= 0) return null;
  return new Intl.NumberFormat(locale, { style: "unit", unit: "megabyte", maximumFractionDigits: 1 })
    .format(bytes / (1024 * 1024));
}

export function AppUpdatePrompt() {
  const { t, locale } = useI18n();
  const [update, setUpdate] = useState<AppUpdateResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<AppUpdateInstallStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const installing = Boolean(status && status.phase !== "idle" && status.phase !== "error");

  useEffect(() => {
    let disposed = false;
    let controller: AbortController | null = null;
    const checkForUpdate = () => {
      controller?.abort();
      controller = new AbortController();
      void fetch("/api/app-update", { cache: "no-store", signal: controller.signal })
        .then(async (response) => response.ok ? response.json() as Promise<AppUpdateResponse> : null)
        .then((result) => {
          if (disposed || !result?.updateAvailable) return;
          setUpdate(result);
          if (!readSnooze(result.latestVersion)) setOpen(true);
        })
        .catch(() => {});
    };
    const initialTimer = setTimeout(checkForUpdate, 900);
    const interval = setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") checkForUpdate();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      clearTimeout(initialTimer);
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      controller?.abort();
    };
  }, []);

  const loadInstallStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/app-update/install", { cache: "no-store" });
      if (!response.ok) return;
      const next = await response.json() as AppUpdateInstallStatus;
      setStatus((current) => current?.phase === "preparing-restart" && next.phase === "idle" ? current : next);
      if (next.phase === "error" && next.message) setError(next.message);
    } catch {
      // A short disconnect is expected while the independent updater restarts the service.
    }
  }, []);

  useEffect(() => {
    if (!open || !update?.automaticUpdateSupported) return;
    void loadInstallStatus();
    const timer = setInterval(() => void loadInstallStatus(), installing ? 500 : 2_500);
    return () => clearInterval(timer);
  }, [installing, loadInstallStatus, open, update?.automaticUpdateSupported]);

  useEffect(() => {
    if (status?.phase !== "preparing-restart" || !update) return;
    let stopped = false;
    let sawDisconnect = false;
    let attempts = 0;
    const check = async () => {
      attempts += 1;
      try {
        const response = await fetch(`/api/relay-health?update=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) throw new Error("offline");
        const health = await response.json() as { product?: string; status?: string; version?: string };
        if (health.product === "MeteorAgent" && health.status === "ok" && health.version === update.latestVersion) {
          window.location.reload();
          return;
        }
        if (attempts > 90) setError(t(sawDisconnect ? "appUpdate.rollbackMessage" : "appUpdate.notStartedMessage"));
      } catch {
        sawDisconnect = true;
      }
      if (!stopped && attempts <= 120) setTimeout(() => void check(), 1_000);
    };
    const timer = setTimeout(() => void check(), 800);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [status?.phase, t, update]);

  const startUpdate = async () => {
    if (!update || installing) return;
    setError(null);
    try {
      const response = await fetch("/api/app-update/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: update.latestVersion }),
      });
      const result = await response.json() as AppUpdateInstallStatus & { error?: string };
      if (!response.ok || result.error) throw new Error(result.error ?? `HTTP ${response.status}`);
      setStatus(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await loadInstallStatus().catch(() => {});
    }
  };

  const snooze = () => {
    if (!update || installing) return;
    try {
      localStorage.setItem(SNOOZE_KEY, JSON.stringify({ version: update.latestVersion, until: Date.now() + SNOOZE_MS }));
    } catch {}
    setOpen(false);
  };

  const progress = useMemo(() => {
    if (!status?.totalBytes || status.totalBytes <= 0) return 0;
    return Math.min(100, Math.round((status.downloadedBytes / status.totalBytes) * 100));
  }, [status?.downloadedBytes, status?.totalBytes]);

  if (!open || !update) return null;
  const downloadSize = formatBytes(update.downloadBytes, locale);
  const runningCount = status?.runningSessionIds.length ?? 0;
  const automatic = update.automaticUpdateSupported && status?.automaticUpdateSupported !== false;

  return (
    <div
      role="presentation"
      style={{ position: "fixed", inset: 0, zIndex: 1400, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "rgba(0,0,0,0.45)", backdropFilter: "blur(4px)" }}
      onClick={(event) => { if (!installing && event.target === event.currentTarget) snooze(); }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="magent-update-title" style={{ width: 480, maxWidth: "100%", border: "1px solid var(--border)", borderRadius: 14, overflow: "hidden", background: "var(--bg-panel)", boxShadow: "0 24px 70px rgba(0,0,0,0.28)" }}>
        <div style={{ padding: "22px 22px 16px", display: "flex", gap: 14 }}>
          <div aria-hidden="true" style={{ width: 40, height: 40, borderRadius: 12, display: "grid", placeItems: "center", flexShrink: 0, color: "var(--accent)", background: "color-mix(in srgb, var(--accent) 12%, transparent)" }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div id="magent-update-title" style={{ fontSize: 17, fontWeight: 750, color: "var(--text)" }}>{t("appUpdate.title")}</div>
            <div style={{ marginTop: 4, fontSize: 12, color: "var(--text-muted)" }}>
              {t("appUpdate.versionLine", { current: update.currentVersion, latest: update.latestVersion })}{downloadSize ? ` · ${downloadSize}` : ""}
            </div>
          </div>
        </div>
        <div style={{ padding: "0 22px 18px" }}>
          <div style={{ fontSize: 12, fontWeight: 650, color: "var(--text)", marginBottom: 8 }}>{t("appUpdate.changes")}</div>
          <ul style={{ margin: 0, paddingLeft: 20, maxHeight: 180, overflowY: "auto", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.7 }}>
            {(update.releaseNotes.length ? update.releaseNotes : [t("appUpdate.defaultNote")]).map((note, index) => <li key={`${index}:${note}`}>{note}</li>)}
          </ul>
          <div style={{ marginTop: 14, padding: "10px 12px", borderRadius: 8, background: "var(--bg)", color: "var(--text-muted)", fontSize: 11, lineHeight: 1.55 }}>
            {t("appUpdate.dataSafe")}
          </div>
          {runningCount > 0 && <div role="status" style={{ marginTop: 10, color: "#d97706", fontSize: 12 }}>{t("appUpdate.runningTasks", { count: runningCount })}</div>}
          {installing && (
            <div style={{ marginTop: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 6, color: "var(--text-muted)", fontSize: 11 }}>
                <span>{status?.message || t("appUpdate.preparing")}</span><span>{status?.phase === "downloading" ? `${progress}%` : ""}</span>
              </div>
              <div style={{ height: 6, overflow: "hidden", borderRadius: 999, background: "var(--border)" }}>
                <div style={{ width: status?.phase === "downloading" ? `${Math.max(3, progress)}%` : "100%", height: "100%", borderRadius: 999, background: "var(--accent)", transition: "width 180ms ease", animation: status?.phase === "preparing-restart" ? "pulse 1.2s ease-in-out infinite" : undefined }} />
              </div>
            </div>
          )}
          {error && <div role="alert" style={{ marginTop: 10, color: "#ef4444", fontSize: 12, lineHeight: 1.5 }}>{error}</div>}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 9, padding: "12px 22px", borderTop: "1px solid var(--border)" }}>
          <button type="button" onClick={snooze} disabled={installing} style={{ height: 34, padding: "0 14px", border: "1px solid var(--border)", borderRadius: 7, background: "transparent", color: "var(--text-muted)", cursor: installing ? "not-allowed" : "pointer" }}>{t("appUpdate.later")}</button>
          {automatic ? (
            <button type="button" onClick={() => void startUpdate()} disabled={installing || runningCount > 0} style={{ height: 34, padding: "0 16px", border: "1px solid var(--accent)", borderRadius: 7, background: "var(--accent)", color: "var(--accent-contrast)", opacity: installing || runningCount > 0 ? 0.6 : 1, cursor: installing || runningCount > 0 ? "not-allowed" : "pointer", fontWeight: 650 }}>
              {installing ? t("appUpdate.updating") : t("appUpdate.updateNow")}
            </button>
          ) : (
            <a href={update.releaseUrl} target="_blank" rel="noopener noreferrer" style={{ minHeight: 34, padding: "0 16px", display: "inline-flex", alignItems: "center", borderRadius: 7, background: "var(--accent)", color: "var(--accent-contrast)", textDecoration: "none", fontWeight: 650 }}>{t("appUpdate.download")}</a>
          )}
        </div>
      </div>
    </div>
  );
}
