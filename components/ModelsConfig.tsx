"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { ModelCatalogPreset, ModelCatalogRecommendation } from "@/lib/model-catalog";
import type { DiscoveredModel } from "@/lib/model-discovery";
import {
  getLastSettingsSelection,
  setLastSettingsSelection,
} from "@/lib/settings-navigation";
import {
  hasModelCostDraftValue,
  modelCostToDraft,
  parseCompleteModelCost,
  serializeHeaderRows,
  setCompatBool,
  updateHeaderRow,
  type HeaderRow,
  type ModelCostDraft,
  type ModelCostKey,
} from "./models-config-helpers";
import {
  ConfigButton,
  ConfigDetail,
  ConfigDetailActions,
  ConfigDetailHeader,
  ConfigDetailHeaderInfo,
  ConfigDetailStack,
  ConfigEmptyState,
  ConfigField,
  ConfigFooter,
  ConfigListAction,
  ConfigPanelShell,
  ConfigSectionTitle,
  ConfigSidebar,
  ConfigSidebarGroupLabel,
  ConfigSidebarItem,
  ConfigSidebarList,
  ConfigSidebarText,
  ConfigSplitView,
} from "./SettingsUi";
import { ProviderIcon } from "./ProviderIcon";
import { ProviderUsageSummary } from "./ProviderUsageSummary";
import { RelayUsageSummary } from "./RelayUsageSummary";
import { RelayKeyRefresh } from "./RelayKeyRefresh";
import { RelayOnboarding } from "./RelayOnboarding";
import { isRelayProviderId } from "@/lib/relay-config";
import { useRelaySession } from "@/hooks/useRelaySession";
import { clampRelayContextWindow, relayContextWindowLimit } from "@/lib/relay-model-policy";

// ── Types ─────────────────────────────────────────────────────────────────────

interface OAuthProvider {
  id: string;
  name: string;
  usesCallbackServer: boolean;
  loggedIn: boolean;
  /** Provider also accepts an API key, so it appears in both picker sections. */
  supportsApiKey?: boolean;
}

interface ApiKeyProvider {
  id: string;
  displayName: string;
  configured: boolean;
  source?: string;
  modelCount: number;
  /** Provider also supports OAuth, so it appears in both picker sections. */
  supportsOAuth?: boolean;
}

type OAuthLoginState =
  | { phase: "idle" }
  | { phase: "connecting" }
  | { phase: "auth"; url: string; instructions: string | null; token: string }
  | { phase: "device_code"; userCode: string; verificationUri: string; intervalSeconds: number | null; expiresInSeconds: number | null }
  | { phase: "prompt"; message: string; placeholder: string | null; token: string }
  | { phase: "select"; message: string; options: { id: string; label: string }[]; token: string }
  | { phase: "progress"; message: string }
  | { phase: "success" }
  | { phase: "error"; message: string };

interface ModelEntry {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; tiers?: unknown };
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

interface ProviderEntry {
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models?: ModelEntry[];
  modelOverrides?: Record<string, unknown>;
}

interface ModelsJson {
  providers?: Record<string, ProviderEntry>;
}

/** Product-mode data returned by /api/relay-accounts. Keep this separate from
 * the editable models.json shape: an account owns several API-key groups. */
interface RelayAccountSummary {
  accountId: string;
  email: string;
  username?: string;
  balance?: number | string;
  status?: string | number;
  active?: boolean;
  groups?: RelayGroupSummary[];
}

interface RelayGroupSummary {
  accountId: string;
  providerId: string;
  keyId: string | number;
  keyName: string;
  maskedKey: string;
  groupId?: string | number;
  groupName?: string;
  platform?: string;
  rateMultiplier?: number;
  /** Exact chat-model ids returned by the authenticated API key. */
  modelIds?: string[];
  contextWindows?: Record<string, number>;
  imageModels?: string[];
  modelCount: number;
  chatModelCount?: number;
  imageModelCount?: number;
  protocols?: string[];
  syncedAt?: string | number;
}

interface RelayAccountsResponse {
  ok?: boolean;
  accounts?: RelayAccountSummary[];
  activeAccountId?: string;
  groups?: RelayGroupSummary[];
  error?: string;
}

interface RelayAccountUsageResponse {
  status: "ready" | "unavailable";
  usage?: {
    todayRequests: number;
    todayActualCost: number;
    todayTokens: number;
  };
  capturedAt?: number;
}

type RelaySelection =
  | { type: "account"; accountId: string }
  | { type: "group"; accountId: string; providerId: string }
  | { type: "model"; accountId: string; providerId: string; modelId: string }
  | { type: "add-account" };

const RELAY_PRODUCT_MODE = process.env.NEXT_PUBLIC_AUTH_GATE === "1";
const RELAY_CONSOLE_URL = "https://api.meteor21c.fun";

type ModelTestState =
  | { phase: "idle" }
  | { phase: "testing" }
  | { phase: "success"; latencyMs?: number; status?: number; responseText?: string }
  | { phase: "error"; message: string; latencyMs?: number; status?: number };

type ModelDiscoveryState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "success"; models: DiscoveredModel[]; endpoint: string }
  | { phase: "error"; message: string };

type ModelCatalogState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "success"; recommendation: ModelCatalogRecommendation; appliedCount: number }
  | { phase: "error"; message: string };

type Selection =
  | { type: "provider"; name: string }
  | { type: "model"; providerName: string; index: number }
  | { type: "oauth"; providerId: string }
  | { type: "apikey"; providerId: string };

function readRememberedSelection(): Selection | null {
  const raw = getLastSettingsSelection("models");
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object") return null;
    const selection = value as Record<string, unknown>;
    if (selection.type === "provider" && typeof selection.name === "string") {
      return { type: "provider", name: selection.name };
    }
    if (selection.type === "model"
      && typeof selection.providerName === "string"
      && typeof selection.index === "number"
      && Number.isInteger(selection.index)
      && selection.index >= 0) {
      return { type: "model", providerName: selection.providerName, index: selection.index };
    }
    if ((selection.type === "oauth" || selection.type === "apikey")
      && typeof selection.providerId === "string") {
      return { type: selection.type, providerId: selection.providerId };
    }
  } catch {
    // Ignore malformed browser state.
  }
  return null;
}

function customSelectionExists(config: ModelsJson, selection: Selection): boolean {
  if (selection.type === "provider") return Boolean(config.providers?.[selection.name]);
  if (selection.type !== "model") return true;
  return Boolean(config.providers?.[selection.providerName]?.models?.[selection.index]);
}

const API_OPTIONS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;
const RELAY_OPENAI_MODEL_ID = /^(?:gpt(?:-|$)|chatgpt(?:-|$)|codex(?:-|$)|o\d(?:-|$)|computer-use(?:-|$))/i;

// ── Form field helpers ────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <ConfigField label={label}>{children}</ConfigField>;
}

const inputStyle = {
  padding: "6px 9px",
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: 5,
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
  width: "100%",
  boxSizing: "border-box" as const,
};

function TextInput({ value, onChange, placeholder, mono }: { value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean }) {
  return <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
    style={{ ...inputStyle, fontFamily: mono ? "var(--font-mono)" : "inherit" }} />;
}

function SecretTextInput({
  value,
  onChange,
  placeholder,
  mono,
  onKeyDown,
  autoComplete = "off",
  spellCheck = false,
  style,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  autoComplete?: string;
  spellCheck?: boolean;
  style?: React.CSSProperties;
}) {
  const [visible, setVisible] = useState(false);
  const { t } = useI18n();

  useEffect(() => {
    if (!value) setVisible(false);
  }, [value]);

  return (
    <div style={{ position: "relative", width: "100%", ...style }}>
      <input
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        style={{ ...inputStyle, paddingRight: 34, fontFamily: mono ? "var(--font-mono)" : "inherit" }}
        autoComplete={autoComplete}
        spellCheck={spellCheck}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
         aria-label={visible ? t("i18n.hideDetails") : t("i18n.showDetails")}
         title={visible ? t("i18n.hideDetails") : t("i18n.showDetails")}
        style={{
          position: "absolute",
          right: 5,
          top: "50%",
          transform: "translateY(-50%)",
          width: 24,
          height: 24,
          padding: 0,
          border: "none",
          background: "transparent",
          color: "var(--text-dim)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {visible ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20C7 20 2.73 16.89 1 12a18.45 18.45 0 0 1 5.06-6.94" />
            <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c5 0 9.27 3.11 11 8a18.5 18.5 0 0 1-2.16 3.19" />
            <path d="M14.12 14.12A3 3 0 0 1 9.88 9.88" />
            <path d="M1 1l22 22" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
    </div>
  );
}

function NumInput({ value, onChange, placeholder, max }: { value: string; onChange: (v: string) => void; placeholder?: string; max?: number }) {
  return <input type="number" min={0} max={max} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} style={inputStyle} />;
}

function Select({ value, onChange, options, required }: { value: string; onChange: (v: string) => void; options: readonly string[]; required?: boolean }) {
  const { t } = useI18n();
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      style={{ ...inputStyle, color: value ? "var(--text)" : "var(--text-dim)" }}>
       {!required && <option value="">— {t("i18n.default")} / none —</option>}
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, color: "var(--text-muted)" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
        style={{ width: 13, height: 13, accentColor: "var(--accent)", cursor: "pointer" }} />
      {label}
    </label>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <ConfigSectionTitle>{children}</ConfigSectionTitle>;
}

// ── Provider detail ───────────────────────────────────────────────────────────

function ProviderDetail({ name, provider, onChange, onRename, onDelete, onAddModels }: {
  name: string; provider: ProviderEntry;
  onChange: (p: ProviderEntry) => void; onRename: (n: string) => void; onDelete: () => void;
  onAddModels: (models: DiscoveredModel[]) => void;
}) {
  const { t } = useI18n();
  const [editingName, setEditingName] = useState(name);
  const [discoveryState, setDiscoveryState] = useState<ModelDiscoveryState>({ phase: "idle" });
  const [discoveryQuery, setDiscoveryQuery] = useState("");
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const discoveryRequestIdRef = useRef(0);
  const selectShownRef = useRef<HTMLInputElement>(null);
  useEffect(() => setEditingName(name), [name]);
  const set = <K extends keyof ProviderEntry>(k: K, v: ProviderEntry[K]) => onChange({ ...provider, [k]: v });

  useEffect(() => {
    if (!provider.api) onChange({ ...provider, api: "openai-completions" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.api]);

  useEffect(() => {
    discoveryRequestIdRef.current += 1;
    setDiscoveryState({ phase: "idle" });
    setDiscoveryQuery("");
    setSelectedModelIds([]);
  }, [name, provider.baseUrl, provider.api, provider.apiKey]);

  const handleDiscoverModels = useCallback(async () => {
    if (!provider.baseUrl?.trim() || discoveryState.phase === "loading") return;
    const requestId = ++discoveryRequestIdRef.current;
    setDiscoveryState({ phase: "loading" });
    setSelectedModelIds([]);
    try {
      const res = await fetch("/api/models-config/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerName: name, provider: { ...provider, models: undefined } }),
      });
      const data = await res.json() as { models?: DiscoveredModel[]; endpoint?: string; error?: string };
      if (requestId !== discoveryRequestIdRef.current) return;
      if (!res.ok || data.error || !data.models) {
        setDiscoveryState({ phase: "error", message: data.error ?? `HTTP ${res.status}` });
        return;
      }
      setDiscoveryState({ phase: "success", models: data.models, endpoint: data.endpoint ?? provider.baseUrl });
    } catch (error) {
      if (requestId !== discoveryRequestIdRef.current) return;
      setDiscoveryState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [discoveryState.phase, name, provider]);

  const existingModelIds = new Set((provider.models ?? []).map((model) => model.id));
  const discoveredModels = discoveryState.phase === "success" ? discoveryState.models : [];
  const normalizedDiscoveryQuery = discoveryQuery.trim().toLocaleLowerCase();
  const filteredDiscoveredModels = discoveredModels.filter((model) => !normalizedDiscoveryQuery
    || model.id.toLocaleLowerCase().includes(normalizedDiscoveryQuery)
    || model.name?.toLocaleLowerCase().includes(normalizedDiscoveryQuery));
  const shownDiscoveredModels = filteredDiscoveredModels.slice(0, 300);
  const selectableShownIds = shownDiscoveredModels
    .filter((model) => !existingModelIds.has(model.id))
    .map((model) => model.id);
  const selectedCount = selectedModelIds.filter((id) => !existingModelIds.has(id)).length;
  const allShownSelected = selectableShownIds.length > 0
    && selectableShownIds.every((id) => selectedModelIds.includes(id));
  const someShownSelected = !allShownSelected
    && selectableShownIds.some((id) => selectedModelIds.includes(id));

  useEffect(() => {
    if (selectShownRef.current) selectShownRef.current.indeterminate = someShownSelected;
  }, [someShownSelected]);

  const toggleDiscoveredModel = (id: string) => {
    setSelectedModelIds((current) => current.includes(id)
      ? current.filter((entry) => entry !== id)
      : [...current, id]);
  };

  const toggleShownModels = () => {
    const shownIds = new Set(selectableShownIds);
    setSelectedModelIds((current) => allShownSelected
      ? current.filter((id) => !shownIds.has(id))
      : Array.from(new Set([...current, ...selectableShownIds])));
  };

  const addSelectedModels = () => {
    if (discoveryState.phase !== "success") return;
    const selected = new Set(selectedModelIds);
    const additions = discoveryState.models.filter((model) => selected.has(model.id) && !existingModelIds.has(model.id));
    if (additions.length === 0) return;
    onAddModels(additions);
    setSelectedModelIds([]);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <ConfigDetailHeader>
        <ConfigDetailHeaderInfo>
          <SectionTitle>{t("i18n.provider")}</SectionTitle>
        </ConfigDetailHeaderInfo>
        <ConfigDetailActions>
          <ConfigButton variant="danger" size="small" onClick={onDelete}>{t("i18n.delete")}</ConfigButton>
        </ConfigDetailActions>
      </ConfigDetailHeader>

       <Field label={t("i18n.providerName")}>
        <TextInput value={editingName} onChange={setEditingName} placeholder="provider-name" mono />
        {editingName !== name && editingName.trim() && (
          <button onClick={() => onRename(editingName.trim())}
            style={{ marginTop: 4, padding: "3px 10px", background: "var(--accent)", border: "none", borderRadius: 4, color: "var(--accent-contrast)", cursor: "pointer", fontSize: 11, alignSelf: "flex-start" }}>
             {t("i18n.rename")}
          </button>
        )}
      </Field>

      <Field label="Base URL">
        <TextInput value={provider.baseUrl ?? ""} onChange={(v) => set("baseUrl", v || undefined)}
          placeholder="https://api.example.com/v1" mono />
      </Field>

      <Field label="API Key">
        <SecretTextInput value={provider.apiKey ?? ""} onChange={(v) => set("apiKey", v || undefined)}
          placeholder="ENV_VAR_NAME, !shell-command, or literal key" mono />
        <span style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
          Prefix with <code style={{ fontFamily: "var(--font-mono)" }}>!</code> to run a shell command, or use an env var name
        </span>
      </Field>

      <Field label="API">
        <Select value={provider.api ?? "openai-completions"} onChange={(v) => set("api", v)} options={API_OPTIONS} required />
      </Field>

      <Field label="Headers">
        <HeaderListEditor
          headers={provider.headers}
          onChange={(headers) => set("headers", headers)}
        />
        <span style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
          Added to every request from this provider (e.g. User-Agent). Useful for gateways with bot detection.
        </span>
      </Field>

      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        {discoveryState.phase !== "success" && (
          <button
            onClick={handleDiscoverModels}
            disabled={!provider.baseUrl?.trim() || discoveryState.phase === "loading"}
            style={{
              alignSelf: "flex-start", height: 30, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 5,
              background: "var(--bg-panel)", color: !provider.baseUrl?.trim() || discoveryState.phase === "loading" ? "var(--text-dim)" : "var(--text-muted)",
              cursor: !provider.baseUrl?.trim() || discoveryState.phase === "loading" ? "not-allowed" : "pointer", fontSize: 11,
            }}
          >
            {discoveryState.phase === "loading" ? t("models.discoveryFetching") : t("models.discoveryFetch")}
          </button>
        )}

        {discoveryState.phase === "error" && (
          <div style={{ padding: "7px 9px", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 5, color: "#ef4444", fontSize: 11, lineHeight: 1.4 }}>
            {discoveryState.message}
          </div>
        )}

        {discoveryState.phase === "success" && (
          <>
            <input
              value={discoveryQuery}
              onChange={(event) => setDiscoveryQuery(event.target.value)}
              placeholder={t("models.discoveryFilterPlaceholder", { count: discoveryState.models.length })}
              aria-label={t("models.discoveryFilter")}
              style={{ ...inputStyle, width: "100%", minWidth: 0 }}
            />

            <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)" }}>
              <label
                style={{
                  minHeight: 32, padding: "5px 9px", display: "flex", alignItems: "center", gap: 8,
                  position: "sticky", top: 0, zIndex: 1, borderBottom: "1px solid var(--border)",
                  background: "var(--bg)", cursor: selectableShownIds.length ? "pointer" : "default",
                  color: "var(--text-muted)", fontSize: 10, fontWeight: 600,
                }}
              >
                <input
                  ref={selectShownRef}
                  type="checkbox"
                  checked={allShownSelected}
                  disabled={selectableShownIds.length === 0}
                  onChange={toggleShownModels}
                  style={{ width: 13, height: 13, accentColor: "var(--accent)", flexShrink: 0 }}
                />
                {t("models.discoverySelectShown")}
              </label>
              {shownDiscoveredModels.length === 0 ? (
                <div style={{ padding: 12, color: "var(--text-dim)", fontSize: 11 }}>{t("models.discoveryNoMatches")}</div>
              ) : shownDiscoveredModels.map((model, index) => {
                const alreadyAdded = existingModelIds.has(model.id);
                const checked = selectedModelIds.includes(model.id);
                return (
                  <label
                    key={model.id}
                    style={{
                      minHeight: 36, padding: "6px 9px", display: "flex", alignItems: "center", gap: 8,
                      borderTop: index === 0 ? "none" : "1px solid var(--border)", cursor: alreadyAdded ? "default" : "pointer",
                      opacity: alreadyAdded ? 0.65 : 1,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked || alreadyAdded}
                      disabled={alreadyAdded}
                      onChange={() => toggleDiscoveredModel(model.id)}
                      style={{ width: 13, height: 13, accentColor: "var(--accent)", flexShrink: 0 }}
                    />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)", fontSize: 11 }}>{model.name ?? model.id}</span>
                      {model.name && <code style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: 10, fontFamily: "var(--font-mono)" }}>{model.id}</code>}
                    </span>
                    {alreadyAdded && <span style={{ color: "var(--text-dim)", fontSize: 10 }}>{t("models.discoveryAdded")}</span>}
                  </label>
                );
              })}
            </div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <span title={discoveryState.endpoint} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: 10 }}>
                {filteredDiscoveredModels.length > shownDiscoveredModels.length
                  ? t("models.discoveryShowing", { shown: shownDiscoveredModels.length, total: filteredDiscoveredModels.length })
                  : t("models.discoveryFetched", { count: discoveryState.models.length })}
              </span>
              <button
                onClick={addSelectedModels}
                disabled={selectedCount === 0}
                style={{ height: 28, padding: "0 11px", border: "none", borderRadius: 5, background: selectedCount ? "var(--accent)" : "var(--bg-panel)", color: selectedCount ? "var(--accent-contrast)" : "var(--text-dim)", cursor: selectedCount ? "pointer" : "not-allowed", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}
              >
                {selectedCount
                  ? t("models.discoveryAddSelectedCount", { count: selectedCount })
                  : t("models.discoveryAddSelected")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── ThinkingLevelMap editor ───────────────────────────────────────────────────

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = typeof THINKING_LEVELS[number];

const LEVEL_COLORS: Record<ThinkingLevel, string> = {
  off:     "var(--text-dim)",
  minimal: "#6b7280",
  low:     "#60a5fa",
  medium:  "#a78bfa",
  high:    "#f472b6",
  xhigh:   "#fb923c",
  max:     "#ef4444",
};

function ThinkingLevelMapEditor({
  value,
  onChange,
}: {
  value: Record<string, string | null> | undefined;
  onChange: (v: Record<string, string | null> | undefined) => void;
}) {
  const map = value ?? {};

  const setLevel = (level: ThinkingLevel, entry: string | null | "omit") => {
    const next = { ...map };
    if (entry === "omit") {
      delete next[level];
    } else {
      next[level] = entry;
    }
    onChange(Object.keys(next).length ? next : undefined);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {THINKING_LEVELS.map((level) => {
        const raw = map[level];
        const state: "omit" | "null" | "string" =
          !(level in map) ? "omit" : raw === null ? "null" : "string";
        const strVal = typeof raw === "string" ? raw : "";
        const color = LEVEL_COLORS[level];

        const btnBase: React.CSSProperties = {
          padding: "4px 10px",
          fontSize: 10,
          border: "none",
          cursor: "pointer",
          fontWeight: 400,
          transition: "background 0.1s, color 0.1s",
          whiteSpace: "nowrap",
          background: "var(--bg-panel)",
          color: "var(--text-dim)",
        };
        const btnActive: React.CSSProperties = {
          background: "var(--accent)",
          color: "var(--accent-contrast)",
          fontWeight: 600,
        };
        const btnActiveDisabled: React.CSSProperties = {
          background: "#ef4444",
          color: "#fff",
          fontWeight: 600,
        };

        return (
          <div
            key={level}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "5px 4px",
              borderRadius: 6,
              background: "transparent",
              border: "1px solid transparent",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 5, width: 68, flexShrink: 0 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0, opacity: state === "null" ? 0.3 : 1 }} />
              <span style={{
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                color: state === "null" ? "var(--text-dim)" : "var(--text-muted)",
                textDecoration: state === "null" ? "line-through" : "none",
              }}>
                {level}
              </span>
            </div>

            <div style={{ display: "flex", borderRadius: 5, border: "1px solid var(--border)", overflow: "hidden", flexShrink: 0 }}>
              <button
                onClick={() => setLevel(level, "omit")}
                style={{ ...btnBase, ...(state === "omit" ? btnActive : {}) }}
              >
                Default
              </button>
              <button
                onClick={() => setLevel(level, null)}
                style={{ ...btnBase, borderLeft: "1px solid var(--border)", ...(state === "null" ? btnActiveDisabled : {}) }}
              >
                Disabled
              </button>
            </div>

            <div style={{ display: "flex", borderRadius: 5, border: `1px solid ${state === "string" ? "var(--accent)" : "var(--border)"}`, overflow: "hidden", transition: "border-color 0.1s" }}>
              <button
                onClick={() => setLevel(level, strVal || level)}
                style={{ ...btnBase, ...(state === "string" ? btnActive : {}), borderRight: "1px solid var(--border)", flexShrink: 0 }}
              >
                Custom
              </button>
              <input
                value={strVal}
                onChange={(e) => setLevel(level, e.target.value)}
                onFocus={() => { if (state !== "string") setLevel(level, strVal || level); }}
                placeholder={level}
                maxLength={10}
                style={{
                  width: "12ch",
                  background: state === "string" ? "var(--bg)" : "var(--bg-panel)",
                  border: "none",
                  outline: "none",
                  color: state === "string" ? "var(--text)" : "var(--text-dim)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  padding: "4px 7px",
                  transition: "background 0.1s, color 0.1s",
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Model detail ──────────────────────────────────────────────────────────────

const DEEPSEEK_COMPAT = {
  thinkingFormat: "deepseek",
  requiresReasoningContentOnAssistantMessages: true,
} as const;

function hasDeepseekCompat(model: ModelEntry): boolean {
  return model.compat?.thinkingFormat === "deepseek";
}

function setDeepseekCompat(model: ModelEntry, enabled: boolean): ModelEntry {
  if (enabled) {
    return { ...model, compat: { ...(model.compat ?? {}), ...DEEPSEEK_COMPAT } };
  }
  if (!model.compat) return model;
  const rest = { ...model.compat };
  delete rest.thinkingFormat;
  delete rest.requiresReasoningContentOnAssistantMessages;
  return { ...model, compat: Object.keys(rest).length ? rest : undefined };
}

// Compat can be configured at the provider or model level; provider-composer
// merges them (model wins) at runtime. The UI reads the effective value so
// hand-edited models.json settings are reflected correctly, while toggles
// write to the model entry so a per-model override is explicit.
function effectiveCompat(provider: ProviderEntry, model: ModelEntry): Record<string, unknown> {
  return { ...(provider.compat ?? {}), ...(model.compat ?? {}) };
}

// Editable key/value request-header list for a provider or model. Rows stay
// local so a blank draft is never persisted as an invalid HTTP header name.
function HeaderListEditor({ headers, onChange }: {
  headers: Record<string, string> | undefined;
  onChange: (h: Record<string, string> | undefined) => void;
}) {
  const [rows, setRows] = useState<HeaderRow[]>(() => Object.entries(headers ?? {}).map(
    ([name, value], id) => ({ id, name, value }),
  ));
  const nextRowIdRef = useRef(rows.length);

  const applyRows = (next: HeaderRow[]): void => {
    setRows(next);
    onChange(serializeHeaderRows(next));
  };
  const setEntry = (id: number, changes: Partial<Pick<HeaderRow, "name" | "value">>): void => {
    applyRows(updateHeaderRow(rows, id, changes));
  };
  const removeEntry = (id: number): void => {
    applyRows(rows.filter((row) => row.id !== id));
  };
  const rowBtnStyle = {
    padding: "6px 9px",
    background: "none",
    border: "1px solid rgba(239,68,68,0.3)",
    borderRadius: 4,
    color: "#ef4444",
    cursor: "pointer",
    fontSize: 11,
    lineHeight: 1,
  } satisfies React.CSSProperties;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {rows.map((row) => (
        <div key={row.id} style={{ display: "flex", gap: 6 }}>
          <input value={row.name} onChange={(e) => setEntry(row.id, { name: e.target.value })}
            placeholder="Header-Name" style={{ ...inputStyle, fontFamily: "var(--font-mono)", flex: 1 }} />
          <input value={row.value} onChange={(e) => setEntry(row.id, { value: e.target.value })}
            placeholder="value" style={{ ...inputStyle, fontFamily: "var(--font-mono)", flex: 1 }} />
          <button onClick={() => removeEntry(row.id)} style={rowBtnStyle}>✕</button>
        </div>
      ))}
      <button onClick={() => setRows((current) => [
        ...current,
        { id: nextRowIdRef.current++, name: "", value: "" },
      ])}
        style={{ padding: "5px 9px", background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-muted)", cursor: "pointer", fontSize: 11, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5, alignSelf: "flex-start" }}>
        + Add header
      </button>
    </div>
  );
}

function fillEmptyModelFields(
  model: ModelEntry,
  preset: ModelCatalogPreset,
): { model: ModelEntry; appliedCount: number } {
  const next = { ...model };
  let appliedCount = 0;
  if (!model.name?.trim() && preset.name) {
    next.name = preset.name;
    appliedCount += 1;
  }
  if (model.reasoning === undefined && preset.reasoning === true) {
    next.reasoning = true;
    appliedCount += 1;
  }
  if (!model.input?.length && preset.input?.length) {
    next.input = [...preset.input];
    appliedCount += 1;
  }
  if (model.contextWindow === undefined && preset.contextWindow !== undefined) {
    next.contextWindow = preset.contextWindow;
    appliedCount += 1;
  }
  if (model.maxTokens === undefined && preset.maxTokens !== undefined) {
    next.maxTokens = preset.maxTokens;
    appliedCount += 1;
  }

  if (preset.cost) {
    const cost = { ...(model.cost ?? {}) };
    let filledCostCount = 0;
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      if (cost[key] === undefined && preset.cost[key] !== undefined) {
        cost[key] = preset.cost[key];
        filledCostCount += 1;
      }
    }
    const completeCost = parseCompleteModelCost(modelCostToDraft(cost));
    if (filledCostCount > 0 && completeCost) {
      next.cost = { ...cost, ...completeCost };
      appliedCount += filledCostCount;
    }
  }
  return { model: next, appliedCount };
}

function ModelDetail({
  providerName,
  provider,
  model,
  onChange,
  onDelete,
  relayMode = false,
  relayFirstTierContextWindow,
}: {
  providerName: string;
  provider: ProviderEntry;
  model: ModelEntry;
  onChange: (m: ModelEntry) => void;
  onDelete: () => void;
  /** Relay metadata controls prices and request transport in product mode. */
  relayMode?: boolean;
  /** Exact max_tokens returned for this group/model by the authenticated model plaza. */
  relayFirstTierContextWindow?: number;
}) {
  const [testState, setTestState] = useState<ModelTestState>({ phase: "idle" });
  const { t } = useI18n();
  const [catalogState, setCatalogState] = useState<ModelCatalogState>({ phase: "idle" });
  const [costEditing, setCostEditing] = useState(false);
  const [costDraft, setCostDraft] = useState<ModelCostDraft>(() => modelCostToDraft(model.cost));
  const costDraftRef = useRef(costDraft);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const catalogRequestIdRef = useRef(0);
  const catalogUndoRef = useRef<ModelEntry | null>(null);
  const costTemplateRef = useRef(model.cost);
  const set = <K extends keyof ModelEntry>(k: K, v: ModelEntry[K]) => onChange({ ...model, [k]: v });
  const effectiveApi = model.api ?? provider.api ?? "openai-completions";
  const relayOpenAiProtocolSwitch = relayMode
    && RELAY_OPENAI_MODEL_ID.test(model.id.trim())
    && (effectiveApi === "openai-responses" || effectiveApi === "openai-completions");
  const setRelayOpenAiProtocol = (api: "openai-responses" | "openai-completions") => {
    const compat = { ...(model.compat ?? {}) };
    if (api === "openai-completions") {
      compat.sendSessionAffinityHeaders = true;
      compat.sessionAffinityFormat = "openai";
    } else {
      delete compat.sendSessionAffinityHeaders;
      delete compat.sessionAffinityFormat;
    }
    onChange({
      ...model,
      api,
      compat: Object.keys(compat).length ? compat : undefined,
    });
  };
  const setCost = (key: ModelCostKey, value: string) => {
    const nextDraft = { ...costDraftRef.current, [key]: value };
    const completeCost = parseCompleteModelCost(nextDraft);
    const nextModel = { ...model };
    costDraftRef.current = nextDraft;
    setCostDraft(nextDraft);
    if (completeCost) {
      nextModel.cost = { ...(costTemplateRef.current ?? {}), ...completeCost };
      costTemplateRef.current = nextModel.cost;
    } else {
      delete nextModel.cost;
    }
    onChange(nextModel);
  };
  const toggleCostEditing = () => {
    if (costEditing) {
      setCostEditing(false);
      return;
    }
    costTemplateRef.current = model.cost;
    const nextDraft = modelCostToDraft(model.cost);
    costDraftRef.current = nextDraft;
    setCostDraft(nextDraft);
    setCostEditing(true);
  };
  const testSummary = (() => {
    if (testState.phase === "idle") return null;
     if (testState.phase === "testing") return t("i18n.testingModel");
    const meta = [
      testState.latencyMs !== undefined ? `${testState.latencyMs}ms` : null,
      testState.status !== undefined ? `HTTP ${testState.status}` : null,
    ].filter(Boolean);
    if (testState.phase === "success") {
       return [t("i18n.connected"), ...meta, testState.responseText || null].filter(Boolean).join(" · ");
    }
     return [t("i18n.failed"), ...meta, testState.message].filter(Boolean).join(" · ");
  })();

  useEffect(() => {
    setTestState({ phase: "idle" });
  }, [providerName, provider.baseUrl, provider.api, provider.apiKey, model.id, model.api]);

  useEffect(() => {
    catalogRequestIdRef.current += 1;
    setCatalogState({ phase: "idle" });
    catalogUndoRef.current = null;
  }, [providerName, provider.baseUrl, model.id]);

  const handleTest = useCallback(async () => {
    if (!model.id.trim() || testState.phase === "testing") return;
    setTestState({ phase: "testing" });
    try {
      const res = await fetch("/api/models-config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerName, provider, model }),
      });
      const d = await res.json() as {
        ok?: boolean;
        error?: string;
        latencyMs?: number;
        status?: number;
        responseText?: string;
      };
      if (!res.ok || !d.ok) {
        setTestState({
          phase: "error",
          message: d.error ?? `HTTP ${res.status}`,
          latencyMs: d.latencyMs,
          status: d.status,
        });
        return;
      }
      setTestState({
        phase: "success",
        latencyMs: d.latencyMs,
        status: d.status,
        responseText: d.responseText,
      });
    } catch (e) {
      setTestState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [model, provider, providerName, testState.phase]);

  const handleCatalogFill = useCallback(async () => {
    const query = model.id.trim();
    if (!query || catalogState.phase === "loading") return;
    const requestId = ++catalogRequestIdRef.current;
    setCatalogState({ phase: "loading" });
    try {
      const params = new URLSearchParams({ q: query, provider: providerName, limit: "50" });
      if (provider.baseUrl?.trim()) params.set("baseUrl", provider.baseUrl.trim());
      const res = await fetch(`/api/models-config/catalog?${params}`);
      const data = await res.json() as { recommendation?: ModelCatalogRecommendation; error?: string };
      if (requestId !== catalogRequestIdRef.current) return;
      if (!res.ok || data.error || !data.recommendation) {
        setCatalogState({ phase: "error", message: data.error ?? `HTTP ${res.status}` });
        return;
      }
      const filled = fillEmptyModelFields(model, data.recommendation.preset);
      if (filled.appliedCount > 0) {
        catalogUndoRef.current = model;
        onChange(filled.model);
      }
      setCostEditing(false);
      setCatalogState({
        phase: "success",
        recommendation: data.recommendation,
        appliedCount: filled.appliedCount,
      });
    } catch (error) {
      if (requestId !== catalogRequestIdRef.current) return;
      setCatalogState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [catalogState.phase, model, onChange, provider.baseUrl, providerName]);

  const undoCatalogFill = () => {
    const previous = catalogUndoRef.current;
    if (!previous) return;
    catalogUndoRef.current = null;
    onChange(previous);
    setCatalogState({ phase: "idle" });
  };

  const catalogResultSummary = (() => {
    if (catalogState.phase !== "success") return null;
    const { recommendation, appliedCount } = catalogState;
    const applied = appliedCount > 0
      ? t("models.catalogFilled", { count: appliedCount })
      : t("models.catalogNoEmptyFields");
    if (recommendation.price.status === "unreliable") {
      const price = recommendation.price.reason === "no-exact-match"
        ? t("models.catalogNoExactMatch")
        : t("models.catalogPriceUnreliable");
      return `${applied} · ${price}`;
    }
    const price = recommendation.price.method === "provider"
      ? t("models.catalogPriceProvider", { provider: recommendation.price.providerName ?? recommendation.price.providerId ?? providerName })
      : recommendation.price.method === "base-url"
        ? t("models.catalogPriceBaseUrl", { provider: recommendation.price.providerName ?? recommendation.price.providerId ?? providerName })
        : t("models.catalogPriceConsensus", {
            support: recommendation.price.support,
            total: recommendation.price.total,
          });
    return `${applied} · ${price}`;
  })();
  const catalogStatusText = catalogState.phase === "error"
    ? catalogState.message
    : catalogResultSummary;
  const catalogStatusColor = catalogState.phase === "error"
    ? "#ef4444"
    : catalogState.phase === "success" && catalogState.recommendation.price.status === "unreliable"
      ? "#d97706"
      : "var(--text-dim)";
  const costFields = [
    { key: "input", label: t("models.costInput") },
    { key: "output", label: t("models.costOutput") },
    { key: "cacheRead", label: t("models.costCacheRead") },
    { key: "cacheWrite", label: t("models.costCacheWrite") },
  ] as const;
  const formatCost = (key: ModelCostKey): string => {
    const value = model.cost?.[key];
    return value === undefined ? t("models.notProvided") : `$${String(value)}`;
  };
  const remainingCompatKeys = new Set(Object.keys(model.compat ?? {}));
  let compatibilityOverrideCount = 0;
  if (hasDeepseekCompat(model)) {
    compatibilityOverrideCount += 1;
    remainingCompatKeys.delete("thinkingFormat");
    remainingCompatKeys.delete("requiresReasoningContentOnAssistantMessages");
  }
  if (Object.prototype.hasOwnProperty.call(model.compat ?? {}, "supportsDeveloperRole")) {
    compatibilityOverrideCount += 1;
    remainingCompatKeys.delete("supportsDeveloperRole");
  }
  compatibilityOverrideCount += remainingCompatKeys.size;
  const advancedSummaryParts = [
    model.api ? `API: ${model.api}` : null,
    Object.keys(model.headers ?? {}).length
      ? t("models.headersSummary", { count: Object.keys(model.headers ?? {}).length })
      : null,
    compatibilityOverrideCount
      ? t("models.compatSummary", { count: compatibilityOverrideCount })
      : null,
    Object.keys(model.thinkingLevelMap ?? {}).length
      ? t("models.thinkingSummary", { count: Object.keys(model.thinkingLevelMap ?? {}).length })
      : null,
  ].filter((part): part is string => Boolean(part));
  const advancedSummary = advancedSummaryParts.length
    ? advancedSummaryParts.join(" · ")
    : t("models.providerDefaults");
  const relayContextLimit = relayMode ? relayContextWindowLimit(model.id, relayFirstTierContextWindow) : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <ConfigDetailHeader>
        <ConfigDetailHeaderInfo>
          <SectionTitle>{t("i18n.model")}</SectionTitle>
        </ConfigDetailHeaderInfo>
        <ConfigDetailActions>
          {!relayMode && testSummary && (
            <span
              title={testSummary}
              style={{
                maxWidth: 260,
                height: 28,
                padding: "0 8px",
                border: `1px solid ${testState.phase === "error" ? "#fecaca" : testState.phase === "success" ? "#bbf7d0" : "var(--border)"}`,
                borderRadius: 4,
                background: testState.phase === "error" ? "#fee2e2" : testState.phase === "success" ? "#dcfce7" : "#e5e7eb",
                color: "#111827",
                fontSize: 11,
                display: "inline-flex",
                alignItems: "center",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                boxSizing: "border-box",
              }}
            >
              {testSummary}
            </span>
          )}
          {!relayMode && <ConfigButton
            size="small"
            variant={testState.phase === "success" ? "primary" : "secondary"}
            onClick={testState.phase === "success" ? () => setTestState({ phase: "idle" }) : handleTest}
            disabled={!model.id.trim() || testState.phase === "testing"}
            title={t("i18n.testConnection")}
            className={testState.phase === "success" ? "is-success" : undefined}
          >
            {testState.phase === "success" && (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
             {testState.phase === "testing" ? t("i18n.checking") : testState.phase === "success" ? t("common.ok") : t("i18n.test")}
          </ConfigButton>}
          <ConfigButton variant="danger" size="small" onClick={onDelete}>
            {relayMode ? "移出列表" : t("i18n.remove")}
          </ConfigButton>
        </ConfigDetailActions>
      </ConfigDetailHeader>

      {relayMode ? (
        <div className="relay-model-identity">
          <span>{model.name || model.id}</span>
          <code>{model.id}</code>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="ID *"><TextInput value={model.id} onChange={(v) => set("id", v)} placeholder="model-id" mono /></Field>
          <Field label="Name"><TextInput value={model.name ?? ""} onChange={(v) => set("name", v || undefined)} placeholder="Display name" /></Field>
        </div>
      )}

      {relayOpenAiProtocolSwitch && (
        <section className="relay-protocol-mode" aria-labelledby="relay-protocol-mode-title">
          <div>
            <div id="relay-protocol-mode-title" className="relay-protocol-mode-title">连接模式</div>
            <div className="relay-protocol-mode-help">Responses 异常时，可切换到兼容模式继续使用这个模型。</div>
          </div>
          <div className="relay-protocol-mode-options" role="radiogroup" aria-label="连接模式">
            <button
              type="button"
              role="radio"
              aria-checked={effectiveApi === "openai-responses"}
              className={effectiveApi === "openai-responses" ? "is-active" : undefined}
              onClick={() => setRelayOpenAiProtocol("openai-responses")}
            >
              <strong>增强模式</strong>
              <span>Responses · 推荐，工具和文件能力更完整</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={effectiveApi === "openai-completions"}
              className={effectiveApi === "openai-completions" ? "is-active" : undefined}
              onClick={() => setRelayOpenAiProtocol("openai-completions")}
            >
              <strong>兼容模式</strong>
              <span>Chat Completions · 增强模式报错时使用</span>
            </button>
          </div>
          <div className="relay-protocol-mode-note">
            切换后请点击右下角“保存”，再重新加载当前会话。兼容模式下，部分文件上传和工具调用可能不可用。
          </div>
        </section>
      )}

      {!relayMode && <div style={{ padding: "2px 0" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={() => void handleCatalogFill()}
            disabled={!model.id.trim() || catalogState.phase === "loading"}
            style={{
              height: 28, padding: "0 10px", border: "1px solid var(--border)", borderRadius: 5,
              background: "var(--bg-panel)",
              color: !model.id.trim() || catalogState.phase === "loading" ? "var(--text-dim)" : "var(--text-muted)",
              cursor: !model.id.trim() || catalogState.phase === "loading" ? "not-allowed" : "pointer",
              fontSize: 11,
            }}
          >
            {catalogState.phase === "loading" ? t("models.catalogFilling") : t("models.catalogFill")}
          </button>
          <a
            href="https://github.com/anomalyco/models.dev"
            target="_blank"
            rel="noreferrer"
            style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10, textDecoration: "none" }}
          >
            {t("models.catalogSource")}
          </a>
        </div>

        {catalogStatusText && (
          <div
            aria-live="polite"
            style={{
              marginTop: 8, display: "flex", alignItems: "center",
              justifyContent: "space-between", gap: 8, color: catalogStatusColor, fontSize: 10,
            }}
          >
            <span
              title={catalogStatusText}
              style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {catalogStatusText}
            </span>
            {catalogUndoRef.current && (
              <button
                onClick={undoCatalogFill}
                style={{ flexShrink: 0, padding: "0 2px", border: "none", background: "none", color: "var(--accent)", cursor: "pointer", fontSize: 10 }}
              >
                {t("models.catalogUndo")}
              </button>
            )}
          </div>
        )}
      </div>}

      <div>
        <SectionTitle>{t("models.capabilities")}</SectionTitle>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginTop: 8 }}>
          <Check label={t("models.reasoning")} checked={model.reasoning ?? false} onChange={(v) => set("reasoning", v)} />
          <Check label={t("models.imageInput")} checked={model.input?.includes("image") ?? false}
            onChange={(v) => set("input", v ? ["text", "image"] : ["text"])} />
        </div>
      </div>

      <section>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <SectionTitle>{t("models.modelSpecs")}</SectionTitle>
          {!relayMode && <button
            type="button"
            onClick={toggleCostEditing}
            aria-expanded={costEditing}
            style={{ padding: "2px 4px", border: "none", background: "transparent", color: "var(--accent)", cursor: "pointer", fontSize: 10 }}
          >
            {costEditing ? t("models.finishEditingCosts") : t("models.editCosts")}
          </button>}
        </div>

        <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
          <Field label={relayMode ? "上下文窗口（首阶计费范围）" : t("models.contextWindow")}>
            {relayMode ? (
              <div style={{ ...inputStyle, display: "flex", alignItems: "center", background: "var(--bg-subtle)", color: "var(--text)" }}>
                {(model.contextWindow ?? relayContextLimit ?? 128_000).toLocaleString()} tokens
              </div>
            ) : (
              <NumInput
                value={model.contextWindow !== undefined ? String(model.contextWindow) : ""}
                onChange={(v) => set("contextWindow", v ? parseInt(v) : undefined)}
                placeholder="128000"
              />
            )}
            {relayMode && relayContextLimit && (
              <span style={{ marginTop: 3, color: "var(--text-dim)", fontSize: 10 }}>
                {relayFirstTierContextWindow
                  ? `已从流星 API 同步：首档上限 ${relayContextLimit.toLocaleString()} tokens；Magent 会提前预留输出空间并自动压缩。`
                  : `模型广场暂未返回该分组模型，当前使用 ${relayContextLimit.toLocaleString()} tokens 的保守上限。`}
              </span>
            )}
          </Field>
          <Field label={t("models.maxOutputTokens")}>
            <NumInput value={model.maxTokens !== undefined ? String(model.maxTokens) : ""}
              onChange={(v) => set("maxTokens", v ? parseInt(v) : undefined)} placeholder="16384" />
          </Field>
        </div>

        <div style={{ marginTop: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, fontSize: 10, color: "var(--text-dim)", fontWeight: 600, textTransform: "uppercase" }}>
            <span>{t("models.costPerMillion")}</span>
            {relayMode && <span style={{ fontWeight: 400, textTransform: "none" }}>只读参考价，实际扣费以流星 API 账单为准</span>}
          </div>
          {costEditing && !relayMode ? (
            <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 8 }}>
              {costFields.map(({ key, label }) => (
                <Field key={key} label={label}>
                  <NumInput value={costDraft[key]} onChange={(v) => setCost(key, v)} placeholder="0" />
                </Field>
              ))}
              {hasModelCostDraftValue(costDraft) && !parseCompleteModelCost(costDraft) && (
                <div aria-live="polite" style={{ gridColumn: "1 / -1", color: "#d97706", fontSize: 10 }}>
                  {t("models.costAllRequired")}
                </div>
              )}
            </div>
          ) : (
            <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(105px, 1fr))", gap: "8px 16px" }}>
              {costFields.map(({ key, label }) => {
                const missing = model.cost?.[key] === undefined;
                return (
                  <div key={key} style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
                    <div style={{ marginTop: 3, color: missing ? "var(--text-dim)" : "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
                      {formatCost(key)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {!relayMode && <section style={{ borderTop: "1px solid var(--border)", paddingTop: 4 }}>
        <button
          type="button"
          onClick={() => setAdvancedOpen((open) => !open)}
          aria-expanded={advancedOpen}
          aria-controls="model-advanced-settings"
          style={{
            width: "100%", minHeight: 48, padding: "8px 0", border: "none", background: "transparent",
            display: "grid", gridTemplateColumns: "minmax(0, 1fr) 18px", alignItems: "center", gap: 10,
            color: "var(--text)", cursor: "pointer", textAlign: "left",
          }}
        >
          <span style={{ minWidth: 0 }}>
            <span style={{ display: "block", fontSize: 11, fontWeight: 600 }}>{t("models.advancedSettings")}</span>
            <span style={{ display: "block", marginTop: 3, color: "var(--text-dim)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {advancedSummary}
            </span>
          </span>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ color: "var(--text-dim)", transform: advancedOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s ease" }}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {advancedOpen && (
          <div id="model-advanced-settings" style={{ display: "flex", flexDirection: "column", gap: 14, padding: "4px 0 16px" }}>
            <Field label={t("models.apiOverride")}>
              <Select value={model.api ?? ""} onChange={(v) => set("api", v || undefined)} options={API_OPTIONS} />
            </Field>

            <Field label={t("models.headers")}>
              <HeaderListEditor
                headers={model.headers}
                onChange={(headers) => set("headers", headers)}
              />
              <span style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
                {t("models.headersHelp")}
              </span>
            </Field>

            {model.reasoning && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <SectionTitle>{t("models.compatibility")}</SectionTitle>
                <Check
                  label={t("models.deepSeekThinkingCompat")}
                  checked={hasDeepseekCompat(model)}
                  onChange={(v) => onChange(setDeepseekCompat(model, v))}
                />
                <Check
                  label={t("models.developerRole")}
                  checked={effectiveCompat(provider, model)["supportsDeveloperRole"] !== false}
                  onChange={(v) => onChange(setCompatBool(model, "supportsDeveloperRole", v))}
                />
                <div style={{ marginTop: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
                    <SectionTitle>{t("models.thinkingLevelMap")}</SectionTitle>
                    {model.thinkingLevelMap && (
                      <button
                        type="button"
                        onClick={() => set("thinkingLevelMap", undefined)}
                        style={{ fontSize: 10, padding: "2px 5px", background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer" }}
                      >
                        {t("models.clearAll")}
                      </button>
                    )}
                  </div>
                  <ThinkingLevelMapEditor
                    value={model.thinkingLevelMap}
                    onChange={(v) => set("thinkingLevelMap", v)}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </section>}
    </div>
  );
}

// ── OAuth detail ──────────────────────────────────────────────────────────────

function OAuthDetail({ provider, onRefresh }: { provider: OAuthProvider; onRefresh: () => void }) {
  const [loginState, setLoginState] = useState<OAuthLoginState>({ phase: "idle" });
  const { t } = useI18n();
  const [inputValue, setInputValue] = useState("");
  const eventSourceRef = useRef<EventSource | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (loginState.phase === "auth" || loginState.phase === "prompt") {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [loginState.phase]);

  // Reset state when provider changes
  useEffect(() => {
    setLoginState({ phase: "idle" });
    setInputValue("");
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, [provider.id]);

  useEffect(() => {
    return () => { eventSourceRef.current?.close(); };
  }, []);

  const handleLogin = useCallback(() => {
    eventSourceRef.current?.close();
    setLoginState({ phase: "connecting" });
    setInputValue("");

    const es = new EventSource(`/api/auth/login/${encodeURIComponent(provider.id)}`);
    eventSourceRef.current = es;

    es.onmessage = (e) => {
      const data = JSON.parse(e.data) as {
        type: string; url?: string; instructions?: string | null;
        token?: string; message?: string; placeholder?: string | null;
        userCode?: string; verificationUri?: string; intervalSeconds?: number | null; expiresInSeconds?: number | null;
        options?: { id: string; label: string }[];
      };
      if (data.type === "auth") {
        setLoginState({ phase: "auth", url: data.url!, instructions: data.instructions ?? null, token: data.token! });
        window.open(data.url!, "_blank", "noopener,noreferrer");
      } else if (data.type === "device_code") {
        setLoginState({
          phase: "device_code",
          userCode: data.userCode!,
          verificationUri: data.verificationUri!,
          intervalSeconds: data.intervalSeconds ?? null,
          expiresInSeconds: data.expiresInSeconds ?? null,
        });
        window.open(data.verificationUri!, "_blank", "noopener,noreferrer");
      } else if (data.type === "prompt_request") {
        setLoginState({ phase: "prompt", message: data.message!, placeholder: data.placeholder ?? null, token: data.token! });
      } else if (data.type === "select_request") {
        setLoginState({ phase: "select", message: data.message!, options: data.options ?? [], token: data.token! });
      } else if (data.type === "progress") {
        setLoginState({ phase: "progress", message: data.message! });
      } else if (data.type === "success") {
        es.close();
        setLoginState({ phase: "success" });
        onRefresh();
      } else if (data.type === "error") {
        es.close();
        setLoginState({ phase: "error", message: data.message! });
      } else if (data.type === "cancelled") {
        es.close();
        setLoginState({ phase: "idle" });
      }
    };
    es.onerror = () => {
      es.close();
      setLoginState((prev) => prev.phase === "success" ? prev : { phase: "error", message: "Connection lost" });
    };
  }, [provider.id, onRefresh]);

  const handleLogout = useCallback(async () => {
    await fetch(`/api/auth/logout/${encodeURIComponent(provider.id)}`, { method: "POST" });
    setLoginState({ phase: "idle" });
    onRefresh();
  }, [provider.id, onRefresh]);

  const submitCode = useCallback(async (token: string, code: string) => {
    if (!code.trim()) return;
    setLoginState({ phase: "progress", message: "Verifying…" });
    try {
      const res = await fetch(`/api/auth/login/${encodeURIComponent(provider.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, code: code.trim() }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        setLoginState({ phase: "error", message: d.error ?? `Server error ${res.status}` });
        return;
      }
      setInputValue("");
      // Success path: SSE stream will emit "success" and update state
    } catch (e) {
      setLoginState({ phase: "error", message: e instanceof Error ? e.message : "Network error" });
    }
  }, [provider.id]);

  const submitSelection = useCallback(async (token: string, value: string) => {
    setLoginState({ phase: "progress", message: "Continuing…" });
    try {
      const res = await fetch(`/api/auth/login/${encodeURIComponent(provider.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, code: value }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        setLoginState({ phase: "error", message: d.error ?? `Server error ${res.status}` });
      }
    } catch (e) {
      setLoginState({ phase: "error", message: e instanceof Error ? e.message : "Network error" });
    }
  }, [provider.id]);

  const isWorking = loginState.phase === "connecting" || loginState.phase === "progress" ||
    loginState.phase === "auth" || loginState.phase === "device_code" ||
    loginState.phase === "prompt" || loginState.phase === "select";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: provider.loggedIn && loginState.phase === "idle" ? 0 : 16 }}>
      <ConfigDetailHeader>
        <ConfigDetailHeaderInfo>
          <SectionTitle>{t("i18n.subscription")}</SectionTitle>
        </ConfigDetailHeaderInfo>
        <ConfigDetailActions>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: provider.loggedIn ? "#4ade80" : "var(--border)", display: "inline-block" }} />
            <span style={{ fontSize: 11, color: provider.loggedIn ? "#4ade80" : "var(--text-dim)" }}>
               {provider.loggedIn ? t("i18n.connected") : t("i18n.notConnected")}
            </span>
          </div>
          {isWorking ? (
            <ConfigButton
              size="small"
              onClick={() => { eventSourceRef.current?.close(); setLoginState({ phase: "idle" }); }}
            >
              {t("i18n.cancel")}
            </ConfigButton>
          ) : (
            <>
              <ConfigButton
                variant="primary"
                size="small"
                onClick={handleLogin}
              >
                 {provider.loggedIn ? t("i18n.relogin") : t("i18n.login")}
              </ConfigButton>
              {provider.loggedIn && (
                <ConfigButton
                  variant="danger"
                  size="small"
                  onClick={handleLogout}
                >
                   {t("i18n.disconnect")}
                </ConfigButton>
              )}
            </>
          )}
        </ConfigDetailActions>
      </ConfigDetailHeader>

      {/* Status */}
      <div style={{ minHeight: provider.loggedIn && loginState.phase === "idle" ? 0 : 48 }}>
        {loginState.phase === "idle" && (
          !provider.loggedIn && (
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              Connect your {provider.name} account.
            </p>
          )
        )}
        {loginState.phase === "connecting" && (
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{t("i18n.openingBrowser")}</p>
        )}
        {loginState.phase === "select" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {loginState.message}
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {loginState.options.map((option) => (
                <button
                  key={option.id}
                  onClick={() => submitSelection(loginState.token, option.id)}
                  style={{ padding: "6px 9px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", cursor: "pointer", fontSize: 12, textAlign: "left" }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {(loginState.phase === "auth" || loginState.phase === "prompt") && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {loginState.phase === "auth"
                ? "Complete sign-in in the browser, then copy the redirect URL from the address bar and paste it below."
                : loginState.message}
            </p>
            {loginState.phase === "auth" && (
              <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
                If the browser window did not open,{" "}
                <a href={loginState.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", wordBreak: "break-all" }}>
                  click here to open the login page
                </a>
                .
              </p>
            )}
            <div style={{ display: "flex", gap: 6 }}>
              <input
                ref={inputRef}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submitCode(loginState.token, inputValue); }}
                placeholder={loginState.phase === "auth" ? "http://localhost:1455/auth/callback?code=…" : (loginState.placeholder ?? "Enter value…")}
                style={{ flex: 1, padding: "6px 9px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", fontSize: 12, outline: "none", fontFamily: "var(--font-mono)", boxSizing: "border-box" }}
              />
              <button
                onClick={() => submitCode(loginState.token, inputValue)}
                disabled={!inputValue.trim()}
                style={{ padding: "6px 12px", background: inputValue.trim() ? "var(--accent)" : "var(--bg-panel)", border: "none", borderRadius: 5, color: inputValue.trim() ? "var(--accent-contrast)" : "var(--text-dim)", cursor: inputValue.trim() ? "pointer" : "not-allowed", fontSize: 12, fontWeight: 600, flexShrink: 0 }}
              >
                 {t("i18n.submit")}
              </button>
            </div>
          </div>
        )}
        {loginState.phase === "device_code" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              Open the verification page and enter this code:
            </p>
            <div style={{ padding: "8px 10px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", fontSize: 16, fontWeight: 700, fontFamily: "var(--font-mono)", letterSpacing: 0 }}>
              {loginState.userCode}
            </div>
            <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
              <a href={loginState.verificationUri} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", wordBreak: "break-all" }}>
                {loginState.verificationUri}
              </a>
              {loginState.expiresInSeconds ? ` Expires in ${Math.ceil(loginState.expiresInSeconds / 60)} minutes.` : ""}
            </p>
          </div>
        )}
        {loginState.phase === "progress" && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{loginState.message}</p>
        )}
        {loginState.phase === "success" && (
             <p style={{ margin: 0, fontSize: 12, color: "#4ade80" }}>{t("i18n.connectedSuccessfully")}</p>
        )}
        {loginState.phase === "error" && (
          <p style={{ margin: 0, fontSize: 12, color: "#f87171" }}>{loginState.message}</p>
        )}
      </div>

      <ProviderUsageSummary providerId={provider.id} enabled={provider.loggedIn} />
      {isRelayProviderId(provider.id) && <RelayKeyRefresh providerId={provider.id} enabled={provider.loggedIn} />}
      {isRelayProviderId(provider.id) && <RelayUsageSummary providerId={provider.id} enabled={provider.loggedIn} />}
    </div>
  );
}

// ── API Key detail ────────────────────────────────────────────────────────────

function ApiKeyDetail({ provider, onRefresh }: { provider: ApiKeyProvider; onRefresh: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  const { t } = useI18n();

  // Reset state when provider changes
  useEffect(() => {
    setApiKey("");
    setError(null);
    setSavedOk(false);
  }, [provider.id]);

  const handleSave = useCallback(async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    setError(null);
    setSavedOk(false);
    try {
      const res = await fetch(`/api/auth/api-key/${encodeURIComponent(provider.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || d.error) {
        setError(d.error ?? `HTTP ${res.status}`);
      } else {
        setApiKey("");
        setSavedOk(true);
        setTimeout(() => setSavedOk(false), 2000);
        onRefresh();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [apiKey, provider.id, onRefresh]);

  const handleRemove = useCallback(async () => {
    setRemoving(true);
    setError(null);
    try {
      const res = await fetch(`/api/auth/api-key/${encodeURIComponent(provider.id)}`, { method: "DELETE" });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || d.error) setError(d.error ?? `HTTP ${res.status}`);
      else onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setRemoving(false);
    }
  }, [provider.id, onRefresh]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <ConfigDetailHeader>
        <ConfigDetailHeaderInfo>
          <SectionTitle>API Key</SectionTitle>
        </ConfigDetailHeaderInfo>
        <ConfigDetailActions>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: provider.configured ? "#4ade80" : "var(--border)", display: "inline-block" }} />
            <span style={{ fontSize: 11, color: provider.configured ? "#4ade80" : "var(--text-dim)" }}>
               {provider.configured ? t("i18n.configured") : t("i18n.notConfigured")}
            </span>
          </div>
          {provider.configured && (
            <ConfigButton
              variant="danger"
              size="small"
              onClick={handleRemove}
              disabled={removing}
            >
               {removing ? t("i18n.removing") : t("i18n.disconnect")}
            </ConfigButton>
          )}
        </ConfigDetailActions>
      </ConfigDetailHeader>

      {!provider.configured && (
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
          Enter your {provider.displayName} API key to enable {provider.modelCount} model{provider.modelCount !== 1 ? "s" : ""}.
        </p>
      )}

      <div style={{ display: "flex", gap: 6 }}>
        <SecretTextInput
          value={apiKey}
          onChange={setApiKey}
          onKeyDown={(e) => { if (e.key === "Enter" && apiKey.trim()) handleSave(); }}
          placeholder={provider.configured ? "Enter new key to replace…" : "sk-…"}
          style={{ flex: 1 }}
          autoComplete="off"
          spellCheck={false}
          mono
        />
        <button
          onClick={handleSave}
          disabled={saving || !apiKey.trim() || savedOk}
          style={{
            padding: "6px 12px",
            background: savedOk ? "#16a34a" : apiKey.trim() ? "var(--accent)" : "var(--bg-panel)",
            border: "none", borderRadius: 5,
            color: savedOk ? "#fff" : apiKey.trim() ? "var(--accent-contrast)" : "var(--text-dim)",
            cursor: (saving || !apiKey.trim() || savedOk) ? "not-allowed" : "pointer",
            fontSize: 12, fontWeight: 600, flexShrink: 0,
            display: "flex", alignItems: "center", gap: 5,
          }}
        >
          {savedOk && (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
           {savedOk ? t("i18n.saved") : saving ? t("i18n.saving") : t("i18n.save")}
        </button>
      </div>

      {error && <p style={{ margin: 0, fontSize: 12, color: "#f87171" }}>{error}</p>}

      <ProviderUsageSummary providerId={provider.id} enabled={provider.configured} />
      {isRelayProviderId(provider.id) && <RelayKeyRefresh providerId={provider.id} enabled={provider.configured} />}
      {isRelayProviderId(provider.id) && <RelayUsageSummary providerId={provider.id} enabled={provider.configured} />}
    </div>
  );
}

// ── Add provider picker ───────────────────────────────────────────────────────

interface AddProviderPickerProps {
  oauthProviders: OAuthProvider[];
  apiKeyProviders: ApiKeyProvider[];
  onSelectOAuth: (id: string) => void;
  onSelectApiKey: (id: string) => void;
  onAddCustom: () => void;
  onClose: () => void;
}

function AddProviderPicker({
  oauthProviders, apiKeyProviders,
  onSelectOAuth, onSelectApiKey, onAddCustom, onClose,
}: AddProviderPickerProps) {
  const [search, setSearch] = useState("");
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 30); }, []);

  const q = search.trim().toLowerCase();

  const availableOAuth = oauthProviders.filter((p) => !p.loggedIn && (!q || p.name.toLowerCase().includes(q)));
  const availableApiKey = apiKeyProviders.filter((p) => !p.configured && (!q || p.displayName.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)));
  const showCustom = !q || "custom".includes(q) || "openai-compatible".includes(q) || "anthropic-compatible".includes(q);

  const totalCount = availableOAuth.length + availableApiKey.length + (showCustom ? 1 : 0);

  const cardStyle: React.CSSProperties = {
    display: "flex", flexDirection: "row", alignItems: "center", gap: 8,
    padding: "10px 12px",
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: 7,
    boxSizing: "border-box",
    cursor: "pointer",
    minWidth: 0,
    textAlign: "left",
    transition: "border-color 0.12s, background 0.12s",
    width: "100%",
  };



  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <div style={{ width: 820, maxWidth: "calc(100vw - 32px)", maxHeight: "min(72vh, calc(100vh - 32px))", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, display: "flex", flexDirection: "column", boxShadow: "0 8px 32px rgba(0,0,0,0.22)", overflow: "hidden" }}>
        {/* Search */}
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0, display: "flex", alignItems: "center", gap: 8 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-dim)", flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
             placeholder={t("i18n.searchProviders")}
            style={{ flex: 1, background: "none", border: "none", outline: "none", color: "var(--text)", fontSize: 13, boxSizing: "border-box" }}
          />
        </div>

        {/* Card grid */}
        <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
          {totalCount === 0 ? (
            <div style={{ padding: "20px 0", fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>{t("i18n.noProviders")}</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(240px, 100%), 1fr))", gap: 8 }}>
              {showCustom && (
                 <div style={{ gridColumn: "1 / -1", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em" }}>{t("i18n.custom")}</div>
              )}
              {showCustom && (
                <button
                  onClick={() => { onAddCustom(); onClose(); }}
                  style={cardStyle}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg-panel)"; }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>OpenAI / Anthropic compatible</div>
                     <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>{t("i18n.customEndpoint")}</div>
                  </div>
                  <span style={{ width: 26, height: 26, borderRadius: 5, background: "var(--bg-hover)", border: "1px dashed var(--border)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-dim)" }}>
                      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </span>
                </button>
              )}

              {availableOAuth.length > 0 && (
                 <div style={{ gridColumn: "1 / -1", paddingTop: showCustom ? 6 : 0, fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em" }}>{t("i18n.subscriptions")}</div>
              )}
              {availableOAuth.map((p) => (
                <button key={p.id} onClick={() => { onSelectOAuth(p.id); onClose(); }}
                  style={cardStyle}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg-panel)"; }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>OAuth</div>
                  </div>
                  <ProviderIcon id={p.id} size={28} />
                </button>
              ))}

              {availableApiKey.length > 0 && (
                <div style={{ gridColumn: "1 / -1", paddingTop: availableOAuth.length > 0 ? 6 : 0, fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em" }}>API Key</div>
              )}
              {availableApiKey.map((p) => (
                <button key={p.id} onClick={() => { onSelectApiKey(p.id); onClose(); }}
                  style={cardStyle}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg-panel)"; }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.displayName}</div>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>{p.modelCount} models</div>
                  </div>
                  <ProviderIcon id={p.id} size={28} />
                </button>
              ))}

            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── MeteorAgent product-mode details ─────────────────────────────────────────

function RelayAccountDetail({ account, onAddAccount }: {
  account: RelayAccountSummary;
  onAddAccount: () => void;
}) {
  const [usage, setUsage] = useState<RelayAccountUsageResponse | null>(null);
  const [usageLoading, setUsageLoading] = useState(true);
  const loadUsage = useCallback(async (signal?: AbortSignal) => {
    setUsageLoading(true);
    try {
      const response = await fetch(`/api/relay-account-usage?accountId=${encodeURIComponent(account.accountId)}`, {
        cache: "no-store",
        signal,
      });
      const result = await response.json() as RelayAccountUsageResponse;
      setUsage(response.ok ? result : { status: "unavailable" });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setUsage({ status: "unavailable" });
    } finally {
      if (!signal?.aborted) setUsageLoading(false);
    }
  }, [account.accountId]);
  useEffect(() => {
    const controller = new AbortController();
    void loadUsage(controller.signal);
    const timer = window.setInterval(() => void loadUsage(controller.signal), 60_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [loadUsage]);
  const usageReady = usage?.status === "ready" && usage.usage;
  const balance = typeof account.balance === "number"
    ? `$${account.balance.toFixed(2)}`
    : typeof account.balance === "string" && account.balance.trim()
      ? account.balance
      : "暂不可用";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <ConfigDetailHeader>
        <ConfigDetailHeaderInfo>
          <SectionTitle>账户</SectionTitle>
          <div style={{ marginTop: 5, color: "var(--text)", fontSize: 16, fontWeight: 650 }}>
            {account.username?.trim() || account.email}
          </div>
          {account.username && <div style={{ marginTop: 3, color: "var(--text-dim)", fontSize: 11 }}>{account.email}</div>}
        </ConfigDetailHeaderInfo>
        <ConfigDetailActions>
          <a className="config-button config-button-primary config-button-small" href={RELAY_CONSOLE_URL} target="_blank" rel="noreferrer">
            充值
          </a>
          <ConfigButton size="small" onClick={onAddAccount}>登录其他账户</ConfigButton>
        </ConfigDetailActions>
      </ConfigDetailHeader>

      <section className="relay-account-summary">
        <div>
          <span>账户余额</span>
          <strong>{balance}</strong>
        </div>
        <div>
          <span>今日请求</span>
          <strong>{usageReady ? usage.usage!.todayRequests.toLocaleString("zh-CN") : usageLoading ? "读取中..." : "暂不可用"}</strong>
        </div>
        <div>
          <span>今日花费</span>
          <strong>{usageReady ? `$${usage.usage!.todayActualCost.toFixed(2)}` : usageLoading ? "读取中..." : "暂不可用"}</strong>
        </div>
      </section>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <p style={{ margin: 0, color: "var(--text-dim)", fontSize: 11, lineHeight: 1.6 }}>
          {usageReady
            ? `来自流星 API 的账户统计 · 今日 ${usage.usage!.todayTokens.toLocaleString("zh-CN")} tokens${usage.capturedAt ? ` · ${new Date(usage.capturedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 更新` : ""}`
            : "账户统计暂时无法读取，不会使用本地估算冒充实际账单。"}
        </p>
        <ConfigButton size="small" disabled={usageLoading} onClick={() => void loadUsage()}>
          {usageLoading ? "刷新中..." : "刷新统计"}
        </ConfigButton>
      </div>
    </div>
  );
}

function RelayAddAccountDetail({ login, onDone }: {
  login: (email: string, password: string) => Promise<{ ok: boolean; accountId?: string; message?: string }>;
  onDone: (accountId: string) => Promise<void> | void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!email.trim() || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await login(email.trim(), password);
      if (!result.ok || !result.accountId) {
        setError(result.message === "invalid-credentials" ? "邮箱或密码不正确。" : "登录失败，请检查网络后重试。");
        return;
      }
      await onDone(result.accountId);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ maxWidth: 460, display: "flex", flexDirection: "column", gap: 14 }}>
      <ConfigDetailHeader>
        <ConfigDetailHeaderInfo>
          <SectionTitle>登录其他账户</SectionTitle>
          <p style={{ margin: "6px 0 0", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.6 }}>
            登录后会保留现有账户，并自动同步新账户下的分组。
          </p>
        </ConfigDetailHeaderInfo>
      </ConfigDetailHeader>
      <Field label="邮箱">
        <TextInput value={email} onChange={setEmail} placeholder="you@example.com" />
      </Field>
      <Field label="密码">
        <SecretTextInput
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          onKeyDown={(event) => { if (event.key === "Enter") void submit(); }}
        />
      </Field>
      {error && <div role="alert" style={{ color: "#f87171", fontSize: 12 }}>{error}</div>}
      <div>
        <ConfigButton variant="primary" disabled={busy || !email.trim() || !password} onClick={() => void submit()}>
          {busy ? "正在登录..." : "登录并同步"}
        </ConfigButton>
      </div>
    </div>
  );
}

function relayProtocolLabel(protocol: string): string {
  if (protocol === "openai-responses") return "OpenAI Responses";
  if (protocol === "anthropic-messages") return "Anthropic Messages";
  if (protocol === "openai-completions") return "OpenAI Chat Completions";
  if (protocol === "openai-images") return "OpenAI Images";
  return protocol;
}

function RelayModelImport({ providerName, provider, authorizedModelIds, onAddModels }: {
  providerName: string;
  provider: ProviderEntry;
  authorizedModelIds?: readonly string[];
  onAddModels: (models: DiscoveredModel[]) => void;
}) {
  const [state, setState] = useState<ModelDiscoveryState>({ phase: "idle" });
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const authorized = authorizedModelIds === undefined ? null : new Set(authorizedModelIds);
  const existing = new Set((provider.models ?? [])
    .filter((model) => authorized?.has(model.id) ?? false)
    .map((model) => model.id));
  const discover = async () => {
    if (state.phase === "loading") return;
    if (authorized === null) {
      setState({ phase: "error", message: "请先同步当前分组，确认 API Key 实际开放的模型。" });
      return;
    }
    setState({ phase: "loading" });
    setSelected([]);
    try {
      const response = await fetch("/api/models-config/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerName, provider: { ...provider, models: undefined } }),
      });
      const result = await response.json() as { models?: DiscoveredModel[]; endpoint?: string; error?: string };
      if (!response.ok || !result.models) throw new Error(result.error ?? `HTTP ${response.status}`);
      setState({ phase: "success", models: result.models, endpoint: result.endpoint ?? provider.baseUrl ?? "" });
    } catch (caught) {
      setState({ phase: "error", message: caught instanceof Error ? caught.message : String(caught) });
    }
  };
  const visible = state.phase === "success"
    ? state.models.filter((model) => {
        const normalized = query.trim().toLocaleLowerCase();
        return !normalized || model.id.toLocaleLowerCase().includes(normalized) || model.name?.toLocaleLowerCase().includes(normalized);
      }).slice(0, 300)
    : [];
  const add = () => {
    if (state.phase !== "success") return;
    const ids = new Set(selected);
    const additions = state.models.filter((model) => authorized?.has(model.id) && ids.has(model.id) && !existing.has(model.id));
    if (!additions.length) return;
    onAddModels(additions);
    setSelected([]);
  };
  return (
    <section style={{ borderTop: "1px solid var(--border)", paddingTop: 16, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div>
          <SectionTitle>选择和导入模型</SectionTitle>
          <div style={{ marginTop: 4, color: "var(--text-dim)", fontSize: 10 }}>从当前分组的可用目录中选择，无需填写接口参数。</div>
        </div>
        <ConfigButton size="small" disabled={state.phase === "loading" || authorized === null} onClick={() => void discover()}>
          {authorized === null ? "请先同步分组" : state.phase === "loading" ? "正在读取..." : state.phase === "success" ? "重新读取" : "读取可用模型"}
        </ConfigButton>
      </div>
      {state.phase === "error" && <div role="alert" style={{ color: "#f87171", fontSize: 11 }}>{state.message}</div>}
      {state.phase === "success" && (
        <>
          <TextInput value={query} onChange={setQuery} placeholder={`搜索 ${state.models.length} 个可用模型`} />
          <div className="relay-model-import-list">
            {visible.map((model) => {
              const imported = existing.has(model.id);
              const checked = imported || selected.includes(model.id);
              return (
                <label key={model.id} className={imported ? "is-imported" : undefined}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={imported}
                    onChange={() => setSelected((current) => current.includes(model.id)
                      ? current.filter((id) => id !== model.id)
                      : [...current, model.id])}
                  />
                  <span title={model.id}>{model.name || model.id}</span>
                  <small>{imported ? "已导入" : "可导入"}</small>
                </label>
              );
            })}
          </div>
          <div>
            <ConfigButton variant="primary" size="small" disabled={selected.length === 0} onClick={add}>
              导入已选模型{selected.length ? ` (${selected.length})` : ""}
            </ConfigButton>
          </div>
        </>
      )}
    </section>
  );
}

function RelayGroupDetail({ group, provider, onSync, onAddModels }: {
  group: RelayGroupSummary;
  provider?: ProviderEntry;
  onSync: () => Promise<void>;
  onAddModels: (models: DiscoveredModel[]) => void;
}) {
  const [syncing, setSyncing] = useState(false);
  const [billing, setBilling] = useState<{ effectiveRateMultiplier?: number; observedAt?: string } | null>(null);
  const [billingLoading, setBillingLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setBillingLoading(true);
    fetch(`/api/relay-billing?providerId=${encodeURIComponent(group.providerId)}`, { signal: controller.signal })
      .then(async (response) => response.ok ? response.json() : null)
      .then((result: {
        ok?: boolean;
        status?: string;
        effectiveRateMultiplier?: number;
        effective_rate_multiplier?: number;
        observedAt?: string;
        observed_at?: string;
        capturedAt?: number;
        billing?: { effective_rate_multiplier?: number; observed_at?: string };
      } | null) => {
        if (!result || result.ok === false || (result.status && result.status !== "ready")) return setBilling(null);
        const value = result.billing?.effective_rate_multiplier ?? result.effectiveRateMultiplier ?? result.effective_rate_multiplier;
        setBilling({
          effectiveRateMultiplier: typeof value === "number" ? value : undefined,
          observedAt: result.billing?.observed_at ?? result.observedAt ?? result.observed_at ?? (result.capturedAt ? new Date(result.capturedAt).toISOString() : undefined),
        });
      })
      .catch(() => { if (!controller.signal.aborted) setBilling(null); })
      .finally(() => { if (!controller.signal.aborted) setBillingLoading(false); });
    return () => controller.abort();
  }, [group.providerId]);
  const protocols = group.protocols?.length
    ? group.protocols
    : Array.from(new Set([
      ...(provider?.models ?? []).flatMap((model) => model.api ? [model.api] : []),
      ...(group.imageModels?.length ? ["openai-images"] : []),
    ]));
  const multiplier = billing?.effectiveRateMultiplier ?? group.rateMultiplier;
  const sync = async () => {
    if (syncing) return;
    setSyncing(true);
    try { await onSync(); } finally { setSyncing(false); }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <ConfigDetailHeader>
        <ConfigDetailHeaderInfo>
          <SectionTitle>分组</SectionTitle>
          <div style={{ marginTop: 5, color: "var(--text)", fontSize: 16, fontWeight: 650 }}>{group.keyName}</div>
          {group.groupName && group.groupName !== group.keyName && <div style={{ marginTop: 3, color: "var(--text-dim)", fontSize: 11 }}>站点分组：{group.groupName}</div>}
        </ConfigDetailHeaderInfo>
        <ConfigDetailActions>
          <ConfigButton size="small" onClick={() => void sync()} disabled={syncing}>
            {syncing ? "正在同步..." : "同步分组"}
          </ConfigButton>
        </ConfigDetailActions>
      </ConfigDetailHeader>
      <dl className="relay-group-facts">
        <div><dt>API Key</dt><dd>{group.maskedKey || "已安全保存"}</dd></div>
        <div><dt>实时倍率</dt><dd>{billingLoading ? "读取中..." : multiplier === undefined ? "暂不可用" : `${multiplier}x`}</dd></div>
        <div><dt>接口协议</dt><dd>{protocols.length ? protocols.map(relayProtocolLabel).join(" / ") : "自动匹配"}</dd></div>
        <div><dt>可用模型</dt><dd>{group.modelIds === undefined ? "尚未同步" : (group.modelIds.length + (group.imageModels?.length ?? 0)) + " 个"}</dd></div>
      </dl>
      {group.modelIds === undefined && (
        <div style={{ border: "1px solid color-mix(in srgb, var(--accent) 35%, var(--border))", borderRadius: 8, padding: "9px 11px", color: "var(--text-muted)", fontSize: 11, lineHeight: 1.55 }}>
          这个分组还没有完成授权模型同步。请点击右上角“同步分组”，确认后才会显示可请求的模型。
        </div>
      )}
      {billing?.observedAt && <div style={{ color: "var(--text-dim)", fontSize: 10 }}>倍率更新时间：{new Date(billing.observedAt).toLocaleString()}</div>}
      <RelayUsageSummary providerId={group.providerId} enabled showBalance={false} />
      {provider && <RelayModelImport providerName={group.providerId} provider={provider} authorizedModelIds={group.modelIds} onAddModels={onAddModels} />}
    </div>
  );
}

interface RelayImageGenerationStatusResponse {
  ok?: boolean;
  packageName?: string;
  models?: Array<{ providerId: string; modelId: string; alias: string; isDefault: boolean }>;
  error?: string;
}

function RelayImageModelDetail({ group, modelId, onOpenPlugins }: {
  group: RelayGroupSummary;
  modelId: string;
  onOpenPlugins?: (query: string) => void;
}) {
  const [status, setStatus] = useState<RelayImageGenerationStatusResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/relay-image-generation", { cache: "no-store" });
      const next = await response.json() as RelayImageGenerationStatusResponse;
      if (!response.ok || next.error) throw new Error(next.error ?? `HTTP ${response.status}`);
      setStatus(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const current = status?.models?.find((model) => model.providerId === group.providerId && model.modelId === modelId);
  const makeDefault = async () => {
    if (saving || current?.isDefault) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/relay-image-generation", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: group.providerId, modelId }),
      });
      const next = await response.json() as RelayImageGenerationStatusResponse;
      if (!response.ok || next.error) throw new Error(next.error ?? `HTTP ${response.status}`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  const packageName = status?.packageName ?? "@amaster.ai/pi-image-gen";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <ConfigDetailHeader>
        <ConfigDetailHeaderInfo>
          <SectionTitle>图片生成模型</SectionTitle>
          <div style={{ marginTop: 5, color: "var(--text)", fontSize: 17, fontWeight: 650 }}>{modelId}</div>
          <div style={{ marginTop: 4, color: "var(--text-dim)", fontSize: 11 }}>{group.keyName} · 流星 API</div>
        </ConfigDetailHeaderInfo>
        <ConfigDetailActions>
          <ConfigButton size="small" variant={current?.isDefault ? "secondary" : "primary"} disabled={saving || current?.isDefault} onClick={() => void makeDefault()}>
            {current?.isDefault ? "当前默认" : saving ? "正在设置..." : "设为默认生图模型"}
          </ConfigButton>
        </ConfigDetailActions>
      </ConfigDetailHeader>
      <dl className="relay-group-facts">
        <div><dt>能力</dt><dd>图片生成</dd></div>
        <div><dt>接口</dt><dd>OpenAI Images 兼容</dd></div>
        <div><dt>输出目录</dt><dd>.pi/images</dd></div>
        <div><dt>模型路由</dt><dd>{current?.alias ?? "已自动同步"}</dd></div>
      </dl>
      <section style={{ border: "1px solid var(--border)", borderRadius: 9, padding: 14, display: "flex", flexDirection: "column", gap: 9 }}>
        <strong style={{ fontSize: 13 }}>启用图片生成</strong>
        <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.6 }}>
          Magent 已自动配置这个模型。安装并启用社区插件 {packageName} 后，新建或重载会话即可让助手调用生图工具。插件可执行本机代码，安装前仍会显示安全提示。
        </p>
        {onOpenPlugins && <div><ConfigButton size="small" onClick={() => onOpenPlugins(packageName)}>前往插件社区安装</ConfigButton></div>}
      </section>
      {error && <div role="alert" style={{ color: "#f87171", fontSize: 12 }}>{error}</div>}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ModelsConfig({ onClose, embedded = false, onOpenPlugins }: {
  onClose: () => void;
  embedded?: boolean;
  onOpenPlugins?: (query: string) => void;
}) {
  const { t, locale } = useI18n();
  const relaySession = useRelaySession();
  const [config, setConfig] = useState<ModelsJson>({ providers: {} });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(readRememberedSelection);
  const [oauthProviders, setOauthProviders] = useState<OAuthProvider[]>([]);
  const [apiKeyProviders, setApiKeyProviders] = useState<ApiKeyProvider[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [relayAccounts, setRelayAccounts] = useState<RelayAccountSummary[]>([]);
  const [relayGroups, setRelayGroups] = useState<RelayGroupSummary[]>([]);
  const [relayActiveAccountId, setRelayActiveAccountId] = useState<string | null>(null);
  const [relayAccountsLoading, setRelayAccountsLoading] = useState(RELAY_PRODUCT_MODE);
  const [relaySelection, setRelaySelection] = useState<RelaySelection | null>(null);
  const [expandedRelayGroups, setExpandedRelayGroups] = useState<Set<string>>(() => new Set());
  const [revision, setRevision] = useState<string | null>(null);
  const [conflicted, setConflicted] = useState(false);
  const baseConfigRef = useRef(JSON.stringify({ providers: {} }));
  const currentConfigRef = useRef(config);
  const configRequestRef = useRef(0);
  const relayAccountsRequestRef = useRef(0);
  useEffect(() => { currentConfigRef.current = config; }, [config]);

  const refreshRelayAccounts = useCallback(async () => {
    if (!RELAY_PRODUCT_MODE) return;
    const requestId = ++relayAccountsRequestRef.current;
    setRelayAccountsLoading(true);
    try {
      const response = await fetch("/api/relay-accounts", { cache: "no-store" });
      const data = await response.json() as RelayAccountsResponse;
      if (!response.ok || data.ok === false) throw new Error(data.error ?? `HTTP ${response.status}`);
      if (requestId !== relayAccountsRequestRef.current) return;
      const accounts = Array.isArray(data.accounts) ? data.accounts : [];
      const groups = Array.isArray(data.groups)
        ? data.groups
        : accounts.flatMap((account) => Array.isArray(account.groups) ? account.groups : []);
      setRelayAccounts(accounts);
      setRelayGroups(groups);
      setRelayActiveAccountId(data.activeAccountId ?? accounts.find((account) => account.active)?.accountId ?? accounts[0]?.accountId ?? null);
      setRelaySelection((current) => {
        if (current?.type === "add-account") return current;
        const currentAccountId = current?.accountId;
        if (currentAccountId && accounts.some((account) => account.accountId === currentAccountId)) return current;
        const accountId = data.activeAccountId ?? accounts[0]?.accountId;
        return accountId ? { type: "account", accountId } : { type: "add-account" };
      });
    } catch {
      if (requestId !== relayAccountsRequestRef.current) return;
      setRelayAccounts([]);
      setRelayGroups([]);
      setRelayActiveAccountId(null);
      setRelaySelection({ type: "add-account" });
    } finally {
      if (requestId === relayAccountsRequestRef.current) setRelayAccountsLoading(false);
    }
  }, []);

  const refreshAuthProviders = useCallback(() => {
    fetch("/api/auth/providers")
      .then((r) => r.json())
      .then((d: { oauthProviders?: OAuthProvider[]; apiKeyProviders?: ApiKeyProvider[] }) => {
        if (Array.isArray(d.oauthProviders)) setOauthProviders(d.oauthProviders);
        if (Array.isArray(d.apiKeyProviders)) setApiKeyProviders(d.apiKeyProviders);
      })
      .catch(() => {});
  }, []);

  const reloadConfig = useCallback((options?: { discardDraft?: boolean }) => {
    const requestId = ++configRequestRef.current;
    const requestBase = baseConfigRef.current;
    const discardDraft = options?.discardDraft === true;
    setLoading(true);
    fetch("/api/models-config")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return { data: await r.json() as ModelsJson, etag: r.headers.get("etag") };
      })
      .then(({ data: d, etag }) => {
        if (requestId !== configRequestRef.current) return;
        const normalized = d.providers ? d : { ...d, providers: {} };
        // A refresh can finish after the user starts editing. Keep that draft
        // visible and surface a conflict instead of replacing it silently.
        const draftChangedSinceRequest = JSON.stringify(currentConfigRef.current) !== requestBase;
        if (!discardDraft && draftChangedSinceRequest) {
          setConflicted(true);
          setSaveError("Configuration changed while loading. Review the draft before saving.");
          return;
        }
        baseConfigRef.current = JSON.stringify(normalized);
        currentConfigRef.current = normalized;
        setRevision(etag);
        setConflicted(false);
        setSaveError(null);
        setConfig(normalized);
        const keys = Object.keys(normalized.providers ?? {});
        setSelection((current) => current && customSelectionExists(normalized, current)
          ? current
          : keys[0]
            ? { type: "provider", name: keys[0] }
            : null);
      })
      .catch(() => {
        if (requestId === configRequestRef.current) setSaveError("Unable to load configuration. Please retry.");
      })
      .finally(() => {
        if (requestId === configRequestRef.current) setLoading(false);
      });
    refreshAuthProviders();
  }, [refreshAuthProviders]);

  useEffect(() => { reloadConfig(); }, [reloadConfig]);
  useEffect(() => { void refreshRelayAccounts(); }, [refreshRelayAccounts, relaySession.generation]);
  useEffect(() => {
    const changed = () => {
      refreshAuthProviders();
      void refreshRelayAccounts();
      if (JSON.stringify(currentConfigRef.current) !== baseConfigRef.current) {
        setConflicted(true); // Preserve the draft; never silently replace unsaved edits.
      } else reloadConfig();
    };
    window.addEventListener("relay-config-updated", changed);
    return () => window.removeEventListener("relay-config-updated", changed);
  }, [reloadConfig, refreshAuthProviders, refreshRelayAccounts]);

  useEffect(() => {
    if (selection) setLastSettingsSelection("models", JSON.stringify(selection));
  }, [selection]);

  const addCustomProvider = useCallback(() => {
    let finalName = "new-provider";
    let n = 1;
    while (config.providers?.[finalName]) finalName = `new-provider-${n++}`;
    setConfig((prev) => ({ ...prev, providers: { ...(prev.providers ?? {}), [finalName]: { api: "openai-completions" } } }));
    setSelection({ type: "provider", name: finalName });
  }, [config.providers]);

  const updateProvider = useCallback((name: string, p: ProviderEntry) => {
    setConfig((prev) => ({ ...prev, providers: { ...(prev.providers ?? {}), [name]: p } }));
  }, []);

  const renameProvider = useCallback((oldName: string, newName: string) => {
    setConfig((prev) => {
      const entries = Object.entries(prev.providers ?? {});
      const idx = entries.findIndex(([k]) => k === oldName);
      if (idx === -1) return prev;
      entries[idx] = [newName, entries[idx][1]];
      return { ...prev, providers: Object.fromEntries(entries) };
    });
    setSelection((prev) => {
      if (!prev) return prev;
      if (prev.type === "provider" && prev.name === oldName) return { type: "provider", name: newName };
      if (prev.type === "model" && prev.providerName === oldName) return { ...prev, providerName: newName };
      return prev;
    });
  }, []);

  const deleteProvider = useCallback((name: string) => {
    setConfig((prev) => {
      const providers = { ...(prev.providers ?? {}) };
      delete providers[name];
      return { ...prev, providers };
    });
    setConfig((prev) => {
      const remaining = Object.keys(prev.providers ?? {});
      setSelection(remaining.length > 0 ? { type: "provider", name: remaining[0] } : null);
      return prev;
    });
  }, []);

  const addModel = useCallback((providerName: string) => {
    setConfig((prev) => {
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? []), { id: "" }];
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, models } } };
    });
    setConfig((prev) => {
      const idx = (prev.providers?.[providerName]?.models?.length ?? 1) - 1;
      setSelection({ type: "model", providerName, index: idx });
      return prev;
    });
  }, []);

  const addDiscoveredModels = useCallback((providerName: string, discovered: DiscoveredModel[]) => {
    setConfig((prev) => {
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? [])];
      const existingIds = new Set(models.map((model) => model.id));
      for (const discoveredModel of discovered) {
        if (existingIds.has(discoveredModel.id)) continue;
        existingIds.add(discoveredModel.id);
        if (RELAY_PRODUCT_MODE && isRelayProviderId(providerName)) {
          const id = discoveredModel.id;
          const relayRoot = (provider.baseUrl ?? RELAY_CONSOLE_URL).replace(/\/v1\/?$/, "");
          const claude = /claude/i.test(id);
          const gpt = /gpt|codex/i.test(id);
          models.push({
            id,
            name: discoveredModel.name,
            contextWindow: relayContextWindowLimit(
              id,
              relayGroups.find((group) => group.providerId === providerName)?.contextWindows?.[id],
            ),
            maxTokens: 16_384,
            api: claude ? "anthropic-messages" : gpt ? "openai-responses" : "openai-completions",
            baseUrl: claude ? relayRoot : `${relayRoot}/v1`,
          });
        } else {
          models.push({ id: discoveredModel.id, name: discoveredModel.name });
        }
      }
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, models } } };
    });
  }, [relayGroups]);

  const syncRelayAccount = useCallback(async (accountId: string) => {
    if (JSON.stringify(currentConfigRef.current) !== baseConfigRef.current) {
      setSaveError("请先保存当前模型修改，再同步分组。");
      return;
    }
    const response = await fetch("/api/relay-config/auto", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId }),
    });
    const result = await response.json() as { ok?: boolean; reason?: string; message?: string };
    if (!response.ok || !result.ok) {
      setSaveError(result.message ?? (result.reason === "no-key" ? "这个账户还没有可用的 API Key。" : "分组同步失败，请稍后重试。"));
      return;
    }
    setSaveError(null);
    await refreshRelayAccounts();
    reloadConfig({ discardDraft: true });
    window.dispatchEvent(new Event("relay-config-updated"));
  }, [refreshRelayAccounts, reloadConfig]);

  const completeRelayAccountLogin = useCallback(async (accountId: string) => {
    // Make the newly authenticated account visible even when it has no usable
    // key yet, then immediately run the same authoritative sync as the account
    // action. This keeps the button label "登录并同步" truthful.
    await refreshRelayAccounts();
    setRelaySelection({ type: "account", accountId });
    await syncRelayAccount(accountId);
  }, [refreshRelayAccounts, syncRelayAccount]);

  const updateModel = useCallback((providerName: string, index: number, m: ModelEntry) => {
    setConfig((prev) => {
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? [])];
      models[index] = m;
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, models } } };
    });
  }, []);

  const removeModel = useCallback((providerName: string, index: number) => {
    setConfig((prev) => {
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? [])];
      models.splice(index, 1);
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, models: models.length ? models : undefined } } };
    });
    setSelection({ type: "provider", name: providerName });
  }, []);

  const handleSave = useCallback(async () => {
    if (!revision || conflicted) return;
    setSaving(true);
    setSaveError(null);
    setSavedOk(false);
    try {
      const res = await fetch("/api/models-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "If-Match": revision },
        body: JSON.stringify(config),
      });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || d.error) {
        if (res.status === 409 || res.status === 428) setConflicted(true);
        setSaveError(d.error ?? `HTTP ${res.status}`);
      } else {
        baseConfigRef.current = JSON.stringify(config);
        setRevision(res.headers.get("etag"));
        setSavedOk(true); setTimeout(() => setSavedOk(false), 2000);
      }
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }, [config, revision, conflicted]);

  const providers = Object.entries(config.providers ?? {});
  const activeOAuth = oauthProviders.filter((p) => p.loggedIn);
  const activeApiKey = apiKeyProviders.filter((p) => p.configured && !(isRelayProviderId(p.id) && config.providers?.[p.id]));
  const hasRelayProvider =
    activeOAuth.some((p) => isRelayProviderId(p.id))
    || activeApiKey.some((p) => isRelayProviderId(p.id))
    || providers.some(([name]) => isRelayProviderId(name));
  const selectedRelayAccountId = relaySelection && relaySelection.type !== "add-account"
    ? relaySelection.accountId
    : relayActiveAccountId;
  const selectedRelayAccount = relayAccounts.find((account) => account.accountId === selectedRelayAccountId);
  const indexedRelayProviderIds = new Set(relayGroups.map((group) => group.providerId));
  const legacyGroups: RelayGroupSummary[] = selectedRelayAccountId === relayActiveAccountId
    ? providers.flatMap(([providerId, provider]) => {
        if (!isRelayProviderId(providerId) || indexedRelayProviderIds.has(providerId)) return [];
        const protocols = Array.from(new Set((provider.models ?? []).flatMap((model) => model.api ? [model.api] : [])));
        return [{
          accountId: selectedRelayAccountId ?? "",
          providerId,
          keyId: providerId,
          keyName: provider.name?.trim() || providerId,
          maskedKey: "已安全保存",
          modelCount: provider.models?.length ?? 0,
          protocols,
        }];
      })
    : [];
  const selectedRelayGroups = [
    ...relayGroups.filter((group) => group.accountId === selectedRelayAccountId),
    ...legacyGroups,
  ].sort((a, b) => a.keyName.localeCompare(b.keyName, "zh-CN"));

  // Resolve current detail
  const detailContent = (() => {
    if (!selection) return null;
    if (selection.type === "oauth") {
      const p = oauthProviders.find((p) => p.id === selection.providerId);
      if (!p) return null;
      return <OAuthDetail key={p.id} provider={p} onRefresh={refreshAuthProviders} />;
    }
    if (selection.type === "apikey") {
      const p = apiKeyProviders.find((p) => p.id === selection.providerId);
      if (!p) return null;
      return <ApiKeyDetail key={p.id} provider={p} onRefresh={refreshAuthProviders} />;
    }
    if (selection.type === "provider") {
      const provider = config.providers?.[selection.name];
      if (!provider) return null;
      return (
        <>
        {isRelayProviderId(selection.name) && <>
          <RelayKeyRefresh providerId={selection.name} enabled />
          <RelayUsageSummary providerId={selection.name} enabled />
        </>}
        <ProviderDetail
          key={selection.name}
          name={selection.name}
          provider={provider}
          onChange={(p) => updateProvider(selection.name, p)}
          onRename={(n) => renameProvider(selection.name, n)}
          onDelete={() => deleteProvider(selection.name)}
          onAddModels={(models) => addDiscoveredModels(selection.name, models)}
        />
        </>
      );
    }
    const provider = config.providers?.[selection.providerName];
    const model = provider?.models?.[selection.index];
    if (!model) return null;
    return (
      <ModelDetail
        key={`${selection.providerName}-${selection.index}`}
        providerName={selection.providerName}
        provider={provider}
        model={model}
        onChange={(m) => updateModel(selection.providerName, selection.index, m)}
        onDelete={() => removeModel(selection.providerName, selection.index)}
      />
    );
  })();

  const relayDetailContent = (() => {
    if (relaySelection?.type === "add-account") {
      return <RelayAddAccountDetail
        login={relaySession.login}
        onDone={completeRelayAccountLogin}
      />;
    }
    if (!relaySelection || relaySelection.type === "account") {
      const account = relaySelection?.type === "account"
        ? relayAccounts.find((entry) => entry.accountId === relaySelection.accountId)
        : selectedRelayAccount;
      return account
        ? <RelayAccountDetail account={account} onAddAccount={() => setRelaySelection({ type: "add-account" })} />
        : <RelayAddAccountDetail login={relaySession.login} onDone={completeRelayAccountLogin} />;
    }
    const group = selectedRelayGroups.find((entry) => entry.providerId === relaySelection.providerId);
    const provider = config.providers?.[relaySelection.providerId];
    if (!group) return <ConfigEmptyState>这个分组正在同步，请稍后重试。</ConfigEmptyState>;
    if (relaySelection.type === "group") {
      return <RelayGroupDetail
        key={group.providerId}
        group={group}
        provider={provider}
        onSync={() => syncRelayAccount(group.accountId)}
        onAddModels={(models) => addDiscoveredModels(group.providerId, models)}
      />;
    }
    if (group.imageModels?.includes(relaySelection.modelId)) {
      return <RelayImageModelDetail
        key={`${group.providerId}-${relaySelection.modelId}`}
        group={group}
        modelId={relaySelection.modelId}
        onOpenPlugins={onOpenPlugins}
      />;
    }
    if (!provider) return <ConfigEmptyState>该分组没有可用的对话模型。</ConfigEmptyState>;
    const index = (provider.models ?? []).findIndex((model) => group.modelIds?.includes(model.id) && model.id === relaySelection.modelId);
    const model = index >= 0 ? provider.models?.[index] : undefined;
    if (!model || index < 0) return <ConfigEmptyState>该模型已不在当前分组中。</ConfigEmptyState>;
    return <ModelDetail
      key={`${group.providerId}-${model.id}`}
      providerName={group.providerId}
      provider={provider}
      model={model}
      relayMode
      relayFirstTierContextWindow={group.contextWindows?.[model.id]}
      onChange={(next) => updateModel(group.providerId, index, {
        ...next,
        contextWindow: clampRelayContextWindow(next.id, next.contextWindow, group.contextWindows?.[next.id]),
      })}
      onDelete={() => {
        removeModel(group.providerId, index);
        setRelaySelection({
          type: "group",
          accountId: group.accountId,
          providerId: group.providerId,
        });
      }}
    />;
  })();

  return (
    <>
    <ConfigPanelShell embedded={embedded} title={t("common.models")} subtitle={RELAY_PRODUCT_MODE ? "Magent 模型配置" : "~/.pi/agent/models.json"} closeLabel={t("i18n.close")} onClose={onClose}>

        {/* Body */}
        <ConfigSplitView>

          {/* Left: tree */}
          <ConfigSidebar>
            <ConfigSidebarList>
              {RELAY_PRODUCT_MODE ? (
                <>
                  <ConfigSidebarGroupLabel>账户</ConfigSidebarGroupLabel>
                  {relayAccountsLoading ? (
                    <div style={{ padding: "10px 12px", color: "var(--text-dim)", fontSize: 11 }}>正在读取账户...</div>
                  ) : relayAccounts.map((account) => {
                    const active = relaySelection?.type === "account" && relaySelection.accountId === account.accountId;
                    return (
                      <ConfigSidebarItem
                        key={account.accountId}
                        active={active}
                        onClick={() => {
                          setRelaySelection({ type: "account", accountId: account.accountId });
                          setExpandedRelayGroups(new Set());
                        }}
                      >
                        <span className="relay-account-avatar" aria-hidden="true">
                          {(account.username?.trim() || account.email).slice(0, 1).toLocaleUpperCase()}
                        </span>
                        <ConfigSidebarText className="is-grow" title={account.email}>
                          {account.username?.trim() || account.email}
                        </ConfigSidebarText>
                        {(account.active || account.accountId === relayActiveAccountId) && <span className="relay-active-dot" title="当前登录账户" />}
                      </ConfigSidebarItem>
                    );
                  })}

                  <ConfigSidebarItem
                    active={relaySelection?.type === "add-account"}
                    className="models-sidebar-add-account"
                    onClick={() => setRelaySelection({ type: "add-account" })}
                  >
                    <span aria-hidden="true" style={{ width: 18, textAlign: "center", color: "var(--accent)", fontSize: 16 }}>+</span>
                    <ConfigSidebarText>登录其他账户</ConfigSidebarText>
                  </ConfigSidebarItem>

                  <div className="relay-sidebar-separator" />
                  <ConfigSidebarGroupLabel>分组</ConfigSidebarGroupLabel>
                  {!selectedRelayAccountId ? (
                    <div style={{ padding: "10px 12px", color: "var(--text-dim)", fontSize: 11 }}>请先登录一个账户</div>
                  ) : selectedRelayGroups.length === 0 ? (
                    <div style={{ padding: "10px 12px", color: "var(--text-dim)", fontSize: 11, lineHeight: 1.5 }}>
                      暂无分组。请先在流星 API 创建 API Key，再点击同步。
                    </div>
                  ) : selectedRelayGroups.map((group) => {
                    const expanded = expandedRelayGroups.has(group.providerId);
                    const provider = config.providers?.[group.providerId];
                    const authorizedChatModels = group.modelIds === undefined
                      ? []
                      : (provider?.models ?? []).filter((model) => group.modelIds?.includes(model.id));
                    const models = [
                      ...authorizedChatModels.map((model) => ({ ...model, imageGeneration: false as const })),
                      ...(group.imageModels ?? []).map((id) => ({ id, name: id, reasoning: false, imageGeneration: true as const })),
                    ];
                    const groupSelected = relaySelection?.type === "group" && relaySelection.providerId === group.providerId;
                    return (
                      <div key={group.providerId} className="relay-sidebar-group">
                        <ConfigSidebarItem
                          active={groupSelected}
                          aria-expanded={expanded}
                          onClick={() => {
                            setExpandedRelayGroups((current) => {
                              const next = new Set(current);
                              if (next.has(group.providerId)) next.delete(group.providerId);
                              else next.add(group.providerId);
                              return next;
                            });
                            setRelaySelection({ type: "group", accountId: group.accountId, providerId: group.providerId });
                          }}
                        >
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            aria-hidden="true"
                            style={{ color: "var(--text-dim)", transform: expanded ? "rotate(90deg)" : "none", transition: "transform .15s", flexShrink: 0 }}
                          >
                            <polyline points="9 18 15 12 9 6" />
                          </svg>
                          <ConfigSidebarText className="is-grow" title={group.keyName}>{group.keyName}</ConfigSidebarText>
                          {group.modelIds === undefined && <small className="relay-group-rate" title="需要同步后确认可用模型">待同步</small>}
                          {group.rateMultiplier !== undefined && <small className="relay-group-rate">{group.rateMultiplier}x</small>}
                        </ConfigSidebarItem>
                        {expanded && models.map((model) => {
                          const active = relaySelection?.type === "model"
                            && relaySelection.providerId === group.providerId
                            && relaySelection.modelId === model.id;
                          const compatibilityMode = !model.imageGeneration
                            && model.api === "openai-completions"
                            && RELAY_OPENAI_MODEL_ID.test(model.id);
                          return (
                            <ConfigSidebarItem
                              key={`${model.imageGeneration ? "image" : "chat"}:${model.id}`}
                              active={active}
                              className="models-sidebar-indented-item"
                              onClick={() => setRelaySelection({
                                type: "model",
                                accountId: group.accountId,
                                providerId: group.providerId,
                                modelId: model.id,
                              })}
                            >
                              <ConfigSidebarText className="is-grow" title={model.id}>{model.name || model.id}</ConfigSidebarText>
                              {model.imageGeneration && <span className="relay-reasoning-badge" title="图片生成">图</span>}
                              {compatibilityMode && <span className="relay-protocol-badge" title="Chat Completions 兼容模式">兼容</span>}
                              {model.reasoning && <span className="relay-reasoning-badge">T</span>}
                            </ConfigSidebarItem>
                          );
                        })}
                      </div>
                    );
                  })}
                </>
              ) : (<>
              {/* Active OAuth subscriptions */}
              {activeOAuth.map((p) => {
                const isSelected = selection?.type === "oauth" && selection.providerId === p.id;
                return (
                  <ConfigSidebarItem
                    key={p.id}
                    active={isSelected}
                    onClick={() => setSelection({ type: "oauth", providerId: p.id })}
                  >
                    <ProviderIcon id={p.id} size={16} />
                    <ConfigSidebarText className="is-grow">{p.name}</ConfigSidebarText>
                  </ConfigSidebarItem>
                );
              })}

              {/* Active API key providers */}
              {activeApiKey.map((p) => {
                const isSelected = selection?.type === "apikey" && selection.providerId === p.id;
                return (
                  <ConfigSidebarItem
                    key={p.id}
                    active={isSelected}
                    onClick={() => setSelection({ type: "apikey", providerId: p.id })}
                  >
                    <ProviderIcon id={p.id} size={16} />
                    <ConfigSidebarText className="is-grow">{p.displayName}</ConfigSidebarText>
                  </ConfigSidebarItem>
                );
              })}

              {/* Divider before custom providers, only when there are active managed providers */}
              {(activeOAuth.length > 0 || activeApiKey.length > 0) && providers.length > 0 && (
                <div style={{ margin: "4px 8px", borderTop: "1px solid var(--border)" }} />
              )}

              {/* Custom providers */}
              {loading ? (
                 <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--text-muted)" }}>{t("i18n.loading")}</div>
              ) : providers.map(([pName, pData]) => {
                const isProviderSelected = selection?.type === "provider" && selection.name === pName;
                const models = pData.models ?? [];
                return (
                  <div key={pName} style={{ marginBottom: 2 }}>
                    {/* Provider row */}
                    <ConfigSidebarItem
                      onClick={() => setSelection({ type: "provider", name: pName })}
                      active={isProviderSelected}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-dim)", flexShrink: 0 }}>
                        <rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" />
                        <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
                        <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
                        <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
                        <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
                      </svg>
                      <ConfigSidebarText className="is-grow">
                        {pData.name || pName}
                      </ConfigSidebarText>
                    </ConfigSidebarItem>

                    {/* Model rows */}
                    {models.map((m, i) => {
                      const isModelSelected = selection?.type === "model" && selection.providerName === pName && selection.index === i;
                      return (
                        <ConfigSidebarItem
                          key={i}
                          active={isModelSelected}
                          className="models-sidebar-indented-item"
                          onClick={() => setSelection({ type: "model", providerName: pName, index: i })}
                        >
                          <ConfigSidebarText className="is-grow" style={{ color: m.id ? "var(--text-muted)" : "var(--text-dim)" }}>
                             {m.id || t("i18n.newModel")}
                          </ConfigSidebarText>
                          {m.reasoning && (
                            <span style={{ fontSize: 9, padding: "1px 4px", background: "rgba(99,102,241,0.12)", color: "rgba(99,102,241,0.8)", borderRadius: 3, flexShrink: 0 }}>T</span>
                          )}
                        </ConfigSidebarItem>
                      );
                    })}

                    {/* Add model button */}
                    <ConfigSidebarItem
                      className="models-sidebar-indented-item models-sidebar-add-item"
                      onClick={(e) => { e.stopPropagation(); addModel(pName); }}
                    >
                       <ConfigSidebarText>+ {t("i18n.model")}</ConfigSidebarText>
                    </ConfigSidebarItem>
                  </div>
                );
              })}
              </>)}
            </ConfigSidebarList>

            {/* Add provider */}
            {RELAY_PRODUCT_MODE ? (
              <ConfigListAction
                disabled={!selectedRelayAccountId}
                onClick={() => selectedRelayAccountId && void syncRelayAccount(selectedRelayAccountId)}
              >
                同步当前账户分组
              </ConfigListAction>
            ) : (
              <ConfigListAction onClick={() => setPickerOpen(true)}>{t("i18n.addProvider")}</ConfigListAction>
            )}
          </ConfigSidebar>

          {/* Right: detail */}
          <ConfigDetail>
            <ConfigDetailStack className="is-fill">
              {RELAY_PRODUCT_MODE ? (
                loading || relayAccountsLoading ? null : relayDetailContent
              ) : loading ? null : detailContent ?? (
                <>
                  {!hasRelayProvider && <RelayOnboarding />}
                  <ConfigEmptyState>{t("i18n.selectProviderModel")}</ConfigEmptyState>
                </>
              )}
            </ConfigDetailStack>
          </ConfigDetail>
        </ConfigSplitView>

        {/* Footer */}
        <ConfigFooter status={(saveError || conflicted) && <span style={{ color: "#f87171" }}>{conflicted ? (locale.startsWith("zh") ? "配置已更新，当前未保存修改已保留。请重新载入后再编辑。" : "Configuration changed. Your draft is retained; reload before editing again.") : saveError}</span>}>
          {(conflicted || (!revision && !loading)) && <ConfigButton onClick={() => reloadConfig({ discardDraft: true })}>{locale.startsWith("zh") ? "放弃未保存修改并重新载入" : "Discard draft and reload"}</ConfigButton>}
          {!embedded && <ConfigButton onClick={onClose}>{t("i18n.cancel")}</ConfigButton>}
          <ConfigButton
            variant="primary"
            onClick={handleSave}
            disabled={saving || savedOk || !revision || conflicted}
            className={savedOk ? "is-success" : undefined}
          >
            {savedOk && (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
                className="config-button-success-icon">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
             <span>{savedOk ? t("i18n.saved") : saving ? t("i18n.saving") : t("i18n.save")}</span>
          </ConfigButton>
        </ConfigFooter>
    </ConfigPanelShell>
    {pickerOpen && (
      <AddProviderPicker
        oauthProviders={oauthProviders}
        apiKeyProviders={apiKeyProviders}
        onSelectOAuth={(id) => setSelection({ type: "oauth", providerId: id })}
        onSelectApiKey={(id) => setSelection({ type: "apikey", providerId: id })}
        onAddCustom={addCustomProvider}
        onClose={() => setPickerOpen(false)}
      />
    )}
    </>
  );
}
