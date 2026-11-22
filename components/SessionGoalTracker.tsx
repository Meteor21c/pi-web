"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import { MAX_SESSION_GOAL_LENGTH, type SessionGoal, type SessionGoalAction } from "@/lib/session-goal-types";
import styles from "./SessionGoalTracker.module.css";

interface Props {
  goal: SessionGoal | null;
  showCreate?: boolean;
  disabled?: boolean;
  running?: boolean;
  runningInGoalMode?: boolean;
  onChange: (action: SessionGoalAction) => Promise<void>;
}

export function SessionGoalTracker({ goal, showCreate, disabled, running, runningInGoalMode, onChange }: Props) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const optionsButtonRef = useRef<HTMLButtonElement>(null);
  const optionsId = useId();
  const editing = draft !== null;
  const objective = draft?.trim() ?? "";
  const title = t("chat.goal.title");
  const controlsDisabled = disabled || saving;
  const unfinished = goal?.status === "active" || goal?.status === "paused" || goal?.status === "blocked";
  const goalRunning = goal?.status === "active" && runningInGoalMode;
  const statusLabel = goalRunning ? "chat.goal.running" : goal ? `chat.goal.${goal.status}` : undefined;

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  const beginEditing = (value: string) => {
    setShowOptions(false);
    setDraft(value);
    setSaveFailed(false);
  };
  const closeEditor = () => {
    setDraft(null);
    setSaveFailed(false);
  };
  const applyAction = async (action: SessionGoalAction) => {
    if (controlsDisabled) return;
    setShowOptions(false);
    setSaving(true);
    setSaveFailed(false);
    try {
      await onChange(action);
      closeEditor();
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  };
  const saveObjective = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (objective) void applyAction({ type: "set", objective });
  };

  if (!goal && !showCreate && !editing) return null;

  return (
    <section className={`chat-reading-column ${styles.tracker}`} aria-label={title} aria-busy={saving} onKeyDown={(event) => {
      if (event.key !== "Escape" || !showOptions) return;
      event.stopPropagation();
      setShowOptions(false);
      optionsButtonRef.current?.focus();
    }}>
      <div className={styles.row}>
        <div className={styles.heading}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <circle cx="12" cy="12" r="5" />
            <circle cx="12" cy="12" r="1" />
          </svg>
          <span>{title}</span>
          {goal && statusLabel && <span role="status" className={styles.status} data-status={goal.status}>{t(statusLabel)}</span>}
        </div>
        {goal && !editing && <div className={styles.objective}>{goal.objective}</div>}
        {!editing && (
          <div className={styles.actions}>
            {unfinished ? (
              <>
                {goalRunning ? (
                  <button type="button" disabled={controlsDisabled} onClick={() => void applyAction({ type: "pause" })}>
                    {t("chat.goal.pause")}
                  </button>
                ) : (
                  <button type="button" className={styles.primary} disabled={controlsDisabled || running} onClick={() => void applyAction({ type: "resume" })}>
                    {t(goal.status === "active" ? "chat.goal.run" : "chat.goal.resume")}
                  </button>
                )}
                <button type="button" ref={optionsButtonRef} className={styles.optionsToggle} disabled={controlsDisabled} aria-label={t("chat.goal.options")} title={t("chat.goal.options")} aria-expanded={showOptions} aria-controls={optionsId} onClick={() => setShowOptions((open) => !open)}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" />
                  </svg>
                </button>
              </>
            ) : showCreate && (
              <button type="button" className={styles.primary} disabled={controlsDisabled} onClick={() => beginEditing("")}>
                {t(goal ? "chat.goal.startAnother" : "chat.goal.start")}
              </button>
            )}
          </div>
        )}
      </div>
      {unfinished && !editing && (
        <div id={optionsId} className={`${styles.actions} ${styles.options}`} hidden={!showOptions}>
          <button type="button" disabled={controlsDisabled} onClick={() => beginEditing(goal.objective)}>{t("chat.goal.edit")}</button>
          <button type="button" disabled={controlsDisabled} onClick={() => void applyAction({ type: "complete" })}>{t("chat.goal.complete")}</button>
          <button type="button" disabled={controlsDisabled} onClick={() => void applyAction({ type: "cancel" })}>{t("chat.goal.cancel")}</button>
        </div>
      )}
      {!editing && (goal?.reason || goal?.detail || goal?.evidence) && (
        <div className={styles.details}>
          {goal.reason && <p>{t(`chat.goal.reason.${goal.reason}`)}</p>}
          {goal.detail && <p className={styles.detailText}>{goal.detail}</p>}
          {goal.evidence && (
            <details>
              <summary>{t("chat.goal.evidence")}</summary>
              <p className={styles.detailText}>{goal.evidence}</p>
            </details>
          )}
        </div>
      )}
      {editing && (
        <form className={styles.form} onSubmit={saveObjective}>
          <textarea
            ref={textareaRef}
            aria-label={title}
            placeholder={t("chat.goal.placeholder")}
            value={draft}
            rows={2}
            maxLength={MAX_SESSION_GOAL_LENGTH}
            disabled={controlsDisabled}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className={styles.actions}>
            <button type="button" disabled={saving} onClick={closeEditor}>{t("i18n.cancel")}</button>
            <button type="submit" className={styles.primary} disabled={!objective || controlsDisabled}>
              {t(saving ? "i18n.saving" : "i18n.save")}
            </button>
          </div>
        </form>
      )}
      {running && editing && (
        <p className={styles.hint}>{t("chat.goal.appliesNextRun")}</p>
      )}
      {saveFailed && <p className={styles.error} role="alert">{t("chat.goal.saveFailed")}</p>}
    </section>
  );
}
