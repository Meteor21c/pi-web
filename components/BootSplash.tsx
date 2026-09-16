"use client";

import Image from "next/image";
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * 品牌启动屏：金丝熊大 logo 居中偏上 + 品牌字标 + 当前检测项 + 进度条。
 * AuthGate 的账号检查与 RelayOnboarding 的自动配置共用，替代先后闪现的两页。
 *
 * 进度条：rAF 连续缓动（指数逼近目标 + 慢速爬行下限），阶段之间永远在动，
 * 不会出现"从一个阶段直接跳到另一个阶段"的观感。
 * 缩放：继承根元素 zoom（layout 初始化脚本已应用），高度用 --vp-h 防溢出。
 */

export interface BootSplashProps {
  /** 0..1，进度条目标位置（rAF 指数逼近，阶段间连续推进）。 */
  progress: number;
  /** 当前检测项文案（变化时淡入刷新）。 */
  label: string;
  /** 错误态：label 变红，并渲染 children 作为操作区（如"重试"按钮）。 */
  error?: boolean;
  /** true 时整屏隐藏（visibility），但保持挂载——rAF 进度不重置。 */
  hidden?: boolean;
  children?: ReactNode;
}

export function BootSplash({ progress, label, error = false, hidden = false, children }: BootSplashProps) {
  const targetRef = useRef(Math.max(0.06, Math.min(0.98, progress)));
  const [display, setDisplay] = useState(0.04);

  useEffect(() => {
    targetRef.current = Math.max(0.06, Math.min(0.98, progress));
  }, [progress]);

  useEffect(() => {
    const reduced = typeof window !== "undefined"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setDisplay(targetRef.current);
      return;
    }
    let raf = 0;
    let current = 0.04;
    const tick = () => {
      const target = targetRef.current;
      // 指数逼近 + 慢速爬行下限：永远在动，但不超过目标。
      current += (target - current) * 0.055;
      if (target - current > 0.0025) current += 0.0011;
      if (current >= target) current = target;
      setDisplay(current);
      if (current < 0.995) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      role="status"
      style={{
        height: "var(--vp-h, 100dvh)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "var(--bg)",
        color: "var(--text)",
        textAlign: "center",
        overflow: "hidden",
        position: "absolute",
        inset: 0,
        zIndex: 10,
        ...(hidden ? { visibility: "hidden", pointerEvents: "none" } : {}),
      }}
    >
      {/* 内容整体中间偏上；光晕铺在 logo 背后 */}
      <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", transform: "translateY(-9vh)" }}>
        <div
          className="ui-welcome-glow"
          aria-hidden="true"
          style={{
            position: "absolute",
            left: "50%",
            top: 66,
            width: 460,
            height: 260,
            transform: "translateX(-50%)",
            background: "radial-gradient(closest-side, color-mix(in srgb, var(--accent) 10%, transparent), transparent)",
            pointerEvents: "none",
          }}
        />

        <Image
          className="ui-welcome-logo"
          src="/icons/logo.png"
          alt="MeteorAgent"
          width={132}
          height={132}
          priority
          style={{ borderRadius: 30, objectFit: "cover" }}
        />
        <div style={{ marginTop: 18, fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em" }}>
          MeteorAgent
        </div>

        <div
          key={label}
          className="ui-splash-label"
          style={{
            marginTop: 14,
            minHeight: 22,
            fontSize: 14,
            lineHeight: 1.6,
            color: error ? "#f87171" : "var(--text-muted)",
          }}
        >
          {label}
        </div>

        <div
          aria-hidden="true"
          style={{
            marginTop: 18,
            width: 320,
            height: 8,
            borderRadius: 999,
            background: "color-mix(in srgb, var(--border) 55%, transparent)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${(display * 100).toFixed(2)}%`,
              height: "100%",
              borderRadius: 999,
              background: "var(--accent)",
              position: "relative",
              overflow: "hidden",
            }}
          >
            <span className="ui-progress-sheen" style={{ position: "absolute", inset: 0, display: "block" }} />
          </div>
        </div>

        {children && <div style={{ marginTop: 18 }}>{children}</div>}
      </div>
    </div>
  );
}
