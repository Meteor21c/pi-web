"use client";

import { useId, useRef } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { ComputerUseApprovalPolicy } from "@/lib/computer-use-approval-policy";
import styles from "./ApprovalPolicySelector.module.css";

interface Props {
  policy: ComputerUseApprovalPolicy;
  currentRunPolicy?: ComputerUseApprovalPolicy;
  onChange: (policy: ComputerUseApprovalPolicy) => void;
  disabled?: boolean;
}

export function ApprovalPolicySelector({ policy, currentRunPolicy, onChange, disabled }: Props) {
  const { t } = useI18n();
  const titleId = useId();
  const descriptionId = useId();
  const runNoteId = useId();
  const selectorRef = useRef<HTMLSelectElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const queuedChange = currentRunPolicy !== undefined && currentRunPolicy !== policy && !disabled;
  const runNote = currentRunPolicy && t("chat.approvalPolicy.runNote", { policy: t(`chat.approvalPolicy.${currentRunPolicy}`) });

  const choosePolicy = (next: string) => {
    if (disabled || next === policy) return;
    if (next === "ask") onChange("ask");
    if (next === "full") {
      dialogRef.current?.showModal();
      cancelRef.current?.focus();
    }
  };

  return (
    <>
      <label className={styles.selector} data-policy={policy} title={runNote}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 22s7-3.5 7-9.5V6l-7-3-7 3v6.5c0 6 7 9.5 7 9.5Z" />
          {policy === "full" ? <path d="M12 8v4m0 3h.01" /> : <path d="m9.5 12 1.5 1.5 3.5-3.5" />}
        </svg>
        <select
          ref={selectorRef}
          aria-label={t("chat.approvalPolicy")}
          aria-describedby={runNote ? runNoteId : undefined}
          value={policy}
          disabled={disabled}
          onChange={(event) => choosePolicy(event.target.value)}
        >
          <option value="ask">{t("chat.approvalPolicy.ask")}</option>
          <option value="full">{t("chat.approvalPolicy.full")}</option>
        </select>
        {runNote && <span id={runNoteId} className="sr-only">{runNote}</span>}
        {queuedChange && <span className={styles.nextRun} aria-hidden="true">{t("chat.approvalPolicy.nextRun")}</span>}
      </label>
      <dialog
        ref={dialogRef}
        className={styles.warning}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onClose={() => selectorRef.current?.focus({ preventScroll: true })}
        onKeyDown={(event) => {
          if (event.key === "Escape") event.stopPropagation();
        }}
      >
        <h2 className={styles.warningTitle} id={titleId}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10.3 4.9 2.5 18a1.8 1.8 0 0 0 1.6 2.7h15.8a1.8 1.8 0 0 0 1.6-2.7L13.7 4.9a2 2 0 0 0-3.4 0Z" />
            <path d="M12 9v4m0 3.5h.01" />
          </svg>
          {t("chat.approvalPolicy.warningTitle")}
        </h2>
        <p className={styles.warningText} id={descriptionId}>{t("chat.approvalPolicy.warning")}</p>
        <div className={styles.actions}>
          <button ref={cancelRef} type="button" onClick={() => dialogRef.current?.close()}>
            {t("chat.cancel")}
          </button>
          <button
            type="button"
            className={styles.enable}
            disabled={disabled}
            onClick={() => {
              dialogRef.current?.close();
              if (!disabled) onChange("full");
            }}
          >
            {t("chat.approvalPolicy.enableFull")}
          </button>
        </div>
      </dialog>
    </>
  );
}
