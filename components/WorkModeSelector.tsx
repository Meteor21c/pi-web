"use client";

import { useEffect, useId, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { usePromptPresets } from "@/hooks/usePromptPresets";
import { isWorkMode, WORK_MODES, type WorkMode } from "@/lib/prompt-presets";

interface Props {
  mode: WorkMode;
  pendingMode?: WorkMode | null;
  disabled: boolean;
  onChanged?: () => Promise<void>;
  onSessionModeChange?: (mode: WorkMode) => Promise<void>;
  onResolvedMode?: (mode: WorkMode) => void;
}

/** Composer control: unsent chats choose the default; existing chats have their own mode. */
export function WorkModeSelector({ mode, pendingMode, disabled, onChanged, onSessionModeChange, onResolvedMode }: Props) {
  const { t } = useI18n();
  const { settings, busy, error, update } = usePromptPresets();
  const [syncing, setSyncing] = useState(false);
  const [failed, setFailed] = useState(false);
  const pendingId = useId();
  const isNew = Boolean(onChanged);
  const selected = isNew ? settings?.mode ?? "auto" : pendingMode ?? mode;
  useEffect(() => onResolvedMode?.(selected), [onResolvedMode, selected]);
  const pendingHint = pendingMode && t("presets.modePendingHint", {
    current: t(`presets.mode.${mode}`), next: t(`presets.mode.${pendingMode}`),
  });
  const hint = pendingHint || (disabled ? t("presets.modeReadOnly") : t(`presets.modeHelp.${selected}`));

  const change = async (next: string) => {
    if (!isWorkMode(next) || disabled || syncing || (isNew && busy)) return;
    setSyncing(true);
    setFailed(false);
    try {
      if (onSessionModeChange) {
        await onSessionModeChange(next);
      } else if (onChanged && await update({ type: "select", mode: next })) {
        onResolvedMode?.(next);
        await onChanged();
      }
    } catch {
      setFailed(true);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <label className="work-mode-selector" title={hint}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <path d="M4 6h3m5 0h8M4 12h9m5 0h2M4 18h3m5 0h8" />
        <circle cx="9.5" cy="6" r="2.5" /><circle cx="15.5" cy="12" r="2.5" /><circle cx="9.5" cy="18" r="2.5" />
      </svg>
      <select aria-label={t("presets.sessionMode")} value={selected}
        aria-describedby={pendingMode ? pendingId : undefined}
        disabled={disabled || syncing || (isNew ? !settings || busy : !onSessionModeChange)}
        onChange={(event) => void change(event.target.value)}>
        {WORK_MODES.map((item) => <option key={item} value={item}>{t(`presets.mode.${item}`)}</option>)}
      </select>
      {pendingMode && <span className="work-mode-pending" role="status" id={pendingId} title={pendingHint || undefined}>
        {t("presets.modePending", { mode: t(`presets.mode.${pendingMode}`) })}
      </span>}
      {(failed || (isNew && error)) && <span className="work-mode-error" role="alert" title={isNew ? error ?? undefined : undefined}>{t("presets.modeSaveFailed")}</span>}
      <style>{`
        .work-mode-selector { position: relative; flex-shrink: 0; display: inline-flex; align-items: center; gap: 4px; height: 32px; padding: 0 6px; border-radius: 9px; color: var(--text-muted); font-size: 12px; }
        .work-mode-selector:hover { background: var(--bg-hover); }
        .work-mode-selector select { color: inherit; background: transparent; border: 0; outline: none; font: inherit; height: 100%; max-width: 86px; cursor: pointer; }
        .work-mode-selector select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 5px; }
        .work-mode-selector select:disabled { opacity: .65; cursor: default; }
        .work-mode-selector option { background: var(--bg-panel); color: var(--text); }
        .work-mode-pending { color: var(--accent); white-space: nowrap; font-size: 10px; }
        .work-mode-error { position: absolute; left: 0; bottom: 100%; padding: 4px 8px; border-radius: 6px; background: var(--bg-panel); border: 1px solid var(--border); color: var(--error, #dc2626); white-space: nowrap; }
      `}</style>
    </label>
  );
}
