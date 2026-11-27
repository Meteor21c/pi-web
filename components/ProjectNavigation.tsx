"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import type { NamedProject, ProjectSnapshot } from "@/lib/projects";
import { DirectoryPicker } from "./DirectoryPicker";
import { ConfigButton, ConfigPanelShell } from "./SettingsUi";

interface NavigationProps {
  projects: NamedProject[];
  activeId: string | null | undefined;
  activity: (id: string | null) => ReactNode;
  onSelect: (id: string | null) => void;
  onNewProject: () => void;
  onEditProject: (project: NamedProject) => void;
  onNewChat: () => void;
}

const actionClass = "flex size-7 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-bg-selected hover:text-accent focus-visible:outline-2 focus-visible:outline-accent";

function ProjectNavRow({ label, selected, icon, children, onClick }: {
  label: string;
  selected: boolean;
  icon: ReactNode;
  children?: ReactNode;
  onClick: () => void;
}) {
  return (
    <div className={`flex min-w-0 items-center gap-0.5 rounded-lg ${selected ? "bg-bg-selected text-accent" : "text-text-muted hover:bg-bg-hover"}`}>
      <button type="button" className="flex min-h-7 min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 text-left text-xs focus-visible:rounded-lg focus-visible:outline-2 focus-visible:outline-accent" title={label} aria-current={selected ? "page" : undefined} onClick={onClick}>
        {icon}
        <span className="truncate">{label}</span>
      </button>
      {children}
    </div>
  );
}

export function PlusIcon() {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M6 1.5v9M1.5 6h9" /></svg>;
}

function FolderIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className="shrink-0" aria-hidden="true"><path d="M1.5 4h4l1.5 2h7.5v6.5h-13Z" /></svg>;
}

function ChatIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" className="shrink-0" aria-hidden="true"><path d="M2 3.5h12v8H7l-3 2.5v-2.5H2Z" /></svg>;
}

export function ProjectNavigation({ projects, activeId, activity, onSelect, onNewProject, onEditProject, onNewChat }: NavigationProps) {
  const { t } = useI18n();
  return (
    <nav aria-label={t("projects.navigation")} className="mb-2 flex min-w-0 flex-col gap-0.5">
      <div className="flex items-center justify-between pl-2">
        <span className="text-[11px] font-semibold text-text-muted">{t("projects.section")}</span>
        <button type="button" className={actionClass} title={t("projects.new")} aria-label={t("projects.new")} onClick={onNewProject}><PlusIcon /></button>
      </div>
      {projects.length > 0 && (
        <div className="max-h-[min(22vh,140px)] overflow-y-auto">
          {projects.map((project) => (
            <ProjectNavRow key={project.id} label={project.name} icon={<FolderIcon />} selected={activeId === project.id} onClick={() => onSelect(project.id)}>
              {activity(project.id)}
              <button type="button" className={actionClass} title={t("projects.edit", { name: project.name })} aria-label={t("projects.edit", { name: project.name })} onClick={() => onEditProject(project)}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="13" cy="8" r="1.2" /></svg>
              </button>
            </ProjectNavRow>
          ))}
        </div>
      )}
      <ProjectNavRow label={t("projects.standalone")} icon={<ChatIcon />} selected={activeId === null} onClick={() => onSelect(null)}>
        {activity(null)}
        <button type="button" className={actionClass} title={t("projects.newStandalone")} aria-label={t("projects.newStandalone")} onClick={onNewChat}><PlusIcon /></button>
      </ProjectNavRow>
    </nav>
  );
}

async function saveProjectChange(url: string, method: "POST" | "PATCH", body: object) {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => null) as
    (ProjectSnapshot & { project?: NamedProject; error?: string }) | null;
  if (!response.ok || !Array.isArray(result?.projects) || !result?.assignments) {
    throw new Error(result?.error || `HTTP ${response.status}`);
  }
  return result;
}

const inputClass = "w-full min-w-0 rounded-md border border-border bg-bg-panel px-2.5 py-2 text-sm text-text focus-visible:outline-2 focus-visible:outline-accent";

export function ProjectEditor({ project, initialPath, onSaved, onClose }: {
  project: NamedProject | null;
  initialPath?: string;
  onSaved: (snapshot: ProjectSnapshot, created?: NamedProject) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(project?.name ?? "");
  const [directories, setDirectories] = useState(project?.directories ?? []);
  const [defaultDirectory, setDefaultDirectory] = useState(project?.defaultDirectory ?? "");
  const [showPicker, setShowPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addDirectory = (path: string) => {
    setDirectories((current) => current.includes(path) ? current : [...current, path]);
    setDefaultDirectory((current) => current && !project?.unavailableDirectories?.includes(current) ? current : path);
    setShowPicker(false);
    setError(null);
  };

  const chooseDirectory = async () => {
    if (window.piDesktop?.selectDirectory) {
      try {
        const path = await window.piDesktop.selectDirectory();
        if (path) addDirectory(path);
        return;
      } catch {
        // A remote or unsupported desktop bridge can still use the app picker.
      }
    }
    setShowPicker(true);
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !name.trim() || !defaultDirectory) return;
    setBusy(true);
    setError(null);
    try {
      const result = await saveProjectChange(project ? `/api/projects/${encodeURIComponent(project.id)}` : "/api/projects", project ? "PATCH" : "POST", { name: name.trim(), directories, defaultDirectory });
      onSaved(result, project ? undefined : result.project);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("projects.saveFailed"));
      setBusy(false);
    }
  };

  return createPortal(
    <ConfigPanelShell embedded={false} title={project ? t("projects.settings") : t("projects.new")} onClose={() => !busy && onClose()} closeLabel={t("i18n.close")} width={470} height="auto">
      <form className="flex min-h-0 max-h-[calc(88dvh-50px)] flex-col gap-4 overflow-y-auto p-4" onSubmit={(event) => void save(event)} onKeyDown={(event) => {
        if (event.key === "Escape" && !showPicker && !busy) { event.stopPropagation(); onClose(); }
      }}>
        <label className="flex flex-col gap-1.5 text-xs font-medium text-text-muted">
          {t("projects.name")}
          <input className={inputClass} value={name} maxLength={100} required autoFocus onChange={(event) => setName(event.target.value)} />
        </label>
        <fieldset className="min-w-0 rounded-lg border border-border p-2.5">
          <legend className="px-1.5 text-xs font-medium text-text-muted">{t("projects.folders")}</legend>
          <p className="mb-2 text-xs text-text-dim">{t("projects.foldersHelp")}</p>
          {directories.map((path) => (
            <div key={path} className="mb-1.5 flex min-w-0 items-center gap-2 rounded-md bg-bg-hover pl-2">
              <label className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-xs text-text" title={path}>
                <input type="radio" name="default-directory" checked={defaultDirectory === path} onChange={() => setDefaultDirectory(path)} aria-label={t("projects.defaultFolder", { path })} />
                <span className="break-all">
                  {path}
                  {project?.unavailableDirectories?.includes(path) && <span className="ml-1.5 text-text-dim">{t("projects.folderUnavailable")}</span>}
                </span>
              </label>
              <button type="button" className={actionClass} title={t("projects.removeFolder", { path })} aria-label={t("projects.removeFolder", { path })} onClick={() => {
                const remaining = directories.filter((directory) => directory !== path);
                setDirectories(remaining);
                if (defaultDirectory === path) setDefaultDirectory(remaining[0] ?? "");
              }}>×</button>
            </div>
          ))}
          <ConfigButton type="button" size="small" disabled={busy} onClick={() => void chooseDirectory()}>{t("projects.addFolder")}</ConfigButton>
        </fieldset>
        {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
        <div className="flex justify-end gap-2">
          <ConfigButton type="button" disabled={busy} onClick={onClose}>{t("i18n.cancel")}</ConfigButton>
          <ConfigButton type="submit" variant="primary" disabled={busy || !name.trim() || !defaultDirectory}>{t("projects.save")}</ConfigButton>
        </div>
      </form>
      {showPicker && <DirectoryPicker initialPath={defaultDirectory || initialPath} onCancel={() => setShowPicker(false)} onSelect={addDirectory} />}
    </ConfigPanelShell>,
    document.body,
  );
}

export function ProjectMoveDialog({ sessionIds, projects, onSaved, onClose }: {
  sessionIds: string[];
  projects: NamedProject[];
  onSaved: (snapshot: ProjectSnapshot) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!destination || busy) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await saveProjectChange("/api/projects/assignments", "POST", {
        sessionIds,
        projectId: destination === "standalone" ? null : destination.slice("project:".length),
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("projects.saveFailed"));
      setBusy(false);
    }
  };

  return createPortal(
    <ConfigPanelShell embedded={false} title={t("projects.moveCount", { count: sessionIds.length })} onClose={() => !busy && onClose()} closeLabel={t("i18n.close")} width={400} height="auto">
      <form className="flex flex-col gap-3 p-4" onSubmit={(event) => void save(event)} onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); }
      }}>
        <label className="flex flex-col gap-1.5 text-xs font-medium text-text-muted">
          {t("projects.destination")}
          <select className={inputClass} value={destination} onChange={(event) => setDestination(event.target.value)} autoFocus disabled={busy}>
            <option value="" disabled>{t("projects.chooseDestination")}</option>
            {projects.map((project) => <option key={project.id} value={`project:${project.id}`}>{project.name}</option>)}
            <option value="standalone">{t("projects.standalone")}</option>
          </select>
        </label>
        {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
        <div className="flex justify-end gap-2">
          <ConfigButton type="button" disabled={busy} onClick={onClose}>{t("i18n.cancel")}</ConfigButton>
          <ConfigButton type="submit" variant="primary" disabled={!destination || busy}>{t("projects.move")}</ConfigButton>
        </div>
      </form>
    </ConfigPanelShell>,
    document.body,
  );
}
