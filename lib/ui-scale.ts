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
 * 必须放在 <body> 起始处执行（此时 document.body 已存在）。
 */
export const UI_SCALE_INIT_SCRIPT = `(function(){try{var p=localStorage.getItem("${UI_SCALE_STORAGE_KEY}")||"auto";var w=window.innerWidth;var s=p==="auto"?(${UI_SCALE_AUTO_BREAKPOINTS.map((b) => `w>=${b.minWidth}?${b.scale}`).join(":")}:1):Number(p)/100;if(s&&s!==1)document.body.style.zoom=String(s);}catch(e){}})();`;
