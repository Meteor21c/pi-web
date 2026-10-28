"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { usePromptPresets } from "@/hooks/usePromptPresets";
import { WORK_MODES, type WorkMode } from "@/lib/prompt-presets";

interface Props {
  mode: WorkMode;
  editable: boolean;
  disabled: boolean;
  onChanged: () => Promise<void>;
}

/** Composer control: new chats use the default; started chats show their snapshot. */
export function WorkModeSelector({ mode, editable, disabled, onChanged }: Props) {
  const { t } = useI18n();
  const { settings, busy, error, update } = usePromptPresets();
  const [syncing, setSyncing] = useState(false);
  const selected = editable ? settings?.mode ?? "auto" : mode;
  const hint = editable ? t(`presets.modeHelp.${selected}`) : t("presets.modeLocked");

  const change = async (next: string) => {
    if (!editable || disabled || busy || syncing) return;
    setSyncing(true);
    try {
      if (await update({ type: "select", mode: next })) await onChanged();
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
      <select aria-label={t("presets.newMode")} value={selected}
        disabled={disabled || !editable || !settings || busy || syncing}
        onChange={(event) => void change(event.target.value).catch(() => {})}>
        {WORK_MODES.map((item) => <option key={item} value={item}>{t(`presets.mode.${item}`)}</option>)}
      </select>
      {error && <span className="work-mode-error" role="alert" title={error}>{t("presets.modeSaveFailed")}</span>}
      <style>{`
        .work-mode-selector { position: relative; flex-shrink: 0; display: inline-flex; align-items: center; gap: 4px; height: 32px; padding: 0 6px; border-radius: 9px; color: var(--text-muted); font-size: 12px; }
        .work-mode-selector:hover { background: var(--bg-hover); }
        .work-mode-selector select { color: inherit; background: transparent; border: 0; outline: none; font: inherit; height: 100%; max-width: 86px; cursor: pointer; }
        .work-mode-selector select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 5px; }
        .work-mode-selector select:disabled { opacity: .65; cursor: default; }
        .work-mode-selector option { background: var(--bg-panel); color: var(--text); }
        .work-mode-error { position: absolute; left: 0; bottom: 100%; padding: 4px 8px; border-radius: 6px; background: var(--bg-panel); border: 1px solid var(--border); color: var(--error, #dc2626); white-space: nowrap; }
      `}</style>
    </label>
  );
}
