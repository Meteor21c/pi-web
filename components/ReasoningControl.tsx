"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
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

const SPARK_PATHS = [
  { x: 12, y: -11, scale: 1 },
  { x: 19, y: 8, scale: 0.75 },
  { x: 25, y: -3, scale: 0.55 },
] as const;
const SPARK_COUNT = SPARK_PATHS.length * 3;

interface SliderDrag {
  pointerId: number;
  origin: number;
  travel: number;
  inset: number;
  level: ThinkingLevelOption;
  levelsKey: string;
  lastSpark: number;
  showSparks: boolean;
}

function clampProgress(progress: number) {
  return Math.max(0, Math.min(1, progress));
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
  const scaleRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLSpanElement>(null);
  const sparksRef = useRef<HTMLDivElement>(null);
  const nextSparkRef = useRef(0);
  const dragRef = useRef<SliderDrag | null>(null);
  const changeVersionRef = useRef(0);
  const [open, setOpen] = useState(false);
  const [previewLevel, setPreviewLevel] = useState<ThinkingLevelOption | null>(null);
  const [pendingLevel, setPendingLevel] = useState<ThinkingLevelOption | null>(null);
  const supported = supportedLevels ?? MODEL_THINKING_LEVELS;
  const levels = useMemo<ThinkingLevelOption[]>(() => [
    "auto", ...MODEL_THINKING_LEVELS.filter((value) => supported.includes(value)),
  ], [supported]);
  const levelsKey = levels.join(",");
  const selectedLevel = resolveThinkingLevelOption(pendingLevel ?? level, supported);
  const displayLevel = previewLevel && levels.includes(previewLevel) ? previewLevel : selectedLevel;
  const index = levels.indexOf(displayLevel);
  const scaleMax = levels.length - 1;
  const showPanel = open && !disabled;
  const label = (value: ThinkingLevelOption) => value === "auto" ? t("chat.thinkingAuto") : levelMap?.[value] ?? value;

  const clearDrag = useCallback(() => {
    dragRef.current = null;
    const scale = scaleRef.current;
    if (scale) {
      delete scale.dataset.dragging;
      scale.style.removeProperty("--reasoning-drag-progress");
    }
    setPreviewLevel(null);
  }, []);

  const close = useCallback(() => {
    clearDrag();
    setOpen(false);
  }, [clearDrag]);

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

  function emitSparks(left: number, direction: number) {
    const sparks = sparksRef.current;
    if (!sparks) return;
    for (const path of SPARK_PATHS) {
      const spark = sparks.children[nextSparkRef.current] as HTMLElement;
      nextSparkRef.current = (nextSparkRef.current + 1) % SPARK_COUNT;
      spark.getAnimations().forEach((animation) => animation.cancel());
      spark.style.left = `${left}px`;
      const x = -direction * path.x;
      spark.animate([
        { transform: `translateY(-50%) scale(${path.scale})`, opacity: 0.95, easing: "ease-out" },
        { transform: `translate(${x * 0.72}px, ${path.y * 0.85}px) scale(${path.scale * 0.85})`, opacity: 0.75, offset: 0.42 },
        { transform: `translate(${x}px, ${path.y}px) scale(0.2)`, opacity: 0 },
      ], { duration: 360 });
    }
  }

  function previewDrag(drag: SliderDrag, clientX: number) {
    const progress = clampProgress((clientX - drag.origin) / drag.travel);
    scaleRef.current?.style.setProperty("--reasoning-drag-progress", String(progress));
    const next = levels[Math.round(progress * scaleMax)];
    if (next !== drag.level) {
      drag.level = next;
      setPreviewLevel(next);
    }
    const distance = (progress - drag.lastSpark) * drag.travel;
    if (drag.showSparks && Math.abs(distance) >= 15) {
      emitSparks(drag.inset + progress * drag.travel, Math.sign(distance));
      drag.lastSpark = progress;
    }
  }

  function beginDrag(event: ReactPointerEvent<HTMLInputElement>) {
    const scale = scaleRef.current;
    const thumb = thumbRef.current?.getBoundingClientRect();
    if (!scale || !thumb || dragRef.current || event.button !== 0 || !event.isPrimary) return;
    const input = event.currentTarget;
    const bounds = input.getBoundingClientRect();
    const travel = bounds.width - thumb.width;
    if (travel <= 0) return;
    const start = bounds.left + thumb.width / 2;
    const thumbCenter = thumb.left + thumb.width / 2;
    const grip = event.clientX - thumbCenter;
    const drag = {
      pointerId: event.pointerId,
      origin: start + (Math.abs(grip) <= thumb.width / 2 ? grip : 0),
      travel,
      inset: thumb.width / 2,
      level: displayLevel,
      levelsKey,
      lastSpark: clampProgress((thumbCenter - start) / travel),
      showSparks: !window.matchMedia("(prefers-reduced-motion: reduce), (forced-colors: active)").matches,
    };
    event.preventDefault();
    input.focus({ preventScroll: true });
    input.setPointerCapture(event.pointerId);
    dragRef.current = drag;
    scale.dataset.dragging = "true";
    previewDrag(drag, event.clientX);
  }

  function finishDrag(event: ReactPointerEvent<HTMLInputElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.type === "pointerup" && drag.levelsKey === levelsKey) {
      const progress = clampProgress((event.clientX - drag.origin) / drag.travel);
      void applyLevel(levels[Math.round(progress * scaleMax)]);
    }
    clearDrag();
  }

  useEffect(() => {
    if (dragRef.current && dragRef.current.levelsKey !== levelsKey) clearDrag();
  }, [clearDrag, levelsKey]);

  useEffect(() => {
    if (!open) return;
    if (disabled) {
      close();
      return;
    }
    const dismissOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, [close, disabled, open]);

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
            <div ref={scaleRef} className="reasoning-scale" style={{ "--reasoning-progress": index / scaleMax } as CSSProperties}>
              <div className="reasoning-scale-track" aria-hidden="true">
                <div className="reasoning-scale-fill" />
                <div className="reasoning-scale-ticks">
                  {levels.map((value, position) => <i key={value} data-filled={position <= index} />)}
                </div>
              </div>
              <div ref={sparksRef} className="reasoning-scale-sparks" aria-hidden="true">
                {Array.from({ length: SPARK_COUNT }, (_, index) => <i key={index} />)}
              </div>
              <div className="reasoning-scale-cursor" aria-hidden="true">
                <span ref={thumbRef} className="reasoning-scale-thumb" />
              </div>
              <input
                type="range"
                min={0}
                max={scaleMax}
                step={1}
                value={index}
                aria-label={t("chat.reasoningLevel")}
                aria-valuetext={label(displayLevel)}
                onPointerDown={beginDrag}
                onPointerMove={(event) => {
                  const drag = dragRef.current;
                  if (drag?.pointerId === event.pointerId && drag.levelsKey === levelsKey) previewDrag(drag, event.clientX);
                }}
                onPointerUp={finishDrag}
                onPointerCancel={finishDrag}
                onLostPointerCapture={finishDrag}
                onChange={(event) => {
                  const next = levels[event.currentTarget.valueAsNumber];
                  if (next && !dragRef.current) void applyLevel(next);
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
