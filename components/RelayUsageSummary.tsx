"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

/**
 * meteor21c relay 额度面板（三件套：余额 / 今日消耗 / 模型用量 TopN）。
 *
 * 实现契约（W2 挂载依赖，勿改签名）：
 *   <RelayUsageSummary enabled={boolean} />
 * 数据来源：POST /api/relay-usage（无 body）→ { status, report?, message? }
 *
 * 行为完全对标 ProviderUsageSummary：localStorage 缓存、挂载即查询、60s 轮询、
 * 手动刷新、错误态。区别仅在数据形态与渲染结构（余额 / 今日 / TopN 表）。
 */

type RelayToday = {
  date: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
};
type RelayTopModel = { model: string; requests: number; totalTokens: number; cost: number };
type RelayReport = {
  capturedAt: number;
  balanceUsd: number;
  mode: string;
  today: RelayToday;
  topModels: RelayTopModel[];
};
type RelayUsageResponse = {
  status: "ready" | "auth-unavailable" | "query-failed";
  message?: string;
  report?: RelayReport;
};

const STORAGE_KEY = "pi-web:relay-usage:meteor21c";
const POLL_INTERVAL_MS = 60_000;
const REFRESH_FLASH_MS = 2_000;

export function RelayUsageSummary({ enabled }: { enabled: boolean }) {
  if (!enabled) return null;
  return <RelayUsageContent />;
}

function RelayUsageContent() {
  const [snapshot, setSnapshot] = useState<RelayUsageResponse | null>(null);
  const [querying, setQuerying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshDone, setRefreshDone] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { t } = useI18n();

  const query = useCallback(async () => {
    setQuerying(true);
    setError(null);
    try {
      const response = await fetch("/api/relay-usage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const result = (await response.json()) as RelayUsageResponse & { error?: string };
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      if (result.status === "ready" && result.report) {
        setSnapshot(result);
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(result));
        } catch {}
        setRefreshDone(true);
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        flashTimerRef.current = setTimeout(() => setRefreshDone(false), REFRESH_FLASH_MS);
      } else if (result.status === "auth-unavailable") {
        setError(t("relay.usage.invalidKey"));
      } else {
        setError(result.message ? `${t("relay.usage.failed")} ${result.message}` : t("relay.usage.failed"));
      }
    } catch (caught) {
      setError(t("relay.usage.failed") + (caught instanceof Error ? ` ${caught.message}` : ""));
    } finally {
      setQuerying(false);
    }
  }, [t]);

  useEffect(() => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    setSnapshot(null);
    setError(null);
    // 挂载先读缓存展示，再发起查询刷新。
    try {
      const cached = localStorage.getItem(STORAGE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached) as RelayUsageResponse;
        if (parsed?.status === "ready" && parsed.report) setSnapshot(parsed);
      }
    } catch {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {}
    }
    void query();
    pollTimerRef.current = setInterval(() => {
      void query();
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, [query]);

  const report = snapshot?.status === "ready" ? snapshot.report : undefined;
  const todayTokens = report ? report.today.inputTokens + report.today.outputTokens + report.today.cacheReadTokens + report.today.cacheWriteTokens : 0;

  return (
    <section style={{ paddingTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <span style={{ fontSize: 13, color: "var(--text)", fontWeight: 600, lineHeight: 1.35 }}>{t("relay.usage.title")}</span>
        <button
          type="button"
          onClick={() => void query()}
          disabled={querying}
          title={t(querying ? "relay.usage.refreshing" : "relay.usage.refresh")}
          aria-label={t(querying ? "relay.usage.refreshing" : "relay.usage.refresh")}
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 32,
            height: 30,
            padding: 0,
            background: "none",
            border: "none",
            color: refreshDone ? "#4ade80" : "var(--text-dim)",
            cursor: querying ? "default" : "pointer",
            borderRadius: 5,
            flexShrink: 0,
            transition: "color 0.3s",
          }}
        >
          {refreshDone ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={querying ? { animation: "spin 0.8s linear infinite" } : undefined}
              aria-hidden="true"
            >
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          )}
        </button>
        {report && (
          <span style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" }}>{t("relay.usage.updatedAt", { time: formatUpdated(report.capturedAt) })}</span>
        )}
      </div>

      {!report && !error && <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("relay.usage.refresh")}</span>}
      {error && <span style={{ fontSize: 12, color: "#f87171" }}>{error}</span>}

      {report && (
        <>
          {/* 余额 */}
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("relay.usage.balance")}</span>
            <span style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", fontFamily: "var(--font-mono)", lineHeight: 1.2 }}>{formatUSD(report.balanceUsd)}</span>
          </div>

          {/* 今日消耗 */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600 }}>{t("relay.usage.today")}</span>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, fontSize: 12 }}>
              <RelayStat label={t("relay.usage.todayRequests")} value={formatInt(report.today.requests)} />
              <RelayStat label={t("relay.usage.todayCost")} value={formatUSD(report.today.cost)} />
              <RelayStat label={t("relay.usage.tokens")} value={formatTokens(todayTokens)} />
            </div>
          </div>

          {/* 模型用量 TopN */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600 }}>{t("relay.usage.topModels")}</span>
            {report.topModels.length === 0 ? (
              <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("relay.usage.noData")}</span>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ color: "var(--text-dim)" }}>
                      <th style={{ fontWeight: 500, textAlign: "left", padding: "2px 8px 2px 0" }}>{t("relay.usage.model")}</th>
                      <th style={{ fontWeight: 500, textAlign: "right", padding: "2px 8px" }}>{t("relay.usage.requests")}</th>
                      <th style={{ fontWeight: 500, textAlign: "right", padding: "2px 8px" }}>tokens</th>
                      <th style={{ fontWeight: 500, textAlign: "right", padding: "2px 0 2px 8px" }}>{t("relay.usage.cost")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.topModels.map((m) => (
                      <tr key={m.model} style={{ color: "var(--text)" }}>
                        <td style={{ fontFamily: "var(--font-mono)", padding: "2px 8px 2px 0", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.model}</td>
                        <td style={{ fontFamily: "var(--font-mono)", textAlign: "right", padding: "2px 8px" }}>{formatInt(m.requests)}</td>
                        <td style={{ fontFamily: "var(--font-mono)", textAlign: "right", padding: "2px 8px" }}>{formatTokens(m.totalTokens)}</td>
                        <td style={{ fontFamily: "var(--font-mono)", textAlign: "right", padding: "2px 0 2px 8px" }}>{formatUSD(m.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function RelayStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      <span style={{ fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      <span style={{ fontSize: 14, color: "var(--text)", fontFamily: "var(--font-mono)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</span>
    </div>
  );
}

function formatUSD(value: number): string {
  return `$${(Number.isFinite(value) ? value : 0).toFixed(2)}`;
}

function formatInt(value: number): string {
  return new Intl.NumberFormat().format(Number.isFinite(value) ? value : 0);
}

function formatTokens(value: number): string {
  const v = Number.isFinite(value) ? value : 0;
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

function formatUpdated(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
