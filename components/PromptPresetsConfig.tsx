"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { usePromptPresets } from "@/hooks/usePromptPresets";
import {
  MAX_PRESET_CONTENT_LENGTH, MAX_PRESET_NAME_LENGTH, MAX_PROMPT_PRESETS,
  type PromptPreset,
} from "@/lib/prompt-presets";
import {
  ConfigButton, ConfigDetail, ConfigDetailActions, ConfigDetailHeader, ConfigDetailHeaderInfo,
  ConfigDetailTitle, ConfigEmptyState, ConfigField, ConfigSidebar, ConfigSidebarItem,
  ConfigSidebarList, ConfigSidebarText, ConfigSplitView,
} from "./SettingsUi";

export function PromptPresetsConfig() {
  const { t } = useI18n();
  const { settings, busy, error, update, reload } = usePromptPresets();
  const [draft, setDraft] = useState<PromptPreset | null>(null);
  const [original, setOriginal] = useState<PromptPreset | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(original);

  const edit = (preset: PromptPreset) => {
    if (dirty && !window.confirm(t("presets.discard"))) return;
    setDraft({ ...preset });
    setOriginal({ ...preset });
    setSaved(false);
  };
  const add = () => {
    if (dirty && !window.confirm(t("presets.discard"))) return;
    setDraft({ id: crypto.randomUUID(), name: "", content: "" });
    setOriginal(null);
    setSaved(false);
  };
  const save = async () => {
    if (!draft) return;
    if (await update({ type: "save", preset: draft })) {
      const normalized = { ...draft, name: draft.name.trim() };
      setDraft(normalized);
      setOriginal(normalized);
      setSaved(true);
    }
  };
  const remove = async () => {
    if (!draft || !window.confirm(t("presets.deleteConfirm", { name: draft.name }))) return;
    if (await update({ type: "delete", id: draft.id })) {
      setDraft(null);
      setOriginal(null);
    }
  };

  return (
    <div className="prompt-presets-config">
      <div className="prompt-presets-intro">
        <h2>{t("presets.title")}</h2>
        <p>{t("presets.description")}</p>
        <div className="prompt-presets-defaults">
          <label>{t("presets.newPreset")}
            <select value={settings?.selectedPresetId ?? ""} disabled={!settings || busy}
              onChange={(event) => void update({ type: "select", selectedPresetId: event.target.value || null })}>
              <option value="">{t("presets.none")}</option>
              {settings?.presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
            </select>
          </label>
        </div>
        {error && <p role="alert" className="settings-general-error">{t("presets.failed")} {error} <button type="button" onClick={() => void reload()}>{t("presets.retry")}</button></p>}
      </div>
      <ConfigSplitView>
        <ConfigSidebar>
          <ConfigButton disabled={!settings || busy || settings.presets.length >= MAX_PROMPT_PRESETS} onClick={add}>{t("presets.add")}</ConfigButton>
          <ConfigSidebarList>
            {settings?.presets.map((preset) => (
              <ConfigSidebarItem key={preset.id} active={draft?.id === preset.id} disabled={busy} onClick={() => edit(preset)}>
                <ConfigSidebarText>{preset.name}{settings.selectedPresetId === preset.id ? ` · ${t("presets.selected")}` : ""}</ConfigSidebarText>
              </ConfigSidebarItem>
            ))}
          </ConfigSidebarList>
        </ConfigSidebar>
        <ConfigDetail>
          {!settings ? <ConfigEmptyState>{error ? t("presets.failed") : t("presets.loading")}</ConfigEmptyState> : draft ? (
            <div className="prompt-preset-editor">
              <ConfigDetailHeader>
                <ConfigDetailHeaderInfo><ConfigDetailTitle>{original ? t("presets.edit") : t("presets.add")}</ConfigDetailTitle></ConfigDetailHeaderInfo>
                <ConfigDetailActions>
                  {original && <ConfigButton variant="danger" disabled={busy} onClick={() => void remove()}>{t("presets.delete")}</ConfigButton>}
                  <ConfigButton variant="primary" disabled={busy || !dirty || !draft.name.trim() || !draft.content.trim()} onClick={() => void save()}>
                    {busy ? t("presets.saving") : t("presets.save")}
                  </ConfigButton>
                </ConfigDetailActions>
              </ConfigDetailHeader>
              <ConfigField label={t("presets.name")}>
                <input aria-label={t("presets.name")} value={draft.name} maxLength={MAX_PRESET_NAME_LENGTH} disabled={busy} placeholder={t("presets.namePlaceholder")}
                  onChange={(event) => { setDraft({ ...draft, name: event.target.value }); setSaved(false); }} />
              </ConfigField>
              <ConfigField label={t("presets.content")}>
                <textarea aria-label={t("presets.content")} value={draft.content} maxLength={MAX_PRESET_CONTENT_LENGTH} disabled={busy} rows={14} placeholder={t("presets.contentPlaceholder")}
                  onChange={(event) => { setDraft({ ...draft, content: event.target.value }); setSaved(false); }} />
              </ConfigField>
              <div className="prompt-preset-editor-footer">
                <span>{draft.content.length.toLocaleString()} / {MAX_PRESET_CONTENT_LENGTH.toLocaleString()}</span>
                <span role="status">{saved ? t("presets.saved") : dirty ? t("presets.unsaved") : ""}</span>
              </div>
            </div>
          ) : <ConfigEmptyState>{settings.presets.length ? t("presets.choose") : t("presets.empty")}</ConfigEmptyState>}
        </ConfigDetail>
      </ConfigSplitView>
    </div>
  );
}
