"use client";

import { useEffect, useState, type RefObject } from "react";
import Image from "next/image";
import { useI18n } from "@/hooks/useI18n";
import { useRelaySession } from "@/hooks/useRelaySession";
import type { AppUpdateResponse } from "@/lib/api-types";
import type { ChatInputHandle } from "./ChatInput";

type WeatherInfo = { text: string; tempC: number };

const WEATHER_CACHE_KEY = "pi-web:welcome-weather";
const WEATHER_CACHE_TTL_MS = 30 * 60 * 1000;
const TIP_ROTATE_MS = 4500;

async function fetchWeather(): Promise<WeatherInfo | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const response = await fetch("https://wttr.in/?format=j1", { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const data = (await response.json()) as {
      current_condition?: Array<{ temp_C?: string; lang_zh?: Array<{ value?: string }>; weatherDesc?: Array<{ value?: string }> }>;
    };
    const current = data.current_condition?.[0];
    if (!current) return null;
    const temp = Number(current.temp_C);
    if (!Number.isFinite(temp)) return null;
    const text = current.lang_zh?.[0]?.value ?? current.weatherDesc?.[0]?.value ?? "";
    return { text, tempC: temp };
  } catch {
    return null;
  }
}

function readCachedWeather(): WeatherInfo | null {
  try {
    const raw = localStorage.getItem(WEATHER_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at?: number; info?: WeatherInfo };
    if (!parsed.info || typeof parsed.at !== "number") return null;
    if (Date.now() - parsed.at > WEATHER_CACHE_TTL_MS) return null;
    return parsed.info;
  } catch {
    return null;
  }
}

function greetingKey(hour: number): string {
  if (hour < 6) return "chat.welcomeEvening";
  if (hour < 12) return "chat.welcomeMorning";
  if (hour < 18) return "chat.welcomeAfternoon";
  return "chat.welcomeEvening";
}

export function NewSessionWelcome({ isMobile, chatInputRef }: { isMobile: boolean; chatInputRef?: RefObject<ChatInputHandle | null> }) {
  const { t, locale } = useI18n();
  const { user } = useRelaySession();
  const [weather, setWeather] = useState<WeatherInfo | null>(null);
  const [update, setUpdate] = useState<AppUpdateResponse | null>(null);
  const [tipIndex, setTipIndex] = useState(0);

  useEffect(() => {
    const cached = readCachedWeather();
    if (cached) {
      setWeather(cached);
    } else {
      void fetchWeather().then((info) => {
        if (!info) return;
        try {
          localStorage.setItem(WEATHER_CACHE_KEY, JSON.stringify({ at: Date.now(), info }));
        } catch {}
        setWeather(info);
      });
    }

    const controller = new AbortController();
    void fetch("/api/app-update", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json() as Promise<AppUpdateResponse>;
      })
      .then((result) => {
        if (result?.updateAvailable && result.latestVersion && result.releaseUrl) {
          setUpdate(result);
        }
      })
      .catch(() => {
        // 更新检查是尽力而为的，不应打断新会话。
      });
    return () => controller.abort();
  }, []);

  const tips = [t("chat.welcomeTip1"), t("chat.welcomeTip2"), t("chat.welcomeTip3")];
  useEffect(() => {
    const timer = setInterval(() => {
      setTipIndex((index) => (index + 1) % tips.length);
    }, TIP_ROTATE_MS);
    return () => clearInterval(timer);
  }, [tips.length]);

  const hour = new Date().getHours();
  const username = user?.username?.trim() || user?.email?.trim()?.split("@")[0] || "";
  const dateLabel = new Intl.DateTimeFormat(locale, { month: "long", day: "numeric", weekday: "long" }).format(new Date());

  const applyTip = (tip: string) => {
    chatInputRef?.current?.insertIfEmpty(tip);
  };

  return (
    <div className="w-full" style={{ paddingLeft: 16, paddingRight: isMobile ? 16 : 52 }}>
      <div style={{ position: "relative", maxWidth: "var(--chat-content-max-width, 820px)", margin: "0 auto" }}>
        {/* 装饰性呼吸光晕 */}
        <div
          className="ui-welcome-glow"
          aria-hidden="true"
          style={{
            position: "absolute",
            top: -90,
            left: "50%",
            width: 420,
            height: 240,
            transform: "translateX(-50%)",
            background: "radial-gradient(closest-side, color-mix(in srgb, var(--accent) 9%, transparent), transparent)",
            pointerEvents: "none",
          }}
        />

        {/* Brand row */}
        <div className="ui-welcome-brand" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 30 }}>
          <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 8 : 12, minWidth: 0 }}>
            <Image className="ui-welcome-logo" src="/icons/meteoragent-touch.png" width={40} height={40} alt="" priority style={{ flexShrink: 0, borderRadius: 10 }} />
            <span style={{ fontSize: 26, color: "var(--text)", fontWeight: 700, letterSpacing: "-0.02em", whiteSpace: "nowrap" }}>MeteorAgent</span>
            {update && (
              <a
                href={update.releaseUrl}
                target="_blank"
                rel="noopener noreferrer"
                title={t("appUpdate.releaseNotes", { version: update.latestVersion })}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 3,
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--accent)",
                  background: "color-mix(in srgb, var(--accent) 10%, transparent)",
                  borderRadius: 999,
                  padding: "3px 10px",
                  textDecoration: "none",
                  whiteSpace: "nowrap",
                }}
              >
                v{update.latestVersion}
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M7 17 17 7" />
                  <path d="M7 7h10v10" />
                </svg>
              </a>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, flexShrink: 0, fontFamily: "var(--font-mono)" }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              web <span style={{ color: "var(--text)" }}>v{process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}</span>
            </span>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              core <span style={{ color: "var(--text)" }}>v{process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}</span>
            </span>
          </div>
        </div>

        {/* Greeting row */}
        <div className="ui-welcome-greet" style={{ fontSize: 16, color: "var(--text)", lineHeight: 1.6, marginBottom: 10 }}>
          <span style={{ fontWeight: 650 }}>{t(greetingKey(hour))}{username ? `，${username}` : ""}</span>
          <span style={{ color: "var(--text-dim)", marginLeft: 10, fontSize: 13 }}>{dateLabel}</span>
          {weather && (
            <span style={{ color: "var(--text-dim)", marginLeft: 10, fontSize: 13 }}>
              {weather.text} {weather.tempC}°C
            </span>
          )}
        </div>

        {/* Rotating suggestion */}
        <div className="ui-welcome-tip" style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 30 }}>
          <span style={{ fontSize: 12, color: "var(--text-dim)", flexShrink: 0 }}>{t("chat.welcomeTips")}</span>
          <button
            type="button"
            key={tipIndex}
            className="ui-tip-swap-text"
            onClick={() => applyTip(tips[tipIndex])}
            title={t("chat.messagePlaceholder")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 13,
              color: "var(--text-muted)",
              background: "var(--bg-subtle)",
              border: "0.5px solid color-mix(in srgb, var(--border) 70%, transparent)",
              borderRadius: 999,
              padding: "6px 14px",
              cursor: "pointer",
              whiteSpace: "nowrap",
              maxWidth: "100%",
              overflow: "hidden",
              textOverflow: "ellipsis",
              transition: "border-color 0.15s ease, color 0.15s ease",
            }}
            onMouseEnter={(event) => {
              event.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 45%, transparent)";
              event.currentTarget.style.color = "var(--accent)";
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.borderColor = "color-mix(in srgb, var(--border) 70%, transparent)";
              event.currentTarget.style.color = "var(--text-muted)";
            }}
          >
            {tips[tipIndex]}
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </button>
          {/* 轮换指示点 */}
          <span style={{ display: "inline-flex", gap: 4, flexShrink: 0 }} aria-hidden="true">
            {tips.map((tip, index) => (
              <span
                key={tip}
                style={{
                  width: index === tipIndex ? 12 : 5,
                  height: 5,
                  borderRadius: 3,
                  background: index === tipIndex ? "var(--accent)" : "var(--border)",
                  transition: "width 0.3s var(--ease-out-soft), background 0.3s ease",
                }}
              />
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}
