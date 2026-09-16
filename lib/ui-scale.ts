/**
 * 界面缩放共享常量与首帧内联脚本（无 "use client"，供 layout 直接引入）。
 *
 * zoom 分档逻辑必须与 hooks/useUiScale.ts 保持一致：
 * auto 档按窗口宽度：≥2300px → 125%，≥1800px → 110%，否则 100%。
 */

export const UI_SCALE_STORAGE_KEY = "pi-ui-scale";
export const UI_SCALE_OPTIONS = ["auto", "100", "110", "125"] as const;
export type UiScaleOption = (typeof UI_SCALE_OPTIONS)[number];

export const UI_SCALE_AUTO_BREAKPOINTS: Array<{ minWidth: number; scale: number }> = [
  { minWidth: 2300, scale: 1.25 },
  { minWidth: 1800, scale: 1.1 },
];

export function resolveAutoScaleFor(width: number): number {
  for (const breakpoint of UI_SCALE_AUTO_BREAKPOINTS) {
    if (width >= breakpoint.minWidth) return breakpoint.scale;
  }
  return 1;
}

export function clampUiScaleOption(value: unknown): UiScaleOption {
  return UI_SCALE_OPTIONS.includes(value as UiScaleOption) ? (value as UiScaleOption) : "auto";
}

/**
 * 首帧防闪烁：在 React 水合前读取偏好并应用 zoom。
 * 必须放在 <body> 起始处执行（此时 documentElement 已存在）。
 *
 * zoom 施加在 <html>（根元素）而非 body：根级 zoom 会同步缩放初始包含块，
 * vh/dvh、position:fixed 与底部锚定布局都按浏览器原生缩放语义工作，
 * 不会出现 body 缩放把 100dvh 外壳撑出视口、底部元素被推出屏幕的问题。
 */
export const UI_SCALE_INIT_SCRIPT = `(function(){try{var p=localStorage.getItem("${UI_SCALE_STORAGE_KEY}")||"auto";var w=window.innerWidth;var s=p==="auto"?(${UI_SCALE_AUTO_BREAKPOINTS.map((b) => `w>=${b.minWidth}?${b.scale}`).join(":")}:1):Number(p)/100;var d=document.documentElement;d.style.setProperty("--ui-scale",String(s));if(s&&s!==1)d.style.zoom=String(s);}catch(e){}})();`;

type ZoomableStyle = CSSStyleDeclaration & { zoom?: string | number };

/** 当前生效的界面缩放系数（读 <html> 的 computed zoom；未缩放时为 1）。 */
export function currentUiScale(): number {
  if (typeof document === "undefined") return 1;
  const raw = (getComputedStyle(document.documentElement) as ZoomableStyle).zoom;
  const zoom = typeof raw === "string" ? Number.parseFloat(raw) : raw;
  return typeof zoom === "number" && Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

/**
 * 把"视觉像素"换算为"CSS 像素"。
 * getBoundingClientRect / window.innerWidth 等返回的是视觉像素（已含缩放），
 * 而给 position:fixed 元素设置的 CSS px 会被根 zoom 再次放大——
 * 因此凡是「量出来的坐标 → 写进 fixed 样式」都必须先除以缩放系数。
 */
export function divideByUiScale(value: number): number {
  return value / currentUiScale();
}
