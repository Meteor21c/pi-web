"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { formatUsdPrecise } from "@/lib/currency-format";
import type { RelayUsageReport } from "@/lib/relay-usage";
import { MeteorAgentDownloadLink } from "./MeteorAgentDownloadLink";

/**
 * meteor21c relay 用量面板。账户视图可显示余额；分组视图只显示
 * 今日消耗与模型用量，避免重复展示账户钱包。
 *
 * 实现契约（W2 挂载依赖，勿改签名）：
 *   <RelayUsageSummary enabled={boolean} />
 * 数据来源：POST /api/relay-usage（无 body）→ { status, report?, message? }
 *
 * 行为完全对标 ProviderUsageSummary：localStorage 缓存、挂载即查询、60s 轮询、
 * 手动刷新、错误态。区别仅在数据形态与渲染结构（余额 / 今日 / TopN 表）。
 */

type RelayUsageResponse = {
  status: "ready" | "auth-unavailable" | "query-failed";
  message?: string;
  report?: RelayUsageReport;
};

const POLL_INTERVAL_MS = 60_000;
const REFRESH_FLASH_MS = 2_000;

export function RelayUsageSummary({
  enabled,
  providerId,
  showBalance = true,
}: {
  enabled: boolean;
  providerId: string;
  showBalance?: boolean;
}) {
  if (!enabled) return null;
  return <RelayUsageContent key={providerId} providerId={providerId} showBalance={showBalance} />;
}

function RelayUsageContent({ providerId, showBalance }: { providerId: string; showBalance: boolean }) {
  const [snapshot, setSnapshot] = useState<RelayUsageResponse | null>(null);
  const [querying, setQuerying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshDone, setRefreshDone] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const { t, locale } = useI18n();
  const zh = locale.startsWith("zh");

  const query = useCallback(async () => {
    if (document.visibilityState === "hidden" || requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setQuerying(true);
    setError(null);
    try {
      const response = await fetch("/api/relay-usage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
      });
      const result = (await response.json()) as RelayUsageResponse & { error?: string };
      if (controller.signal.aborted) return;
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      if (result.status === "ready" && result.report) {
        setSnapshot(result);
        setRefreshDone(true);
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        flashTimerRef.current = setTimeout(() => setRefreshDone(false), REFRESH_FLASH_MS);
      } else if (result.status === "auth-unavailable") {
        setSnapshot(null);
        setError(t("relay.usage.invalidKey"));
      } else {
        setSnapshot(null);
        setError(result.message ? `${t("relay.usage.failed")} ${result.message}` : t("relay.usage.failed"));
      }
    } catch (caught) {
      if (controller.signal.aborted) return;
      setSnapshot(null);
      setError(t("relay.usage.failed") + (caught instanceof Error ? ` ${caught.message}` : ""));
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      if (!controller.signal.aborted) setQuerying(false);
    }
  }, [t, providerId]);

  useEffect(() => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    setSnapshot(null);
    setError(null);
    // No persistent financial cache: changing accounts/channels cannot expose old amounts.
    void query();
    pollTimerRef.current = setInterval(() => {
      void query();
    }, POLL_INTERVAL_MS);
    const invalidate = () => {
      requestRef.current?.abort();
      requestRef.current = null;
      setSnapshot(null);
      setQuerying(false);
      void query();
    };
    document.addEventListener("visibilitychange", query);
    window.addEventListener("relay-config-updated", invalidate);
    return () => {
      requestRef.current?.abort();
      requestRef.current = null;
      document.removeEventListener("visibilitychange", query);
      window.removeEventListener("relay-config-updated", invalidate);
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, [query]);

  const report = snapshot?.status === "ready" ? snapshot.report : undefined;
  const todayTokens = report ? report.today.inputTokens + report.today.outputTokens + report.today.cacheReadTokens + report.today.cacheWriteTokens : 0;

  return (
    <section style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12, background: "var(--assistant-bg)", border: "1px solid var(--border)", borderRadius: 14 }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <span style={{ fontSize: 13, color: "var(--text)", fontWeight: 600, lineHeight: 1.35 }}>{t("relay.usage.title")}</span>
        {showBalance && <MeteorAgentDownloadLink variant="inline" />}
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
          {/* 余额仅用于没有独立账户卡片的兼容界面。 */}
          {showBalance && <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{report.kind === "wallet" ? (zh ? "账号钱包（不是单渠道余额）" : "Account wallet (shared across channels)") : (zh ? "本渠道剩余额度" : "Channel allowance remaining")}</span>
            <span style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", fontFamily: "var(--font-mono)", lineHeight: 1.2 }}>{report.unlimited ? (zh ? "无限额" : "Unlimited") : report.balanceUsd === null ? (zh ? "暂不可用" : "Unavailable") : formatUSD(report.balanceUsd)}</span>
            {report.planName && <span>{report.planName}</span>}
            {report.status && <span>{zh ? "状态：" : "Status: "}{report.status}</span>}
            {report.expiresAt && <span>{zh ? "到期：" : "Expires: "}{report.expiresAt}</span>}
            {report.rateLimits.map((limit) => <span key={limit.window}>{limit.window}: {limit.remaining === null ? "—" : formatUSD(limit.remaining)}{limit.resetAt ? ` · ${limit.resetAt}` : ""}</span>)}
          </div>}

          {/* 今日消耗 */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600 }}>{t("relay.usage.today")}</span>
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{report.timezone} · {report.costBasis === "actual" ? (zh ? "接口报告实扣" : "Reported actual charge") : (zh ? "接口估算费用，最终以账单为准" : "Estimated cost; refer to your bill")}</span>
            {!report.todayAvailable ? <span>{zh ? "统计暂不可用" : "Statistics unavailable"}</span> : <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, fontSize: 12 }}>
              <RelayStat label={t("relay.usage.todayRequests")} value={formatInt(report.today.requests)} />
              <RelayStat label={t("relay.usage.todayCost")} value={formatUSD(report.today.cost)} />
              <RelayStat label={t("relay.usage.tokens")} value={formatTokens(todayTokens)} />
            </div>}
          </div>

          {/* 模型用量 TopN */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600 }}>{t("relay.usage.topModels")}</span>
            {!report.modelStatsAvailable ? <span>{zh ? "统计暂不可用" : "Statistics unavailable"}</span> : report.topModels.length === 0 ? (
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
    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, background: "var(--bg-subtle)", borderRadius: 10, padding: "8px 10px" }}>
      <span style={{ fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      <span style={{ fontSize: 14, color: "var(--text)", fontFamily: "var(--font-mono)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</span>
    </div>
  );
}

function formatUSD(value: number): string {
  return formatUsdPrecise(value);
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
