"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { sendAgentCommand } from "@/lib/agent-client";
import type { PluginPackageInfo, PluginsResponse } from "@/lib/api-types";
import { useI18n } from "@/hooks/useI18n";

interface Props {
  cwd: string;
  sessionId: string | null;
  sessionRunning: boolean;
  onReloaded?: () => void;
}

function packageKey(pkg: Pick<PluginPackageInfo, "scope" | "source">): string {
  return `${pkg.scope}\0${pkg.source}`;
}

function packageLabel(pkg: PluginPackageInfo): string {
  return pkg.packageName || pkg.source.replace(/^npm:/, "");
}

function resourceSummary(pkg: PluginPackageInfo, locale: string): string {
  const labels = locale.startsWith("zh")
    ? { extensions: "扩展", skills: "技能", prompts: "提示词", themes: "主题" }
    : { extensions: "extensions", skills: "skills", prompts: "prompts", themes: "themes" };
  return (Object.keys(labels) as Array<keyof typeof labels>)
    .filter((key) => pkg.counts[key] > 0)
    .map((key) => `${pkg.counts[key]} ${labels[key]}`)
    .join(" · ");
}

export function SessionPluginsPanel({ cwd, sessionId, sessionRunning, onReloaded }: Props) {
  const { locale } = useI18n();
  const zh = locale.startsWith("zh");
  const [data, setData] = useState<PluginsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [reloadBusy, setReloadBusy] = useState(false);
  const [changed, setChanged] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ cwd });
      if (sessionId) params.set("sessionId", sessionId);
      const response = await fetch(`/api/plugins?${params}`);
      const body = await response.json() as PluginsResponse & { error?: string };
      if (!response.ok || body.error) throw new Error(body.error || `HTTP ${response.status}`);
      setData(body);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [cwd, sessionId]);

  useEffect(() => {
    setChanged(false);
    void load();
  }, [load]);

  const sessionPackages = useMemo(
    () => data?.packages.filter((pkg) => pkg.activationMode === "session" && pkg.globalEnabled) ?? [],
    [data?.packages],
  );
  const globalPackages = useMemo(
    () => data?.packages.filter((pkg) => pkg.activationMode === "global" || !pkg.globalEnabled) ?? [],
    [data?.packages],
  );

  const toggle = useCallback(async (pkg: PluginPackageInfo) => {
    if (!sessionId || pkg.activationMode !== "session" || !pkg.globalEnabled) return;
    const key = packageKey(pkg);
    setBusyKey(key);
    setError(null);
    try {
      const response = await fetch("/api/plugins/session", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          sessionId,
          source: pkg.source,
          scope: pkg.scope,
          enabled: !pkg.sessionEnabled,
        }),
      });
      const body = await response.json() as { plugins?: PluginsResponse; error?: string };
      if (!response.ok || body.error || !body.plugins) {
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      setData(body.plugins);
      setChanged(true);
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : String(toggleError));
    } finally {
      setBusyKey(null);
    }
  }, [cwd, sessionId]);

  const reload = useCallback(async () => {
    if (!sessionId || sessionRunning) return;
    setReloadBusy(true);
    setError(null);
    try {
      await sendAgentCommand(sessionId, { type: "reload" });
      setChanged(false);
      await load();
      onReloaded?.();
    } catch (reloadError) {
      setError(reloadError instanceof Error ? reloadError.message : String(reloadError));
    } finally {
      setReloadBusy(false);
    }
  }, [load, onReloaded, sessionId, sessionRunning]);

  return (
    <section className="session-plugins-panel" aria-label={zh ? "当前会话插件" : "Session plugins"}>
      <header className="session-plugins-heading">
        <div className="session-plugins-title-block">
          <span className="session-plugins-icon" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2v6" /><path d="M8 8h8v4a4 4 0 0 1-8 0V8Z" /><path d="M9 17v5" /><path d="M15 17v5" />
            </svg>
          </span>
          <div>
            <strong>{zh ? "当前会话插件" : "Session plugins"}</strong>
            <p>{zh ? "按会话选择的插件可在这里开启，重载后生效。" : "Choose per-session plugins here. Changes apply after reload."}</p>
          </div>
        </div>
        <button
          type="button"
          className="session-plugins-reload"
          disabled={!sessionId || sessionRunning || reloadBusy || sessionPackages.length === 0}
          onClick={() => void reload()}
        >
          {reloadBusy ? (zh ? "正在重载…" : "Reloading…") : (zh ? "重载会话" : "Reload session")}
        </button>
      </header>

      <div className={`session-plugins-warning${sessionRunning ? " is-running" : ""}`} role="note">
        {sessionRunning
          ? (zh ? "会话正在运行。当前修改只会保存，任务结束并重载会话后才会生效。" : "This session is running. Changes are saved now and apply only after the run finishes and the session is reloaded.")
          : changed
            ? (zh ? "选择已保存。插件会在重载时执行代码，请确认当前任务已结束后再重载。" : "Selection saved. Plugins execute code during reload; reload after the current task is finished.")
            : (zh ? "使用途中切换插件可能影响上下文和工具状态；所有修改都要重载会话后才会生效。" : "Changing plugins mid-session can affect context and tool state. Changes apply only after reload.")}
      </div>

      {error && <div className="session-plugins-error" role="alert">{error}</div>}

      <div className="session-plugins-scroll">
        {loading ? (
          <div className="session-plugins-empty">{zh ? "正在读取插件…" : "Loading plugins…"}</div>
        ) : sessionPackages.length === 0 && globalPackages.length === 0 ? (
          <div className="session-plugins-empty">{zh ? "尚未安装插件。可在设置 → 插件中打开社区。" : "No plugins installed. Open Settings → Plugins to browse the community."}</div>
        ) : (
          <>
            {sessionPackages.length > 0 && (
              <div className="session-plugins-group">
                <div className="session-plugins-group-title">{zh ? "可在本会话选择" : "Available for this session"}</div>
                {sessionPackages.map((pkg) => {
                  const busy = busyKey === packageKey(pkg);
                  return (
                    <button
                      key={packageKey(pkg)}
                      type="button"
                      className="session-plugin-row is-editable"
                      aria-pressed={pkg.sessionEnabled}
                      disabled={!sessionId || busy}
                      onClick={() => void toggle(pkg)}
                    >
                      <span className="session-plugin-copy">
                        <strong>{packageLabel(pkg)}</strong>
                        <span>{resourceSummary(pkg, locale) || pkg.source}</span>
                      </span>
                      <span className={`session-plugin-switch${pkg.sessionEnabled ? " is-on" : ""}${busy ? " is-busy" : ""}`} aria-hidden="true">
                        <span />
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {globalPackages.length > 0 && (
              <div className="session-plugins-group is-global">
                <div className="session-plugins-group-title">{zh ? "由全局设置决定" : "Controlled by global settings"}</div>
                {globalPackages.map((pkg) => (
                  <div className="session-plugin-row is-readonly" key={packageKey(pkg)} aria-disabled="true">
                    <span className="session-plugin-copy">
                      <strong>{packageLabel(pkg)}</strong>
                      <span>{resourceSummary(pkg, locale) || pkg.source}</span>
                    </span>
                    <span className={`session-plugin-global-state${pkg.globalEnabled ? " is-on" : ""}`}>
                      {pkg.globalEnabled ? (zh ? "全局开启" : "Globally on") : (zh ? "全局关闭" : "Globally off")}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {!sessionId && (
        <footer className="session-plugins-new-note">
          {zh ? "局部插件在新会话中默认关闭；会话创建后可在这里开启。" : "Per-session plugins start off in new sessions and can be enabled here after the session is created."}
        </footer>
      )}

      <style>{`
        .session-plugins-panel { width: calc(640px * var(--ui-scale, 1)); background: color-mix(in srgb, var(--assistant-bg) 72%, transparent); -webkit-backdrop-filter: blur(32px) saturate(1.8); backdrop-filter: blur(32px) saturate(1.8); border: .5px solid color-mix(in srgb, var(--border) 72%, transparent); border-radius: 18px; box-shadow: inset 0 1px 0 color-mix(in srgb, var(--assistant-bg) 88%, transparent), 0 24px 64px rgba(0,0,0,.20), 0 4px 14px rgba(0,0,0,.08); overflow: hidden; color: var(--text); }
        .session-plugins-heading { min-height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 11px 13px; border-bottom: .5px solid color-mix(in srgb, var(--border) 62%, transparent); background: color-mix(in srgb, var(--assistant-bg) 44%, transparent); }
        .session-plugins-title-block { min-width: 0; display: flex; align-items: center; gap: 10px; }
        .session-plugins-icon { width: 32px; height: 32px; display: grid; place-items: center; flex-shrink: 0; border-radius: 10px; color: var(--accent); background: color-mix(in srgb, var(--accent) 11%, var(--assistant-bg)); }
        .session-plugins-heading strong { display: block; font-size: 13px; font-weight: 650; }
        .session-plugins-heading p { margin: 3px 0 0; color: var(--text-dim); font-size: 10.5px; line-height: 1.35; }
        .session-plugins-reload { min-height: 30px; padding: 0 11px; border: .5px solid color-mix(in srgb, var(--border) 80%, transparent); border-radius: 999px; background: color-mix(in srgb, var(--bg-hover) 64%, transparent); color: var(--text-muted); cursor: pointer; white-space: nowrap; font-size: 11px; transition: background .15s ease, color .15s ease, transform .15s ease; }
        .session-plugins-reload:hover:not(:disabled) { background: var(--bg-selected); color: var(--text); }
        .session-plugins-reload:active:not(:disabled) { transform: scale(.96); }
        .session-plugins-reload:disabled { cursor: not-allowed; opacity: .45; }
        .session-plugins-warning { margin: 11px 12px 0; padding: 9px 11px; border: .5px solid color-mix(in srgb, #f59e0b 24%, transparent); border-radius: 11px; background: color-mix(in srgb, #f59e0b 8%, var(--assistant-bg)); color: var(--text-muted); font-size: 10.5px; line-height: 1.5; }
        .session-plugins-warning.is-running { border-color: color-mix(in srgb, #ef4444 22%, transparent); background: color-mix(in srgb, #ef4444 8%, var(--assistant-bg)); }
        .session-plugins-error { margin: 8px 12px 0; color: #ef4444; font-size: 11px; }
        .session-plugins-scroll { max-height: min(480px, calc(58dvh / var(--ui-scale, 1))); overflow: auto; padding: 10px 12px 13px; }
        .session-plugins-group { padding: 6px; border: .5px solid color-mix(in srgb, var(--border) 58%, transparent); border-radius: 14px; background: color-mix(in srgb, var(--assistant-bg) 54%, transparent); }
        .session-plugins-group + .session-plugins-group { margin-top: 10px; }
        .session-plugins-group-title { margin: 2px 5px 6px; color: var(--text-dim); font-size: 9.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
        .session-plugin-row { width: 100%; min-height: 48px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 7px 9px; border: none; border-radius: 10px; background: transparent; color: var(--text); text-align: left; }
        button.session-plugin-row.is-editable { cursor: pointer; }
        button.session-plugin-row.is-editable:hover:not(:disabled) { background: color-mix(in srgb, var(--bg-hover) 82%, transparent); }
        button.session-plugin-row:disabled { cursor: not-allowed; opacity: .55; }
        .session-plugin-row.is-readonly { opacity: .62; }
        .session-plugin-copy { min-width: 0; display: block; }
        .session-plugin-copy strong, .session-plugin-copy span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .session-plugin-copy strong { font-size: 12px; font-weight: 600; }
        .session-plugin-copy span { margin-top: 3px; color: var(--text-dim); font-size: 10px; }
        .session-plugin-switch { width: 34px; height: 20px; padding: 2px; border-radius: 999px; background: color-mix(in srgb, var(--text-dim) 30%, var(--border)); flex-shrink: 0; transition: background .18s ease; }
        .session-plugin-switch > span { display: block; width: 16px; height: 16px; border-radius: 50%; background: white; box-shadow: 0 1px 4px rgba(0,0,0,.24); transition: transform .18s cubic-bezier(.2,.8,.2,1); }
        .session-plugin-switch.is-on { background: var(--accent); }
        .session-plugin-switch.is-on > span { transform: translateX(14px); }
        .session-plugin-switch.is-busy { opacity: .55; }
        .session-plugin-global-state { flex-shrink: 0; padding: 3px 8px; border-radius: 999px; background: color-mix(in srgb, var(--bg-selected) 72%, transparent); color: var(--text-dim); font-size: 10px; }
        .session-plugin-global-state.is-on { color: var(--text-muted); }
        .session-plugins-empty { padding: 28px 12px; color: var(--text-dim); text-align: center; font-size: 12px; }
        .session-plugins-new-note { padding: 9px 14px; border-top: .5px solid color-mix(in srgb, var(--border) 62%, transparent); color: var(--text-dim); font-size: 10px; }
        @media (max-width: 640px) {
          .session-plugins-panel { border-radius: 15px; }
          .session-plugins-heading { align-items: flex-start; }
          .session-plugins-heading p { display: none; }
        }
      `}</style>
    </section>
  );
}
