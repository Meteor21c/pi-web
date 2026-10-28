"use client";

import { useEffect, useState } from "react";
import { usePromptPresets } from "@/hooks/usePromptPresets";
import { sendAgentCommand } from "@/lib/agent-client";
import type { SessionPromptSelection } from "@/lib/prompt-presets";

type Translate = (key: string, params?: Record<string, string | number>) => string;

interface Props {
  loading: boolean;
  prompt: string | null;
  translate: Translate;
  sessionId: string | null;
  onManagePresets: () => void;
  onSelectionChanged: () => Promise<void>;
}

export function SystemPromptPanel({ loading, prompt, translate, sessionId, onManagePresets, onSelectionChanged }: Props) {
  const { settings, busy, error, update, reload } = usePromptPresets();
  const [applied, setApplied] = useState<SessionPromptSelection | null>(null);
  const [appliedLoaded, setAppliedLoaded] = useState(false);
  const [appliedError, setAppliedError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setAppliedLoaded(false);
    setAppliedError(false);
    if (!sessionId) return;
    void sendAgentCommand<SessionPromptSelection | null>(sessionId, { type: "get_prompt_selection" })
      .then((selection) => {
        if (!cancelled) { setApplied(selection); setAppliedLoaded(true); }
      }).catch(() => { if (!cancelled) setAppliedError(true); });
    return () => { cancelled = true; };
  }, [sessionId]);

  const select = async (action: Record<string, unknown>) => {
    if (await update({ type: "select", ...action })) {
      // Refresh preview for a still-empty composer. Started conversations keep
      // their persisted selection even when the next-conversation default changes.
      await onSelectionChanged().catch(() => {});
    }
  };

  return (
    <section className="system-prompt-panel ui-glass-menu" aria-label={translate("system.prompt")}>
      <header className="system-prompt-heading">
        <span className="top-panel-heading-icon" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="8" y1="13" x2="16" y2="13" />
            <line x1="8" y1="17" x2="13" y2="17" />
          </svg>
        </span>
        <div className="system-prompt-heading-copy top-panel-heading-copy">
          <strong>{translate("system.label")}</strong>
          <small>{translate("system.description")}</small>
        </div>
      </header>
      <div className="system-prompt-scroll">
        <div className="system-prompt-presets">
          <div className="system-prompt-preset-title"><strong>{translate("presets.forNew")}</strong>
            <button type="button" onClick={onManagePresets}>{translate("presets.manage")}</button>
          </div>
          <label className="system-prompt-preset-picker">{translate("presets.additional")}
            <select value={settings?.selectedPresetId ?? ""} disabled={!settings || busy}
              onChange={(event) => void select({ selectedPresetId: event.target.value || null })}>
              <option value="">{translate("presets.none")}</option>
              {settings?.presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
            </select>
          </label>
          <p className="system-prompt-hint" role="status">{busy ? translate("presets.saving") : translate("presets.nextOnly")}</p>
          {error && <p role="alert" className="settings-general-error">{translate("presets.failed")} {error} <button type="button" onClick={() => void reload()}>{translate("presets.retry")}</button></p>}
          {sessionId && <div className="system-prompt-applied">
            <strong>{translate("presets.current")}</strong>
            <span>{appliedError ? translate("presets.failed") : !appliedLoaded ? translate("presets.loading")
              : applied?.preset?.name ?? translate("presets.none")}</span>
            {applied?.preset && <details><summary>{translate("presets.viewApplied")}</summary><div className="system-prompt-text">{applied.preset.content}</div></details>}
          </div>}
        </div>
        <details className="system-prompt-full"><summary>{translate("presets.fullRules")} <span>{translate("system.readOnly")}</span></summary>
        {prompt ? (
          <div className="system-prompt-text">{prompt}</div>
        ) : (
          <div className="system-prompt-empty">
            {prompt === ""
              ? translate("system.empty")
              : loading
                ? translate("system.loading")
                : translate("system.load")}
          </div>
        )}
        </details>
      </div>

      <style>{`
        .system-prompt-panel {
          display: flex;
          width: calc(560px * var(--ui-scale, 1));
          height: min(calc(600px * var(--ui-scale, 1)), 72dvh);
          min-height: 220px;
          flex-direction: column;
          overflow: hidden;
        }
        .system-prompt-heading {
          align-items: center;
          justify-content: flex-start;
          gap: 10px;
        }
        .system-prompt-heading-copy {
          flex: 1;
        }
        .system-prompt-scroll {
          min-height: 0;
          flex: 1;
          overflow: auto;
          padding: 12px 16px;
        }
        .system-prompt-presets { display: grid; gap: 10px; margin-bottom: 18px; }
        .system-prompt-preset-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
        .system-prompt-preset-title strong { font-size: 13px; }
        .system-prompt-preset-title button { color: var(--accent); cursor: pointer; font-size: 12px; }
        .system-prompt-preset-picker select:disabled { cursor: wait; opacity: .6; }
        .system-prompt-hint { margin: 0; font-size: 12px; color: var(--text-muted); line-height: 1.6; }
        .system-prompt-preset-picker { display: grid; gap: 6px; font-size: 12px; color: var(--text-muted); }
        .system-prompt-preset-picker select { width: 100%; padding: 9px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-panel); color: var(--text); font-size: 13px; }
        .system-prompt-applied { display: grid; gap: 6px; padding: 12px; border-radius: 10px; background: var(--bg-hover); font-size: 12px; overflow-wrap: anywhere; }
        .system-prompt-applied strong { color: var(--text-muted); font-weight: 500; }
        .system-prompt-applied summary { cursor: pointer; color: var(--accent); padding-top: 4px; }
        .system-prompt-applied .system-prompt-text { padding-top: 8px; }
        .system-prompt-full { border-top: 1px solid var(--border); padding-top: 12px; }
        .system-prompt-full > summary { cursor: pointer; font-size: 12px; color: var(--text-muted); padding: 4px 0 12px; }
        .system-prompt-full > summary span { margin-left: 6px; font-size: 11px; opacity: .7; }
        .system-prompt-text {
          color: var(--text-muted);
          font-family: var(--font-mono);
          font-size: 12px;
          line-height: 1.6;
          overflow-wrap: anywhere;
          white-space: pre-wrap;
        }
        .system-prompt-empty {
          padding: 10px 0;
          color: var(--text-muted);
          font-size: 12px;
          font-style: italic;
        }
      `}</style>
    </section>
  );
}
