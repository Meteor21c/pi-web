"use client";

import { useSyncExternalStore } from "react";

/**
 * 界面整体缩放（解决高分屏下组件/文字偏小）。
 *
 * 实现：对 <body> 施加 CSS zoom（现代浏览器已标准化），所有 px 布局等比放大。
 * - "auto"：按窗口宽度分档（≥2300px → 125%，≥1800px → 110%，否则 100%），
 *   监听 resize 重新计算；
 * - 手动档：100% / 110% / 125%，用户选择后固定，localStorage 持久化。
 */

export const UI_SCALE_STORAGE_KEY = "pi-ui-scale";
export const UI_SCALE_OPTIONS = ["auto", "100", "110", "125"] as const;
export type UiScaleOption = (typeof UI_SCALE_OPTIONS)[number];

const AUTO_BREAKPOINTS: Array<{ minWidth: number; scale: number }> = [
  { minWidth: 2300, scale: 1.25 },
  { minWidth: 1800, scale: 1.1 },
];

function clampOption(value: unknown): UiScaleOption {
  return UI_SCALE_OPTIONS.includes(value as UiScaleOption) ? (value as UiScaleOption) : "auto";
}

function readStoredPreference(): UiScaleOption {
  try {
    return clampOption(window.localStorage.getItem(UI_SCALE_STORAGE_KEY));
  } catch {
    return "auto";
  }
}

function resolveAutoScale(): number {
  if (typeof window === "undefined") return 1;
  const width = window.innerWidth;
  for (const breakpoint of AUTO_BREAKPOINTS) {
    if (width >= breakpoint.minWidth) return breakpoint.scale;
  }
  return 1;
}

function applyScale(preference: UiScaleOption): void {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const scale = preference === "auto" ? resolveAutoScale() : Number(preference) / 100;
  document.body.style.zoom = scale === 1 ? "" : String(scale);
}

interface UiScaleState {
  preference: UiScaleOption;
  scale: number;
}

const DEFAULT_STATE: UiScaleState = { preference: "auto", scale: 1 };

let state: UiScaleState | null = null;
const listeners = new Set<() => void>();
let resizeListenerAttached = false;

function ensureResizeListener(): void {
  if (resizeListenerAttached || typeof window === "undefined") return;
  window.addEventListener("resize", () => {
    if (!state || state.preference !== "auto") return;
    const nextScale = resolveAutoScale();
    if (nextScale === state.scale) return;
    state = { ...state, scale: nextScale };
    applyScale(state.preference);
    listeners.forEach((listener) => listener());
  });
  resizeListenerAttached = true;
}

function getSnapshot(): UiScaleState {
  if (typeof window === "undefined") return DEFAULT_STATE;
  if (!state) {
    const preference = readStoredPreference();
    state = {
      preference,
      scale: preference === "auto" ? resolveAutoScale() : Number(preference) / 100,
    };
    applyScale(preference);
    ensureResizeListener();
  }
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setUiScalePreference(option: UiScaleOption): void {
  state = { preference: option, scale: option === "auto" ? resolveAutoScale() : Number(option) / 100 };
  applyScale(option);
  try {
    window.localStorage.setItem(UI_SCALE_STORAGE_KEY, option);
  } catch {
    // 尽力而为的偏好持久化。
  }
  listeners.forEach((listener) => listener());
}

export function useUiScale() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_STATE);
  return { ...snapshot, setPreference: setUiScalePreference };
}
