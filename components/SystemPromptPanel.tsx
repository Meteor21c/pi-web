"use client";

import { useEffect, useState } from "react";
import { usePromptPresets } from "@/hooks/usePromptPresets";
import { sendAgentCommand } from "@/lib/agent-client";
import { MAX_PRESET_CONTENT_LENGTH, METEORAGENT_DEFAULT_PROMPT_ID, type SessionPromptSelection } from "@/lib/prompt-presets";

type Translate = (key: string, params?: Record<string, string | number>) => string;

interface Props {
  loading: boolean;
  prompt: string | null;
  translate: Translate;
  sessionId: string | null;
  onManagePresets: () => void;
  onSelectionChanged: () => Promise<void>;
}

interface PromptSelectionInfo {
  selection: SessionPromptSelection | null;
  baseSystemPrompt: string;
}

export function SystemPromptPanel({ loading, prompt, translate, sessionId, onManagePresets, onSelectionChanged }: Props) {
  const { settings, busy, error, update, reload } = usePromptPresets();
  const [applied, setApplied] = useState<SessionPromptSelection | null>(null);
  const [baseSystemPrompt, setBaseSystemPrompt] = useState("");
  const [defaultPromptDraft, setDefaultPromptDraft] = useState("");
  const [editingDefault, setEditingDefault] = useState(false);
  const [appliedLoaded, setAppliedLoaded] = useState(false);
  const [appliedError, setAppliedError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setAppliedLoaded(false);
    setAppliedError(false);
    if (!sessionId) return;
    void sendAgentCommand<PromptSelectionInfo>(sessionId, { type: "get_prompt_selection" })
      .then((info) => {
        if (!cancelled) {
          setApplied(info.selection);
          setBaseSystemPrompt(info.baseSystemPrompt);
          setDefaultPromptDraft(settings?.defaultSystemPrompt ?? info.baseSystemPrompt);
          setAppliedLoaded(true);
        }
      }).catch(() => { if (!cancelled) setAppliedError(true); });
    return () => { cancelled = true; };
  }, [sessionId, settings?.defaultSystemPrompt]);

  useEffect(() => {
    if (!editingDefault) setDefaultPromptDraft(settings?.defaultSystemPrompt ?? baseSystemPrompt);
  }, [baseSystemPrompt, editingDefault, settings?.defaultSystemPrompt]);

  const select = async (action: Record<string, unknown>) => {
    if (await update({ type: "select", ...action })) {
      // Refresh preview for a still-empty composer. Started conversations keep
      // their persisted selection even when the next-conversation default changes.
      await onSelectionChanged().catch(() => {});
    }
  };

  const saveDefaultPrompt = async () => {
    if (!defaultPromptDraft.trim()) return;
    if (await update({ type: "set_default_prompt", prompt: defaultPromptDraft })) {
      setEditingDefault(false);
      await onSelectionChanged().catch(() => {});
    }
  };

  const resetDefaultPrompt = async () => {
    if (await update({ type: "set_default_prompt", prompt: null })) {
      setEditingDefault(false);
      setDefaultPromptDraft(baseSystemPrompt);
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
          <label className="system-prompt-preset-picker">{translate("presets.systemPrompt")}
            <select value={settings?.selectedPresetId ?? ""} disabled={!settings || busy}
              onChange={(event) => void select({ selectedPresetId: event.target.value || null })}>
              <option value="">{settings?.defaultSystemPrompt ? translate("presets.magentDefaultCustom") : translate("presets.magentDefault")}</option>
              {settings?.presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
            </select>
          </label>
          <p className="system-prompt-hint" role="status">{busy ? translate("presets.saving") : translate("presets.nextOnly")}</p>
          {error && <p role="alert" className="settings-general-error">{translate("presets.failed")} {error} <button type="button" onClick={() => void reload()}>{translate("presets.retry")}</button></p>}
          {sessionId && <div className="system-prompt-applied">
            <strong>{translate("presets.current")}</strong>
            <span>{appliedError ? translate("presets.failed") : !appliedLoaded ? translate("presets.loading")
              : applied?.preset?.id === METEORAGENT_DEFAULT_PROMPT_ID
                ? translate("presets.magentDefault")
                : applied?.preset?.name ?? translate("presets.magentDefault")}</span>
            {applied?.preset && <details><summary>{translate("presets.viewApplied")}</summary><div className="system-prompt-text">{applied.preset.content}</div></details>}
          </div>}
          <div className="system-prompt-default-editor">
            <div className="system-prompt-preset-title">
              <strong>{translate("presets.magentDefault")}</strong>
              {!editingDefault && <button type="button" disabled={!baseSystemPrompt && !settings?.defaultSystemPrompt} onClick={() => setEditingDefault(true)}>{translate("presets.editDefault")}</button>}
            </div>
            <p className="system-prompt-hint">{translate("presets.defaultPromptHelp")}</p>
            {editingDefault && <>
              <textarea aria-label={translate("presets.magentDefault")} value={defaultPromptDraft} maxLength={MAX_PRESET_CONTENT_LENGTH}
                onChange={(event) => setDefaultPromptDraft(event.target.value)} disabled={busy || (!appliedLoaded && !settings?.defaultSystemPrompt)}
                placeholder={translate("presets.defaultPromptPlaceholder")} />
              <div className="system-prompt-default-actions">
                <span>{defaultPromptDraft.length.toLocaleString()} / {MAX_PRESET_CONTENT_LENGTH.toLocaleString()}</span>
                <div>
                  {settings?.defaultSystemPrompt && <button type="button" disabled={busy} onClick={() => void resetDefaultPrompt()}>{translate("presets.resetDefault")}</button>}
                  <button type="button" disabled={busy} onClick={() => { setEditingDefault(false); setDefaultPromptDraft(settings?.defaultSystemPrompt ?? baseSystemPrompt); }}>{translate("presets.cancelEdit")}</button>
                  <button type="button" disabled={busy || !defaultPromptDraft.trim() || defaultPromptDraft === settings?.defaultSystemPrompt} onClick={() => void saveDefaultPrompt()}>{translate("presets.save")}</button>
                </div>
              </div>
            </>}
          </div>
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
        .system-prompt-default-editor { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-panel); }
        .system-prompt-default-editor textarea { width: 100%; min-height: 180px; max-height: 38dvh; resize: vertical; overflow: auto; padding: 9px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); font: 12px/1.6 var(--font-mono); white-space: pre-wrap; }
        .system-prompt-default-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 11px; color: var(--text-dim); }
        .system-prompt-default-actions > div { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
        .system-prompt-default-actions button { padding: 5px 8px; border: 1px solid var(--border); border-radius: 7px; color: var(--text); cursor: pointer; }
        .system-prompt-default-actions button:last-child { border-color: var(--accent); color: var(--accent); }
        .system-prompt-default-actions button:disabled { opacity: .5; cursor: not-allowed; }
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
