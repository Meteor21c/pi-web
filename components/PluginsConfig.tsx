"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sendAgentCommand } from "@/lib/agent-client";
import type {
  PluginActivationMode,
  PluginPackageInfo,
  PluginStandaloneExtensionInfo,
  PluginUpdateResult,
  PluginsResponse,
} from "@/lib/api-types";
import {
  COMMUNITY_PLUGIN_CATEGORY_ORDER,
  COMMUNITY_PLUGIN_CATALOG,
  filterCommunityPluginCatalog,
  sameCommunityPluginSource,
  type CommunityPluginCategory,
  type CommunityPluginEntry,
} from "@/lib/plugin-catalog";
import { useI18n } from "@/hooks/useI18n";
import {
  getLastSettingsSelection,
  setLastSettingsSelection,
} from "@/lib/settings-navigation";
import {
  ConfigButton,
  ConfigDetail,
  ConfigDetailActions,
  ConfigDetailHeader,
  ConfigDetailHeaderInfo,
  ConfigDetailStack,
  ConfigDetailTitle,
  ConfigEmptyState,
  ConfigField,
  ConfigFooter,
  ConfigListAction,
  ConfigPanelShell,
  ConfigSidebar,
  ConfigSidebarGroupLabel,
  ConfigSidebarItem,
  ConfigSidebarList,
  ConfigSidebarText,
  ConfigSectionTitle,
  ConfigSplitView,
  ConfigStatusDot,
  ConfigSwitch,
} from "./SettingsUi";

type PluginScope = PluginPackageInfo["scope"];
type PluginAction = "install" | "remove" | "update" | "disable" | "enable";
type PluginView = "community" | "installed";
type InstallStage = 0 | 1 | 2 | 3;

interface PendingPluginInstall {
  source: string;
  scope: PluginScope;
  name: string;
  description?: string;
  packageUrl?: string;
  category?: CommunityPluginCategory;
}

interface InstallProgressState {
  source: string;
  scope: PluginScope;
  stage: InstallStage;
}

const METEORAGENT_PRODUCT_MODE = process.env.NEXT_PUBLIC_AUTH_GATE === "1";

function shortenPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

function normalizePluginSourceInput(value: string): string {
  const match = value.trim().match(/^\$?\s*pi\s+install\s+(\S+)\s*$/);
  return match?.[1] ?? value;
}

function packageKey(pkg: Pick<PluginPackageInfo, "source" | "scope">): string {
  return `${pkg.scope}\0${pkg.source}`;
}

function extensionKey(extension: PluginStandaloneExtensionInfo): string {
  return `extension\0${extension.path}`;
}

function resourceSummary(pkg: PluginPackageInfo, t: ReturnType<typeof useI18n>["t"]): string {
  if (pkg.disabled) return t("i18n.disabled");
  const parts = [
    pkg.counts.extensions ? t("i18n.resourceCount", { count: pkg.counts.extensions, label: t("i18n.extensionShort") }) : "",
    pkg.counts.skills ? t("i18n.resourceCount", { count: pkg.counts.skills, label: t("i18n.skillShort") }) : "",
    pkg.counts.prompts ? t("i18n.resourceCount", { count: pkg.counts.prompts, label: t("i18n.promptShort") }) : "",
    pkg.counts.themes ? t("i18n.resourceCount", { count: pkg.counts.themes, label: t("i18n.themeShort") }) : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : t("i18n.noResources");
}

function versionSummary(pkg: PluginPackageInfo, t: ReturnType<typeof useI18n>["t"]): string {
  const parts = [];
  if (pkg.version) parts.push(t("i18n.installedVersion", { version: pkg.version }));
  if (pkg.configuredVersion) parts.push(t("i18n.configuredVersion", { version: pkg.configuredVersion }));
  return parts.length ? parts.join(" · ") : t("i18n.unknown");
}

function installLocation(scope: PluginScope, cwd: string): string {
  if (METEORAGENT_PRODUCT_MODE) {
    return scope === "project" ? "当前项目插件目录" : "Magent 全局插件目录";
  }
  return scope === "project"
    ? `${shortenPath(cwd)}/.pi/agent/{npm,git}`
    : "~/.pi/agent/{npm,git}";
}

function findInstalledPackage(
  packages: PluginPackageInfo[],
  source: string,
  scope: PluginScope,
): PluginPackageInfo | undefined {
  const trimmed = source.trim();
  const withoutNpmPrefix = trimmed.startsWith("npm:") ? trimmed.slice(4) : trimmed;
  return packages.find((pkg) => pkg.scope === scope && pkg.source === trimmed)
    ?? packages.find((pkg) => pkg.scope === scope && pkg.source === `npm:${withoutNpmPrefix}`)
    ?? packages.find((pkg) => pkg.scope === scope && pkg.source.endsWith(trimmed));
}

function statusColor(status: PluginPackageInfo["status"]): string {
  if (status === "loaded") return "var(--accent)";
  if (status === "installed") return "#f59e0b";
  if (status === "disabled") return "var(--text-dim)";
  return "#ef4444";
}

function communityCategoryLabel(
  category: CommunityPluginCategory,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (category === "skill") return t("i18n.pluginCategorySkill");
  if (category === "prompt") return t("i18n.pluginCategoryPrompt");
  return t("i18n.pluginCategoryTool");
}

function communityRiskLabel(
  risk: CommunityPluginEntry["risk"],
  t: ReturnType<typeof useI18n>["t"],
): string {
  return risk === "low" ? t("i18n.pluginRiskLow") : t("i18n.pluginRiskReview");
}

function PluginViewTabs({
  value,
  installedCount,
  onChange,
}: {
  value: PluginView;
  installedCount: number;
  onChange: (value: PluginView) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="plugins-view-tabs" role="tablist" aria-label={t("i18n.pluginViews")}>
      {(["community", "installed"] as const).map((view) => {
        const active = value === view;
        return (
          <button
            key={view}
            type="button"
            role="tab"
            aria-selected={active}
            className={`plugins-view-tab${active ? " is-active" : ""}`}
            data-plugin-view={view}
            onClick={() => onChange(view)}
          >
            {view === "community" ? t("i18n.pluginCommunity") : t("i18n.pluginInstalled")}
            {view === "installed" && (
              <span className="plugins-view-tab-count" aria-label={t("i18n.pluginInstalledCount", { count: installedCount })}>
                {installedCount}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function PluginInstallProgress({ progress }: { progress: InstallProgressState }) {
  const { t } = useI18n();
  const labels = [
    t("i18n.pluginInstallStagePreparing"),
    t("i18n.pluginInstallStageDownloading"),
    t("i18n.pluginInstallStageInstalling"),
    t("i18n.pluginInstallStageFinalizing"),
  ];
  return (
    <div
      className="plugin-install-progress"
      role="status"
      aria-live="polite"
      data-plugin-install-progress="true"
    >
      <div className="plugin-install-progress-heading">
        <strong>{t("i18n.pluginInstallProgressTitle")}</strong>
        <span title={progress.source}>
          {progress.source} · {progress.scope === "global" ? t("skills.scope.global") : t("skills.scope.project")} · {t("i18n.pluginInstallProgressBackground")}
        </span>
      </div>
      <ol className="plugin-install-progress-steps">
        {labels.map((label, index) => {
          const complete = index < progress.stage;
          const current = index === progress.stage;
          return (
            <li
              key={label}
              className={`${complete ? "is-complete" : ""}${current ? " is-current" : ""}`}
            >
              <span className="plugin-install-progress-marker" aria-hidden="true">
                {complete ? "✓" : index + 1}
              </span>
              <span>{label}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function PluginInstallWarningDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: PendingPluginInstall;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    setAcknowledged(false);
  }, [pending.source, pending.scope]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div
      className="plugin-install-warning-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className="plugin-install-warning-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugin-install-warning-title"
        aria-describedby="plugin-install-warning-body"
      >
        <div className="plugin-install-warning-icon" aria-hidden="true">!</div>
        <div className="plugin-install-warning-copy">
          <h2 id="plugin-install-warning-title">{t("i18n.pluginInstallWarningTitle")}</h2>
          <p id="plugin-install-warning-body">{t("i18n.pluginInstallWarningBody")}</p>
        </div>
        <div className="plugin-install-warning-source">
          <span>{t("i18n.pluginInstallWarningSource")}</span>
          <strong title={pending.name}>{pending.name}</strong>
          <code title={pending.source}>{pending.source}</code>
          <span>{pending.scope === "global" ? t("skills.scope.global") : t("skills.scope.project")}</span>
        </div>
        {pending.description && (
          <p className="plugin-install-warning-description">{pending.description}</p>
        )}
        <label className="plugin-install-warning-acknowledge">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.currentTarget.checked)}
          />
          <span>{t("i18n.pluginInstallWarningAcknowledge")}</span>
        </label>
        <div className="plugin-install-warning-actions">
          <ConfigButton size="small" onClick={onCancel}>{t("i18n.cancel")}</ConfigButton>
          <ConfigButton
            size="small"
            variant="primary"
            disabled={!acknowledged}
            onClick={onConfirm}
          >
            {t("i18n.pluginInstallWarningContinue")}
          </ConfigButton>
        </div>
      </div>
    </div>
  );
}

function CommunityPluginPanel({
  packages,
  projectResourcesLoaded,
  busyKey,
  actionError,
  actionMessage,
  onInstall,
  catalog = COMMUNITY_PLUGIN_CATALOG,
}: {
  packages: PluginPackageInfo[];
  projectResourcesLoaded: boolean;
  busyKey: string | null;
  actionError: string | null;
  actionMessage: string | null;
  onInstall: (entry: CommunityPluginEntry, scope: PluginScope) => void;
  /** Future `/api/plugins/catalog` data can be injected without changing this UI. */
  catalog?: readonly CommunityPluginEntry[];
}) {
  const { locale, t } = useI18n();
  const [category, setCategory] = useState<CommunityPluginCategory | "all">("all");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<PluginScope>("global");
  const entries = useMemo(
    () => filterCommunityPluginCatalog(catalog, category, query),
    [catalog, category, query],
  );
  const riskSections = useMemo(
    () => (["low", "review"] as const)
      .map((risk) => ({ risk, entries: entries.filter((entry) => entry.risk === risk) }))
      .filter((section) => section.entries.length > 0),
    [entries],
  );
  const busy = busyKey !== null;

  return (
    <div className="config-detail plugins-community-panel">
      <ConfigDetailStack className="plugins-community-stack">
        <div className="plugins-community-heading">
          <div>
            <ConfigDetailTitle>{t("i18n.pluginCommunity")}</ConfigDetailTitle>
            <p>{t("i18n.pluginCommunityDescription")}</p>
          </div>
          <a
            className="plugins-community-source-link"
            href="https://pi.dev/packages"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("i18n.pluginOpenCatalog")} ↗
          </a>
        </div>

        <div className="plugins-community-toolbar">
          <div className="plugins-community-category-tabs" role="tablist" aria-label={t("i18n.pluginCategory")}>
            <button
              type="button"
              role="tab"
              aria-selected={category === "all"}
              className={`plugins-community-category-tab${category === "all" ? " is-active" : ""}`}
              onClick={() => setCategory("all")}
            >
              {t("i18n.pluginCategoryAll")}
            </button>
            {COMMUNITY_PLUGIN_CATEGORY_ORDER.map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={category === item}
                className={`plugins-community-category-tab${category === item ? " is-active" : ""}`}
                data-plugin-community-category={item}
                onClick={() => setCategory(item)}
              >
                {communityCategoryLabel(item, t)}
              </button>
            ))}
          </div>
          <input
            className="plugins-community-search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={t("i18n.pluginSearchPlaceholder")}
            aria-label={t("i18n.pluginSearchPlaceholder")}
          />
          <SegmentedScope
            value={scope}
            projectResourcesLoaded={projectResourcesLoaded}
            onChange={setScope}
          />
        </div>

        <div className="plugins-community-safe-note" role="note">
          <span className="plugins-community-safe-note-icon" aria-hidden="true">✓</span>
          <span>{t("i18n.pluginLowRiskNotice")}</span>
        </div>

        {actionMessage && <div className="plugins-action-notice is-success" role="status">{actionMessage}</div>}
        {actionError && <div className="plugins-action-notice is-error" role="alert">{actionError}</div>}

        {entries.length > 0 ? (
          <div className="plugins-community-risk-sections">
            {riskSections.map((section) => (
              <section className={`plugins-community-risk-section is-${section.risk}`} key={section.risk}>
                <div className="plugins-community-risk-section-heading">
                  <span>{section.risk === "low" ? "✓" : "!"}</span>
                  <strong>{communityRiskLabel(section.risk, t)}</strong>
                </div>
                <div className="plugins-community-grid">
                  {section.entries.map((entry) => {
                    const installed = packages.some(
                      (pkg) => pkg.scope === scope && sameCommunityPluginSource(pkg.source, entry.source),
                    );
                    return (
                      <article
                        key={entry.id}
                        className={`plugins-community-card plugins-community-card-risk-${entry.risk}`}
                        data-plugin-community-card={entry.id}
                      >
                        <div className="plugins-community-card-heading">
                          <div className="plugins-community-card-title-wrap">
                            <h3>{entry.name}</h3>
                            <code title={entry.source}>{entry.source}</code>
                          </div>
                          <span className={`plugins-community-risk plugins-community-risk-${entry.risk}`}>
                            {communityRiskLabel(entry.risk, t)}
                          </span>
                        </div>
                        <div className="plugins-community-card-meta">
                          <span className="plugins-community-category-badge">{communityCategoryLabel(entry.category, t)}</span>
                          {(entry.capabilities[locale] ?? entry.capabilities.en)
                            .map((capability) => <span key={capability}>{capability}</span>)}
                        </div>
                        <p className="plugins-community-card-description">
                          {entry.description[locale] ?? entry.description.en}
                        </p>
                        <div className="plugins-community-card-actions">
                          <a href={entry.packageUrl} target="_blank" rel="noopener noreferrer">
                            {t("i18n.pluginDetails")} ↗
                          </a>
                          <ConfigButton
                            size="small"
                            variant={installed ? "secondary" : "primary"}
                            disabled={installed || busy}
                            onClick={() => onInstall(entry, scope)}
                            data-plugin-community-install={entry.id}
                          >
                            {installed
                              ? `✓ ${t("i18n.installed")}`
                              : busyKey?.startsWith("install:") && busyKey.endsWith(`${scope}\0${entry.source}`)
                                ? t("i18n.installing")
                                : t("i18n.pluginInstallFromCommunity")}
                          </ConfigButton>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <ConfigEmptyState>{t("i18n.pluginNoCommunityResults")}</ConfigEmptyState>
        )}

        <div className="plugins-community-hidden-note">
          {t("i18n.pluginComplexHidden")} <a href="https://pi.dev/packages" target="_blank" rel="noopener noreferrer">{t("i18n.pluginOpenCatalog")}</a>.
        </div>
      </ConfigDetailStack>
    </div>
  );
}

function ResourceList({ pkg }: { pkg: PluginPackageInfo }) {
  const { t } = useI18n();
  const groups = ([
    ["extension", t("i18n.extensions")],
    ["skill", t("i18n.skills")],
    ["prompt", t("i18n.prompts")],
    ["theme", t("i18n.themes")],
  ] as const)
    .map(([kind, label]) => ({
      kind,
      label,
      resources: pkg.resources.filter((resource) => resource.kind === kind),
    }))
    .filter((group) => group.resources.length > 0);

  if (groups.length === 0) {
    return (
      <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
        {pkg.disabled ? t("i18n.packageDisabled") : t("i18n.noResolvedResources")}
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      {groups.map((group, groupIndex) => (
        <div
          key={group.kind}
          style={{
            borderTop: groupIndex === 0 ? "none" : "1px solid var(--border)",
            paddingTop: groupIndex === 0 ? 0 : 12,
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: "var(--text-dim)",
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            {group.label}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {group.resources.map((resource) => (
              <div key={`${resource.kind}:${resource.path}`} style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--text)",
                    fontFamily: "var(--font-mono)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={resource.path}
                >
                  {resource.name}
                </div>
                <div
                  style={{
                    fontSize: 10,
                    color: "var(--text-dim)",
                    fontFamily: "var(--font-mono)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    marginTop: 1,
                  }}
                  title={resource.path}
                >
                  {resource.relativePath}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ScopeTag({ scope }: { scope: PluginScope }) {
  return (
    <span
      style={{
        fontSize: 10,
        padding: "1px 5px",
        borderRadius: 3,
        flexShrink: 0,
        background: scope === "project" ? "rgba(99,102,241,0.12)" : "rgba(120,120,120,0.12)",
        color: scope === "project" ? "rgba(99,102,241,0.85)" : "var(--text-dim)",
      }}
    >
      {scope}
    </span>
  );
}

function SegmentedScope({
  value,
  projectResourcesLoaded,
  onChange,
}: {
  value: PluginScope;
  projectResourcesLoaded: boolean;
  onChange: (scope: PluginScope) => void;
}) {
  const { t } = useI18n();
  return (
    <div
      className="config-scope-control"
      style={{
        display: "inline-flex",
        border: "1px solid var(--border)",
        borderRadius: 7,
        overflow: "hidden",
        height: 30,
      }}
    >
      {(["global", "project"] as PluginScope[]).map((scope) => {
        const active = value === scope;
        const disabled = scope === "project" && !projectResourcesLoaded;
        return (
          <button
            key={scope}
            onClick={() => {
              if (!disabled) onChange(scope);
            }}
            disabled={disabled}
            title={disabled ? t("trust.projectScopeUnavailable") : undefined}
            style={{
              width: 76,
              border: "none",
              borderRight: scope === "global" ? "1px solid var(--border)" : "none",
              background: active ? "var(--bg-selected)" : "none",
              color: active ? "var(--text)" : "var(--text-muted)",
              cursor: disabled ? "not-allowed" : "pointer",
              opacity: disabled ? 0.45 : 1,
              fontSize: 12,
            }}
          >
            {scope}
          </button>
        );
      })}
    </div>
  );
}

function AddPluginPanel({
  cwd,
  source,
  scope,
  projectResourcesLoaded,
  busy,
  actionError,
  onSourceChange,
  onScopeChange,
  onInstall,
}: {
  cwd: string;
  source: string;
  scope: PluginScope;
  projectResourcesLoaded: boolean;
  busy: boolean;
  actionError: string | null;
  onSourceChange: (value: string) => void;
  onScopeChange: (scope: PluginScope) => void;
  onInstall: () => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const examples = ["npm:@scope/agent-plugin", "git:https://github.com/user/repo", "/absolute/path/to/plugin"];

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <ConfigDetailStack className="is-fill">
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <ConfigDetailTitle>{t("i18n.addPlugin")}</ConfigDetailTitle>
          <a
            href="https://pi.dev/packages"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              color: "var(--accent)",
              fontSize: 12,
              textDecoration: "none",
              whiteSpace: "nowrap",
            }}
          >
            {!METEORAGENT_PRODUCT_MODE && (
              <svg width="28" height="28" viewBox="0 0 800 800" aria-hidden="true" focusable="false" style={{ flexShrink: 0 }}>
                <path
                  fill="#000"
                  fillRule="evenodd"
                  d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
                />
                <path fill="#000" d="M517.36 400H634.72V634.72H517.36Z" />
              </svg>
            )}
            {METEORAGENT_PRODUCT_MODE ? "插件目录 ↗" : "pi.dev/packages"}
          </a>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
          {installLocation(scope, cwd)}
        </div>
      </div>

      <ConfigField label="Source">
        <input
          id="plugin-source"
          ref={inputRef}
          value={source}
          onChange={(e) => onSourceChange(e.target.value)}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text");
            const normalized = normalizePluginSourceInput(pasted);
            if (normalized === pasted) return;
            e.preventDefault();
            onSourceChange(normalized);
          }}
          onBlur={(e) => onSourceChange(normalizePluginSourceInput(e.currentTarget.value))}
          placeholder="npm:@scope/package"
          style={{
            width: "100%",
            height: 36,
            padding: "0 11px",
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            outline: "none",
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && source.trim() && !busy) onInstall();
          }}
        />
      </ConfigField>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <SegmentedScope
          value={scope}
          projectResourcesLoaded={projectResourcesLoaded}
          onChange={onScopeChange}
        />
        <ConfigButton
          variant="primary"
          onClick={onInstall}
          disabled={busy || !source.trim()}
          className="is-pushed-right"
        >
          {busy ? t("i18n.installing") : t("i18n.install")}
        </ConfigButton>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>
          Examples
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {examples.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => onSourceChange(example)}
              style={{
                width: "100%",
                minHeight: 30,
                textAlign: "left",
                padding: "6px 9px",
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "var(--bg-panel)",
                color: "var(--text-dim)",
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = "var(--text-muted)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "var(--bg-panel)";
                e.currentTarget.style.color = "var(--text-dim)";
              }}
            >
              {example}
            </button>
          ))}
        </div>
      </div>

      {actionError && (
        <div style={{ fontSize: 12, color: "#ef4444", whiteSpace: "pre-wrap" }}>
          {actionError}
        </div>
      )}
    </ConfigDetailStack>
  );
}

function PackageDetail({
  pkg,
  cwd,
  busyKey,
  actionError,
  actionMessage,
  sessionId,
  updateStatus,
  checkingUpdate,
  updateError,
  activationBusy,
  onAction,
  onActivationChange,
  onCheckUpdate,
  onReloadSession,
}: {
  pkg: PluginPackageInfo;
  cwd: string;
  busyKey: string | null;
  actionError: string | null;
  actionMessage: string | null;
  sessionId: string | null;
  updateStatus?: PluginUpdateResult;
  checkingUpdate: boolean;
  updateError: string | null;
  activationBusy: boolean;
  onAction: (action: PluginAction, pkg: PluginPackageInfo) => void;
  onActivationChange: (mode: PluginActivationMode) => void;
  onCheckUpdate: () => void;
  onReloadSession: () => void;
}) {
  const { t } = useI18n();
  const key = packageKey(pkg);
  const busy = busyKey?.endsWith(key) ?? false;
  const reloadBusy = busyKey === "reload";
  const enabled = pkg.globalEnabled;
  const canCheckForUpdates = pkg.canCheckForUpdates;
  const updateAvailable = updateStatus?.state === "update-available";

  return (
    <ConfigDetailStack>
      <ConfigDetailHeader className="is-top-aligned">
        <ConfigDetailHeaderInfo>
          <ScopeTag scope={pkg.scope} />
          {pkg.disabled ? (
            <span
              style={{
                fontSize: 10,
                padding: "1px 5px",
                borderRadius: 3,
                background: "rgba(120,120,120,0.12)",
                color: "var(--text-dim)",
              }}
            >
              {t("i18n.disabled")}
            </span>
          ) : pkg.filtered && (
            <span
              style={{
                fontSize: 10,
                padding: "1px 5px",
                borderRadius: 3,
                background: "rgba(245,158,11,0.12)",
                color: "#d97706",
              }}
            >
              {t("i18n.filtered")}
            </span>
          )}
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: "var(--text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {pkg.source}
          </span>
        </ConfigDetailHeaderInfo>

        <ConfigDetailActions>
          <ConfigButton
            size="small"
            variant={updateAvailable ? "primary" : undefined}
            onClick={updateAvailable || !canCheckForUpdates
              ? () => onAction("update", pkg)
              : onCheckUpdate}
            disabled={busy || reloadBusy || checkingUpdate || activationBusy}
            title={updateAvailable ? t("i18n.updateAvailable") : undefined}
          >
             {busyKey === `update:${key}`
               ? t("i18n.updating")
               : checkingUpdate
                 ? t("i18n.checking")
                 : updateAvailable || !canCheckForUpdates
                   ? t("i18n.update")
                   : t("i18n.check")}
          </ConfigButton>
          <ConfigButton
            size="small"
            onClick={onReloadSession}
            disabled={!sessionId || reloadBusy || busy || activationBusy}
             title={sessionId ? t("i18n.reloadSession") : t("i18n.openSessionToReload")}
          >
             {reloadBusy ? t("i18n.reloading") : t("i18n.reloadSession")}
          </ConfigButton>
          <ConfigButton
            variant="danger"
            size="small"
            onClick={() => onAction("remove", pkg)}
            disabled={busy || reloadBusy || activationBusy}
          >
             {busyKey === `remove:${key}` ? t("i18n.removing") : t("i18n.remove")}
          </ConfigButton>
          <ConfigSwitch
            checked={enabled}
            loading={busy || reloadBusy || activationBusy}
            onChange={() => onAction(pkg.disabled ? "enable" : "disable", pkg)}
            label={pkg.disabled ? t("i18n.enablePackage") : t("i18n.disablePackage")}
          />
        </ConfigDetailActions>
      </ConfigDetailHeader>

      <ConfigField label={t("i18n.pluginActivationMode")}>
        <div
          className="plugin-activation-mode-control"
          role="radiogroup"
          aria-label={t("i18n.pluginActivationMode")}
        >
          {(["global", "session"] as const).map((mode) => {
            const active = pkg.activationMode === mode;
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={active}
                className={`plugin-activation-mode-option${active ? " is-active" : ""}`}
                data-plugin-activation-mode={mode}
                disabled={busy || reloadBusy || activationBusy}
                onClick={() => onActivationChange(mode)}
              >
                {mode === "global" ? t("i18n.pluginActivationGlobal") : t("i18n.pluginActivationSession")}
              </button>
            );
          })}
        </div>
        <span className="plugin-activation-mode-help">
          {pkg.activationMode === "global"
            ? t("i18n.pluginActivationGlobalDescription")
            : t("i18n.pluginActivationSessionDescription")}
        </span>
        {activationBusy && <span className="plugin-activation-mode-saving">{t("i18n.pluginActivationSaving")}</span>}
      </ConfigField>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(96px, 130px) minmax(0, 1fr)",
          gap: "9px 14px",
          fontSize: 12,
          lineHeight: 1.45,
        }}
      >
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.status")}</div>
        <div style={{ color: statusColor(pkg.status), textTransform: "capitalize" }}>{pkg.status}</div>
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.version")}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <div className="skill-version-row">
            <span className="skill-version-value">{versionSummary(pkg, t)}</span>
            {updateAvailable && (
              <span className="skill-version-value is-update" title={updateStatus.displayName}>
                {t("i18n.updateAvailable")}
              </span>
            )}
            {canCheckForUpdates && (checkingUpdate || (updateStatus && !updateAvailable)) && (
              <span
                className={`skill-update-status ${checkingUpdate
                  ? "is-checking"
                  : updateStatus?.state === "up-to-date"
                    ? "is-success"
                    : updateStatus?.state === "error"
                      ? "is-error"
                      : "is-muted"}`}
              >
                {checkingUpdate
                  ? t("i18n.checking")
                  : updateStatus?.state === "up-to-date"
                    ? t("i18n.upToDate")
                    : updateStatus?.state === "unsupported"
                      ? t("i18n.automaticChecksUnavailable")
                      : updateStatus?.message || t("i18n.checkFailed")}
              </span>
            )}
          </div>
          {updateError && (
            <span style={{ fontSize: 12, color: "#ef4444" }}>{updateError}</span>
          )}
        </div>
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.package")}</div>
        <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
          {pkg.packageName ?? t("i18n.unknown")}
        </div>
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.resources")}</div>
         <div style={{ color: "var(--text-muted)" }}>{resourceSummary(pkg, t)}</div>
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.installedPath")}</div>
        <div
          style={{
            color: pkg.installedPath ? "var(--text-muted)" : "#ef4444",
            fontFamily: "var(--font-mono)",
            overflowWrap: "anywhere",
          }}
        >
          {pkg.installedPath
            ? METEORAGENT_PRODUCT_MODE ? "Magent 插件目录" : shortenPath(pkg.installedPath)
            : t("i18n.notFound")}
        </div>
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.cwd")}</div>
        <div style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
          {shortenPath(cwd)}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <ConfigSectionTitle>{t("i18n.resolvedResources")}</ConfigSectionTitle>
        <ResourceList pkg={pkg} />
      </div>

      {actionMessage && (
        <div style={{ fontSize: 12, color: "#16a34a" }}>
          {actionMessage}
        </div>
      )}
      {actionError && (
        <div style={{ fontSize: 12, color: "#ef4444", whiteSpace: "pre-wrap" }}>
          {actionError}
        </div>
      )}
    </ConfigDetailStack>
  );
}

function StandaloneExtensionDetail({ extension }: { extension: PluginStandaloneExtensionInfo }) {
  const { t } = useI18n();
  const status = extension.enabled ? "loaded" : "disabled";

  return (
    <ConfigDetailStack>
      <ConfigDetailHeader>
        <ConfigDetailHeaderInfo>
          <ScopeTag scope={extension.scope} />
          <ConfigDetailTitle>{extension.name}</ConfigDetailTitle>
        </ConfigDetailHeaderInfo>
      </ConfigDetailHeader>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(96px, 130px) minmax(0, 1fr)",
          gap: "9px 14px",
          fontSize: 12,
          lineHeight: 1.45,
        }}
      >
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.status")}</div>
        <div style={{ color: extension.enabled ? "var(--accent)" : "var(--text-dim)" }}>{status}</div>
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.installedPath")}</div>
        <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
          {METEORAGENT_PRODUCT_MODE ? "Magent 扩展目录" : shortenPath(extension.path)}
        </div>
      </div>
    </ConfigDetailStack>
  );
}

export function PluginsConfig({
  cwd,
  sessionId,
  onClose,
  onReloaded,
  embedded = false,
}: {
  cwd: string;
  sessionId: string | null;
  onClose: () => void;
  onReloaded?: () => void;
  embedded?: boolean;
}) {
  const { locale, t } = useI18n();
  const [data, setData] = useState<PluginsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(() => getLastSettingsSelection("plugins", cwd));
  const [view, setView] = useState<PluginView>("community");
  const [addMode, setAddMode] = useState(false);
  const [installSource, setInstallSource] = useState("");
  const [installScope, setInstallScope] = useState<PluginScope>("global");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [activationBusyKey, setActivationBusyKey] = useState<string | null>(null);
  const [pendingInstall, setPendingInstall] = useState<PendingPluginInstall | null>(null);
  const [installProgress, setInstallProgress] = useState<InstallProgressState | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [updateStatuses, setUpdateStatuses] = useState<Record<string, PluginUpdateResult>>({});
  const [checkingUpdates, setCheckingUpdates] = useState<Set<string>>(new Set());
  const [checkingAll, setCheckingAll] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updatingAll, setUpdatingAll] = useState(false);

  const packages = useMemo(() => data?.packages ?? [], [data?.packages]);
  const standaloneExtensions = useMemo(() => data?.standaloneExtensions ?? [], [data?.standaloneExtensions]);
  const selectedPackage = packages.find((pkg) => packageKey(pkg) === selected) ?? null;
  const selectedExtension = standaloneExtensions.find((extension) => extensionKey(extension) === selected) ?? null;
  const projectResourcesLoaded = data?.projectResourcesLoaded ?? true;

  const groupedPackages = useMemo(() => {
    return (["project", "global"] as PluginScope[])
      .map((scope) => ({ scope, packages: packages.filter((pkg) => pkg.scope === scope) }))
      .filter((group) => group.packages.length > 0);
  }, [packages]);

  const loadPlugins = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const sessionQuery = sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : "";
      const res = await fetch(`/api/plugins?cwd=${encodeURIComponent(cwd)}${sessionQuery}`);
      const next = (await res.json()) as PluginsResponse & { error?: string };
      if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
      setData(next);
      setSelected((current) => {
        if (current && (
          next.packages.some((pkg) => packageKey(pkg) === current)
          || next.standaloneExtensions.some((extension) => extensionKey(extension) === current)
        )) return current;
        return next.packages[0]
          ? packageKey(next.packages[0])
          : next.standaloneExtensions[0]
            ? extensionKey(next.standaloneExtensions[0])
            : null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [cwd, sessionId]);

  useEffect(() => {
    setUpdateStatuses({});
    setUpdateError(null);
    void loadPlugins();
  }, [cwd, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (selected) setLastSettingsSelection("plugins", selected, cwd);
  }, [cwd, selected]);

  const checkForUpdates = useCallback(async (pkg?: PluginPackageInfo) => {
    const targets = pkg ? [pkg] : packages.filter((item) => item.canCheckForUpdates);
    const keys = targets.map(packageKey);
    if (keys.length === 0) return;

    setUpdateError(null);
    setCheckingUpdates((current) => new Set([...current, ...keys]));
    if (!pkg) setCheckingAll(true);
    try {
      const res = await fetch("/api/plugins/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          source: pkg?.source,
          scope: pkg?.scope,
        }),
      });
      const data = (await res.json()) as {
        updates?: PluginUpdateResult[];
        error?: string;
      };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setUpdateStatuses((current) => {
        const next = { ...current };
        for (const update of data.updates ?? []) {
          next[packageKey(update)] = update;
        }
        return next;
      });
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckingUpdates((current) => {
        const next = new Set(current);
        for (const key of keys) next.delete(key);
        return next;
      });
      if (!pkg) setCheckingAll(false);
    }
  }, [cwd, packages]);

  const updateAllPluginsAction = useCallback(async () => {
    setUpdatingAll(true);
    setActionError(null);
    setActionMessage(null);
    setUpdateError(null);
    try {
      const res = await fetch("/api/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update", cwd }),
      });
      const next = (await res.json()) as PluginsResponse & { error?: string };
      if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
      setData(next);
      setUpdateStatuses({});
      setActionMessage(t("i18n.packagesUpdated"));
      if (sessionId) {
        setActionMessage(`${t("i18n.packagesUpdated")} ${t("agents.reloadRequired")}`);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdatingAll(false);
    }
  }, [cwd, sessionId, t]);

  const runAction = useCallback(async (action: PluginAction, pkg: PluginPackageInfo) => {
    const key = packageKey(pkg);
    setBusyKey(`${action}:${key}`);
    setActionError(null);
    setActionMessage(null);
    try {
      const res = await fetch("/api/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, source: pkg.source, scope: pkg.scope, cwd }),
      });
      const next = (await res.json()) as PluginsResponse & { error?: string };
      if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
      setData(next);
      if (action === "remove") {
        setSelected(next.packages[0]
          ? packageKey(next.packages[0])
          : next.standaloneExtensions[0]
            ? extensionKey(next.standaloneExtensions[0])
            : null);
        if (next.packages.length === 0 && next.standaloneExtensions.length === 0) setAddMode(true);
        setActionMessage("Package removed.");
        setUpdateStatuses((current) => {
          const nextStatuses = { ...current };
          delete nextStatuses[key];
          return nextStatuses;
        });
      } else {
        const messages: Record<Exclude<PluginAction, "remove">, string> = {
          install: "Package installed.",
          update: "Package updated.",
          disable: "Package disabled.",
          enable: "Package enabled.",
        };
        setActionMessage(messages[action]);
        if (action === "update") {
          setUpdateStatuses((current) => {
            const nextStatuses = { ...current };
            delete nextStatuses[key];
            return nextStatuses;
          });
        }
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }, [cwd]);

  const changeActivationMode = useCallback(async (pkg: PluginPackageInfo, mode: PluginActivationMode) => {
    if (pkg.activationMode === mode) return;
    const key = packageKey(pkg);
    setActivationBusyKey(key);
    setActionError(null);
    setActionMessage(null);
    try {
      const res = await fetch("/api/plugins/activation", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          source: pkg.source,
          scope: pkg.scope,
          mode,
        }),
      });
      const next = (await res.json()) as { error?: string };
      if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
      await loadPlugins();
      setActionMessage(t("i18n.pluginActivationSaved"));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActivationBusyKey(null);
    }
  }, [cwd, loadPlugins, t]);

  const performInstall = useCallback(async (sourceInput: string, scope: PluginScope) => {
    const source = normalizePluginSourceInput(sourceInput).trim();
    if (!source) return;
    const key = `${scope}\0${source}`;
    setBusyKey(`install:${key}`);
    setInstallProgress({ source, scope, stage: 0 });
    setActionError(null);
    setActionMessage(null);
    try {
      const res = await fetch("/api/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "install", source, scope, cwd }),
      });
      const next = (await res.json()) as PluginsResponse & { error?: string };
      if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
      setData(next);
      const installed = findInstalledPackage(next.packages, source, scope);
      setSelected(installed ? packageKey(installed) : key);
      setView("installed");
      setAddMode(false);
      setInstallSource("");
      setActionMessage(t("i18n.packageInstalled"));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
      setInstallProgress(null);
    }
  }, [cwd, t]);

  const requestManualInstall = useCallback(() => {
    const source = normalizePluginSourceInput(installSource).trim();
    if (!source || busyKey) return;
    setInstallSource(source);
    setActionError(null);
    setActionMessage(null);
    setPendingInstall({
      source,
      scope: installScope,
      name: source,
    });
  }, [busyKey, installScope, installSource]);

  const requestCommunityInstall = useCallback((entry: CommunityPluginEntry, scope: PluginScope) => {
    if (busyKey) return;
    setActionError(null);
    setActionMessage(null);
    setPendingInstall({
      source: entry.source,
      scope,
      name: entry.name,
      description: entry.description[locale] ?? entry.description.en,
      packageUrl: entry.packageUrl,
      category: entry.category,
    });
  }, [busyKey, locale]);

  const confirmPendingInstall = useCallback(() => {
    if (!pendingInstall) return;
    const next = pendingInstall;
    setPendingInstall(null);
    setView("installed");
    void performInstall(next.source, next.scope);
  }, [pendingInstall, performInstall]);

  const installProgressKey = installProgress
    ? `${installProgress.scope}\0${installProgress.source}`
    : null;

  useEffect(() => {
    if (!installProgressKey) return;
    const timers = ([1, 2, 3] as InstallStage[]).map((stage, index) => window.setTimeout(() => {
      setInstallProgress((current) => current && `${current.scope}\0${current.source}` === installProgressKey
        ? { ...current, stage }
        : current);
    }, (index + 1) * 700));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [installProgressKey]);

  const reloadSession = useCallback(async () => {
    if (!sessionId) return;
    setBusyKey("reload");
    setActionError(null);
    setActionMessage(null);
    try {
      await sendAgentCommand(sessionId, { type: "reload" });
      onReloaded?.();
      await loadPlugins();
      setActionMessage("Session reloaded.");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }, [loadPlugins, onReloaded, sessionId]);

  const addBusy = busyKey?.startsWith("install:") ?? false;
  const availableUpdateCount = Object.values(updateStatuses).filter(
    (status) => status.state === "update-available",
  ).length;
  const hasCheckablePackages = packages.some((pkg) => pkg.canCheckForUpdates);
  const footerBusy = loading || busyKey !== null || activationBusyKey !== null || checkingUpdates.size > 0 || updatingAll;

  return (
    <ConfigPanelShell embedded={embedded} title={t("common.plugins")} subtitle={shortenPath(cwd)} closeLabel={t("i18n.close")} onClose={onClose}>

        {!projectResourcesLoaded && (
          <div role="status" className="config-trust-notice">
            {t("trust.pluginsNotLoaded")}
          </div>
        )}

        {installProgress && <PluginInstallProgress progress={installProgress} />}

        <PluginViewTabs
          value={view}
          installedCount={packages.length + standaloneExtensions.length}
          onChange={(next) => {
            setView(next);
            if (next === "community") setAddMode(false);
          }}
        />

        {view === "community" ? (
          <CommunityPluginPanel
            packages={packages}
            projectResourcesLoaded={projectResourcesLoaded}
            busyKey={busyKey}
            actionError={actionError}
            actionMessage={actionMessage}
            onInstall={requestCommunityInstall}
          />
        ) : (
        <ConfigSplitView>
          <ConfigSidebar>
            <ConfigSidebarList>
              {loading ? (
                <div className="config-sidebar-message">
                  Loading...
                </div>
              ) : error ? (
                <div className="config-sidebar-message is-error">
                  {error}
                </div>
              ) : packages.length === 0 && standaloneExtensions.length === 0 ? (
                <div className="config-sidebar-message is-empty">
                  No plugins configured
                </div>
              ) : (
                <>
                  {standaloneExtensions.length > 0 && (
                    <div className="config-sidebar-group">
                      <ConfigSidebarGroupLabel>{t("i18n.extensions")}</ConfigSidebarGroupLabel>
                      {standaloneExtensions.map((extension) => {
                        const key = extensionKey(extension);
                        return (
                          <ConfigSidebarItem
                            key={key}
                            active={!addMode && selected === key}
                            title={extension.path}
                            onClick={() => {
                              setSelected(key);
                              setAddMode(false);
                              setActionError(null);
                              setActionMessage(null);
                            }}
                          >
                            <ConfigStatusDot active={extension.enabled} />
                            <ConfigSidebarText className={`is-grow${extension.enabled ? "" : " is-muted"}`}>
                              {extension.name}
                            </ConfigSidebarText>
                          </ConfigSidebarItem>
                        );
                      })}
                    </div>
                  )}
                  {groupedPackages.map((group) => (
                    <div key={group.scope} className="config-sidebar-group">
                      <ConfigSidebarGroupLabel>
                        {group.scope}
                      </ConfigSidebarGroupLabel>
                      {group.packages.map((pkg) => {
                        const key = packageKey(pkg);
                        const isSelected = !addMode && selected === key;
                        return (
                          <ConfigSidebarItem
                            key={key}
                            active={isSelected}
                            onClick={() => {
                              setSelected(key);
                              setAddMode(false);
                              setActionError(null);
                              setActionMessage(null);
                            }}
                          >
                            <ConfigStatusDot active={!pkg.disabled} color={statusColor(pkg.status)} />
                            <ConfigSidebarText className={`is-grow${pkg.disabled ? " is-muted" : ""}`}>
                              {pkg.source}
                            </ConfigSidebarText>
                            {updateStatuses[packageKey(pkg)]?.state === "update-available" && (
                              <span title={t("i18n.updateAvailable")} className="skill-update-indicator">
                                ↑
                              </span>
                            )}
                          </ConfigSidebarItem>
                        );
                      })}
                    </div>
                  ))}
                </>
              )}
            </ConfigSidebarList>
            <ConfigListAction
                active={addMode}
                onClick={() => {
                  setView("installed");
                  setAddMode(true);
                  setActionError(null);
                  setActionMessage(null);
                }}
              >
                 {t("i18n.addPlugin")}
            </ConfigListAction>
          </ConfigSidebar>

          <ConfigDetail>
            <ConfigDetailStack className="is-fill">
              {!loading && !addMode && !selectedPackage && !selectedExtension && actionError && (
                <div className="plugins-action-notice is-error" role="alert">{actionError}</div>
              )}
              {!loading && !addMode && !selectedPackage && !selectedExtension && actionMessage && (
                <div className="plugins-action-notice is-success" role="status">{actionMessage}</div>
              )}
              {addMode ? (
              <AddPluginPanel
                cwd={cwd}
                source={installSource}
                scope={installScope}
                projectResourcesLoaded={projectResourcesLoaded}
                busy={addBusy}
                actionError={actionError}
                onSourceChange={setInstallSource}
                onScopeChange={setInstallScope}
                onInstall={requestManualInstall}
              />
            ) : loading ? null : selectedExtension ? (
              <StandaloneExtensionDetail extension={selectedExtension} />
            ) : selectedPackage ? (
              <PackageDetail
                key={packageKey(selectedPackage)}
                pkg={selectedPackage}
                cwd={cwd}
                busyKey={busyKey}
                actionError={actionError}
                actionMessage={actionMessage}
                sessionId={sessionId}
                updateStatus={updateStatuses[packageKey(selectedPackage)]}
                checkingUpdate={checkingUpdates.has(packageKey(selectedPackage))}
                updateError={updateError}
                activationBusy={activationBusyKey === packageKey(selectedPackage)}
                onAction={runAction}
                onActivationChange={(mode) => void changeActivationMode(selectedPackage, mode)}
                onCheckUpdate={() => void checkForUpdates(selectedPackage)}
                onReloadSession={reloadSession}
              />
              ) : (
                <ConfigEmptyState>{t("i18n.selectPackage")}</ConfigEmptyState>
              )}
            </ConfigDetailStack>
          </ConfigDetail>
        </ConfigSplitView>
        )}

        <ConfigFooter status={
            availableUpdateCount > 0 ? (
              <span style={{ fontSize: 12, color: "var(--accent)" }}>
                {availableUpdateCount}{" "}
                {availableUpdateCount === 1 ? t("i18n.update") : t("i18n.updates")}
              </span>
            ) : data?.diagnostics.length ? (
              <span
                title={data.diagnostics.map((d) => `${d.type}: ${d.source ? `${d.source}: ` : ""}${d.message}`).join("\n")}
                style={{ color: data.diagnostics.some((d) => d.type === "error") ? "#ef4444" : "#d97706" }}
              >
                {data.diagnostics.length} diagnostic{data.diagnostics.length === 1 ? "" : "s"}
              </span>
            ) : (
              <span>
                {data ? `${data.totals.extensions} ext · ${data.totals.skills} skills · ${data.totals.prompts} prompts · ${data.totals.themes} themes` : ""}
              </span>
            )}
        >
          {!embedded && <ConfigButton onClick={onClose}>{t("i18n.close")}</ConfigButton>}
          {hasCheckablePackages && (
            <ConfigButton
              variant={availableUpdateCount > 0 ? "primary" : "secondary"}
              onClick={() => void (availableUpdateCount > 0 ? updateAllPluginsAction() : checkForUpdates())}
              disabled={footerBusy}
              title={availableUpdateCount > 0 ? t("i18n.updateAllPluginsHint") : undefined}
            >
              {updatingAll
                ? t("i18n.updating")
                : checkingAll
                  ? t("i18n.checking")
                  : availableUpdateCount > 0
                    ? `${t("i18n.updateAllPlugins")} (${availableUpdateCount})`
                    : t("i18n.checkUpdates")}
            </ConfigButton>
          )}
          <ConfigButton variant="secondary" onClick={() => void loadPlugins()} disabled={footerBusy}>
             {t("i18n.refresh")}
          </ConfigButton>
        </ConfigFooter>

        {pendingInstall && (
          <PluginInstallWarningDialog
            pending={pendingInstall}
            onCancel={() => setPendingInstall(null)}
            onConfirm={confirmPendingInstall}
          />
        )}
    </ConfigPanelShell>
  );
}
