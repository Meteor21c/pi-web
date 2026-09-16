"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { useI18n } from "@/hooks/useI18n";
import { useRelaySession } from "@/hooks/useRelaySession";
import type { AppUpdateResponse } from "@/lib/api-types";

type WeatherInfo = { text: string; tempC: number };

const WEATHER_CACHE_KEY = "pi-web:welcome-weather";
const WEATHER_CACHE_TTL_MS = 30 * 60 * 1000;

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

export function NewSessionWelcome({ isMobile }: { isMobile: boolean }) {
  const { t, locale } = useI18n();
  const { user } = useRelaySession();
  const [weather, setWeather] = useState<WeatherInfo | null>(null);
  const [update, setUpdate] = useState<AppUpdateResponse | null>(null);

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

  const hour = new Date().getHours();
  const username = user?.username?.trim() || user?.email?.trim()?.split("@")[0] || "";
  const dateLabel = new Intl.DateTimeFormat(locale, { month: "long", day: "numeric", weekday: "long" }).format(new Date());
  const tips = [t("chat.welcomeTip1"), t("chat.welcomeTip2"), t("chat.welcomeTip3")];

  return (
    <div className="ui-msg-enter w-full" style={{ paddingLeft: 16, paddingRight: isMobile ? 16 : 52, marginBottom: 18 }}>
      <div style={{ maxWidth: "var(--chat-content-max-width, 820px)", margin: "0 auto" }}>
        {/* Brand row */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 26 }}>
          <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 8 : 12, minWidth: 0 }}>
            <Image src="/icons/meteoragent-touch.png" width={38} height={38} alt="" priority style={{ flexShrink: 0, borderRadius: 10 }} />
            <span style={{ fontSize: 24, color: "var(--text)", fontWeight: 700, letterSpacing: "-0.02em", whiteSpace: "nowrap" }}>MeteorAgent</span>
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
        <div style={{ fontSize: 15, color: "var(--text)", lineHeight: 1.6, marginBottom: 8 }}>
          <span style={{ fontWeight: 650 }}>{t(greetingKey(hour))}{username ? `，${username}` : ""}</span>
          <span style={{ color: "var(--text-dim)", marginLeft: 10, fontSize: 13 }}>{dateLabel}</span>
          {weather && (
            <span style={{ color: "var(--text-dim)", marginLeft: 10, fontSize: 13 }}>
              {weather.text} {weather.tempC}°C
            </span>
          )}
        </div>

        {/* Tips */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "var(--text-dim)", flexShrink: 0 }}>{t("chat.welcomeTips")}</span>
          {tips.map((tip) => (
            <span
              key={tip}
              style={{
                fontSize: 12,
                color: "var(--text-muted)",
                background: "var(--bg-subtle)",
                border: "0.5px solid color-mix(in srgb, var(--border) 70%, transparent)",
                borderRadius: 999,
                padding: "5px 12px",
                whiteSpace: "nowrap",
              }}
            >
              {tip}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
