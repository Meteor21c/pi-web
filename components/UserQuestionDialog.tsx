"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { ExtensionUiAnswer, ExtensionUiRequest } from "@/lib/types";
import { USER_QUESTION_ANSWER_LIMIT, type UserQuestionChoice } from "@/lib/user-questions";

type QuestionRequest = Extract<ExtensionUiRequest, { method: "question" }>;
type Draft = { selection: number | "custom" | null; text: string };

export function UserQuestionDialog({ request, onRespond }: {
  request: QuestionRequest;
  onRespond: (response: ExtensionUiAnswer) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [drafts, setDrafts] = useState<Draft[]>(() => request.questions.map(({ options }) => ({
    selection: options?.length ? null : "custom", text: "",
  })));
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const answers = drafts.flatMap<UserQuestionChoice>(({ selection, text }) => {
    if (typeof selection === "number") return [{ optionIndex: selection }];
    if (selection === "custom" && text.trim()) return [{ text: text.trim() }];
    return [];
  });

  useEffect(() => { titleRef.current?.focus({ preventScroll: true }); }, []);

  function update(index: number, patch: Partial<Draft>) {
    setDrafts((previous) => previous.map((draft, i) => i === index ? { ...draft, ...patch } : draft));
  }

  async function respond(response: ExtensionUiAnswer) {
    if (submitting) return;
    setSubmitting(true);
    setFailed(false);
    const accepted = await onRespond(response);
    if (!accepted) setFailed(true);
    setSubmitting(false);
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-[90] flex items-end justify-center p-3 sm:p-5">
      <form
        role="dialog"
        aria-labelledby={titleId}
        aria-busy={submitting}
        className="pointer-events-auto flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-bg shadow-2xl"
        onSubmit={(event) => {
          event.preventDefault();
          if (answers.length === request.questions.length) void respond({ answers });
        }}
      >
        <h2
          id={titleId}
          ref={titleRef}
          tabIndex={-1}
          className="shrink-0 border-b border-border px-4 py-3 text-sm font-semibold text-text outline-none"
        >
          {t("chat.userQuestion.title")}
        </h2>
        <div className="min-h-0 space-y-4 overflow-y-auto px-4 py-3">
          {request.questions.map(({ question, options }, index) => {
            const draft = drafts[index];
            const name = `${titleId}-${index}`;
            const optionClass = "flex cursor-pointer items-start gap-2.5 rounded-lg border border-border px-3 py-2 hover:bg-bg-hover focus-within:border-accent has-checked:border-accent has-checked:bg-bg-selected";
            return (
              <fieldset key={index} name={name} disabled={submitting} className="min-w-0">
                <legend className="mb-2 w-full whitespace-pre-wrap [overflow-wrap:anywhere] text-sm font-medium text-text">{question}</legend>
                {options?.length ? (
                  <div className="space-y-1.5">
                    {options.map(({ label, description }, optionIndex) => (
                      <label key={label} className={optionClass}>
                        <input type="radio" name={name} className="mt-0.5 shrink-0 accent-accent" checked={draft.selection === optionIndex}
                          onChange={() => update(index, { selection: optionIndex })} />
                        <span className="min-w-0 text-sm [overflow-wrap:anywhere]">
                          {label}
                          {description && <span className="mt-0.5 block text-xs text-text-muted">{description}</span>}
                        </span>
                      </label>
                    ))}
                    <label className={optionClass}>
                      <input type="radio" name={name} className="mt-0.5 shrink-0 accent-accent" checked={draft.selection === "custom"}
                        onChange={() => update(index, { selection: "custom" })} />
                      <span className="text-sm">{t("chat.userQuestion.custom")}</span>
                    </label>
                  </div>
                ) : null}
                {draft.selection === "custom" && (
                  <textarea
                    aria-label={`${t("chat.userQuestion.answer")} · ${question}`}
                    placeholder={t("chat.userQuestion.answer")}
                    rows={2}
                    maxLength={USER_QUESTION_ANSWER_LIMIT}
                    value={draft.text}
                    onChange={(event) => update(index, { text: event.target.value })}
                    className={`block w-full resize-y rounded-lg border border-border bg-bg-panel px-3 py-2 text-sm outline-none focus:border-accent ${options?.length ? "mt-2" : ""}`}
                  />
                )}
              </fieldset>
            );
          })}
        </div>
        <div className="shrink-0 border-t border-border bg-bg-panel px-4 py-2.5">
          {failed && <p role="alert" className="mb-2 text-xs text-text-muted">{t("chat.userQuestion.sendFailed")}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              disabled={submitting}
              onClick={() => void respond({ cancelled: true })}
              className="rounded-lg border border-border px-3 py-1.5 text-sm text-text-muted hover:bg-bg-hover disabled:opacity-50"
            >
              {t("chat.userQuestion.skip")}
            </button>
            <button
              type="submit"
              disabled={submitting || answers.length !== request.questions.length}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-[color:var(--accent-contrast)] enabled:hover:bg-accent-hover disabled:opacity-45"
            >
              {t("chat.userQuestion.send")}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
