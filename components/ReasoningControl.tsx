"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { MODEL_THINKING_LEVELS, resolveThinkingLevelOption, type ThinkingLevelOption } from "@/lib/model-capabilities";

interface Props {
  modelName?: string;
  level: ThinkingLevelOption;
  supportedLevels?: readonly string[] | null;
  levelMap?: Record<string, string | null> | null;
  onChange: (level: ThinkingLevelOption) => Promise<void>;
  disabled?: boolean;
}

function Chevron() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
    </svg>
  );
}

export function ReasoningControl({ modelName, level, supportedLevels, levelMap, onChange, disabled }: Props) {
  const { t } = useI18n();
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<{ pointerId: number; level: ThinkingLevelOption } | null>(null);
  const changeVersionRef = useRef(0);
  const [open, setOpen] = useState(false);
  const [previewLevel, setPreviewLevel] = useState<ThinkingLevelOption | null>(null);
  const [pendingLevel, setPendingLevel] = useState<ThinkingLevelOption | null>(null);
  const supported = supportedLevels ?? MODEL_THINKING_LEVELS;
  const levels = useMemo<ThinkingLevelOption[]>(() => [
    "auto", ...MODEL_THINKING_LEVELS.filter((value) => supported.includes(value)),
  ], [supported]);
  const selectedLevel = resolveThinkingLevelOption(pendingLevel ?? level, supported);
  const displayLevel = previewLevel && levels.includes(previewLevel) ? previewLevel : selectedLevel;
  const index = levels.indexOf(displayLevel);
  const scaleMax = levels.length - 1;
  const showPanel = open && !disabled;
  const label = (value: ThinkingLevelOption) => value === "auto" ? t("chat.thinkingAuto") : levelMap?.[value] ?? value;

  const close = useCallback(() => {
    dragRef.current = null;
    setPreviewLevel(null);
    setOpen(false);
  }, []);

  const applyLevel = useCallback(async (next: ThinkingLevelOption) => {
    if (disabled || next === selectedLevel) return;
    const version = ++changeVersionRef.current;
    setPendingLevel(next);
    try {
      await onChange(next);
    } finally {
      if (version === changeVersionRef.current) setPendingLevel(null);
    }
  }, [disabled, onChange, selectedLevel]);

  useEffect(() => {
    if (!open) return;
    if (disabled) {
      close();
      return;
    }
    const dismissOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const finishDrag = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      dragRef.current = null;
      setPreviewLevel(null);
      if (event.type === "pointerup" && levels.includes(drag.level)) void applyLevel(drag.level);
    };
    document.addEventListener("pointerdown", dismissOutside);
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", finishDrag);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);
    };
  }, [applyLevel, close, disabled, levels, open]);

  return (
    <div
      ref={rootRef}
      className="reasoning-control"
      onKeyDown={(event) => {
        if (!showPanel || event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        close();
        triggerRef.current?.focus();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="reasoning-control-trigger"
        aria-label={t("chat.changeReasoningLabel")}
        title={t("chat.changeReasoning", { level: label(displayLevel) })}
        aria-expanded={showPanel}
        aria-controls={showPanel ? panelId : undefined}
        disabled={disabled}
        onClick={() => open ? close() : setOpen(true)}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
          <path d="M3 12V9m5 3V6m5 6V3" />
        </svg>
        <span>{label(displayLevel)}</span>
        <Chevron />
      </button>
      {showPanel && (
        <section id={panelId} aria-label={t("chat.reasoningLevel")} className="reasoning-popover ui-glass-menu">
          <div className="reasoning-popover-header">
            <span className="reasoning-model-name" title={modelName}>{modelName ?? t("chat.reasoningLevel")}</span>
            {scaleMax > 0 ? (
              <div className="reasoning-level-select">
                <select
                  aria-label={t("chat.reasoningLevel")}
                  value={displayLevel}
                  onChange={(event) => void applyLevel(levels[event.currentTarget.selectedIndex])}
                >
                  {levels.map((value) => <option key={value} value={value}>{label(value)}</option>)}
                </select>
                <Chevron />
              </div>
            ) : (
              <span className="reasoning-level-auto">{label("auto")}</span>
            )}
          </div>
          {scaleMax > 0 ? (
            <div className="reasoning-scale" style={{ "--reasoning-progress": index / scaleMax } as CSSProperties}>
              <div className="reasoning-scale-track" aria-hidden="true">
                <div className="reasoning-scale-fill" />
                <div className="reasoning-scale-ticks">
                  {levels.map((value, position) => <i key={value} data-filled={position <= index} />)}
                </div>
              </div>
              <input
                type="range"
                min={0}
                max={scaleMax}
                step={1}
                value={index}
                aria-label={t("chat.reasoningLevel")}
                aria-valuetext={label(displayLevel)}
                onPointerDown={(event) => {
                  if (event.button === 0 && event.isPrimary) {
                    dragRef.current = { pointerId: event.pointerId, level: displayLevel };
                  }
                }}
                onChange={(event) => {
                  const next = levels[event.currentTarget.valueAsNumber];
                  if (!next) return;
                  if (dragRef.current) {
                    dragRef.current.level = next;
                    setPreviewLevel(next);
                  } else {
                    void applyLevel(next);
                  }
                }}
              />
            </div>
          ) : (
            <p className="reasoning-auto-note">{t("chat.thinkingUseDefault")}</p>
          )}
        </section>
      )}
    </div>
  );
}
