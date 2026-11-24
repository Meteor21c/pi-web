"use client";

import { useCallback, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import { getFileName } from "@/lib/file-paths";
import { isLocalDesktopHost } from "@/lib/local-desktop";
import type { NativeFileAction } from "@/lib/native-directory";
import { useI18n } from "@/hooks/useI18n";
import { FileContextMenuContext, type FileContextMenuTarget, type OpenFileContextMenu } from "@/hooks/useFileContextMenu";
import { currentUiScale } from "@/lib/ui-scale";
import styles from "./FileActions.module.css";

const MENU_WIDTH = 208;
const unsubscribe = () => {};
const subscribe = () => unsubscribe;
const browserIsLocal = () => isLocalDesktopHost(window.location.hostname);
const serverIsLocal = () => false;

function useLocalDesktop(): boolean {
  return useSyncExternalStore(subscribe, browserIsLocal, serverIsLocal);
}

function NativeFileButtons({
  filePath,
  isDirectory,
  onSuccess,
}: {
  filePath: string;
  isDirectory?: boolean;
  onSuccess?: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [failedAction, setFailedAction] = useState<NativeFileAction | null>(null);

  const run = async (action: NativeFileAction) => {
    setBusy(true);
    setFailedAction(null);
    try {
      const response = await fetch("/api/open-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath, action }),
      });
      if (!response.ok) throw new Error("Native file action failed");
      onSuccess?.();
    } catch {
      setFailedAction(action);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" disabled={busy} onClick={() => void run("open")}>
        {t(isDirectory ? "files.openFolderLocally" : "files.openLocally")}
      </button>
      <button type="button" disabled={busy} onClick={() => void run("reveal")}>
        {t("files.revealLocally")}
      </button>
      {failedAction && (
        <span className={styles.error} role="alert">
          {t(failedAction === "open" ? "files.nativeOpenFailed" : "files.nativeRevealFailed")}
        </span>
      )}
    </>
  );
}

type ContextMenu = FileContextMenuTarget & { x: number; y: number };

export function FileContextMenuProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const local = useLocalDesktop();
  const [target, setTarget] = useState<ContextMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const openMenu: OpenFileContextMenu = useCallback((event, item) => {
    if (event.defaultPrevented || !menuRef.current?.showPopover
      || ((!local || item.nativeAvailable === false) && !item.onPreview)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.clientX || event.clientY) {
      setTarget({ ...item, x: event.clientX, y: event.clientY });
    } else {
      const { left, bottom } = event.currentTarget.getBoundingClientRect();
      setTarget({ ...item, x: left, y: bottom });
    }
  }, [local]);

  const close = () => setTarget((current) => current === target ? null : current);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu?.showPopover) return;
    if (!target) {
      if (menu.matches(":popover-open")) menu.hidePopover();
      return;
    }
    if (!menu.matches(":popover-open")) menu.showPopover();
    const scale = currentUiScale();
    const margin = 8 * scale;
    menu.style.maxHeight = `${Math.max(0, window.innerHeight - margin * 2) / scale}px`;
    const { width, height } = menu.getBoundingClientRect();
    const x = Math.max(margin, Math.min(target.x, window.innerWidth - width - margin));
    const y = Math.max(margin, Math.min(target.y, window.innerHeight - height - margin));
    menu.style.left = `${x / scale}px`;
    menu.style.top = `${y / scale}px`;
    menu.style.maxHeight = `${Math.max(0, window.innerHeight - y - margin) / scale}px`;
    menu.querySelector("button")?.focus({ preventScroll: true });
  }, [target]);

  return (
    <FileContextMenuContext.Provider value={openMenu}>
      {children}
      <div ref={menuRef} popover="auto" className={styles.menu} role="group"
        aria-label={target ? t("files.actionsFor", { name: getFileName(target.filePath) }) : t("files.actions")}
        onToggle={(event) => { if (!event.currentTarget.matches(":popover-open")) setTarget(null); }}
        onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}
      >
        {target?.onPreview && <button type="button" onClick={() => { close(); target.onPreview?.(); }}>
          {target.previewLabel ?? t("files.previewInMagent")}
        </button>}
        {target && local && target.nativeAvailable !== false && (
          <NativeFileButtons key={target.filePath} filePath={target.filePath} isDirectory={target.isDirectory} onSuccess={close} />
        )}
      </div>
    </FileContextMenuContext.Provider>
  );
}

export function FileActionsMenu({
  filePath,
  isDirectory,
  downloadHref,
  onMention,
  onDelete,
  inTree = false,
}: {
  filePath: string;
  isDirectory?: boolean;
  downloadHref?: string;
  onMention?: () => void;
  onDelete?: () => void;
  inTree?: boolean;
}) {
  const { t } = useI18n();
  const local = useLocalDesktop();
  const id = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  if (!local && !downloadHref && !onMention && !onDelete) return null;

  const positionMenu = (event: MouseEvent<HTMLButtonElement>) => {
    const menu = menuRef.current;
    if (!menu) return;
    const { top, bottom, right } = event.currentTarget.getBoundingClientRect();
    const scale = currentUiScale();
    const availableBelow = window.innerHeight - bottom;
    const above = availableBelow < 228 * scale && top > availableBelow;
    const maxLeft = window.innerWidth / scale - MENU_WIDTH - 8;
    menu.style.left = `${Math.max(8, Math.min(maxLeft, right / scale - MENU_WIDTH))}px`;
    menu.style.top = above ? "auto" : `${bottom / scale + 4}px`;
    menu.style.bottom = above ? `${(window.innerHeight - top) / scale + 4}px` : "auto";
    menu.style.maxHeight = `${Math.max(48, (above ? top : availableBelow) / scale - 12)}px`;
  };

  const close = () => {
    const menu = menuRef.current;
    if (menu?.matches(":popover-open")) menu.hidePopover();
  };

  return (
    <>
      <button
        type="button"
        className={inTree ? styles.treeTrigger : "file-viewer-icon-button"}
        title={t("files.actions")}
        aria-label={t("files.actionsFor", { name: getFileName(filePath) })}
        popoverTarget={id}
        onClick={positionMenu}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.65" /><circle cx="12" cy="12" r="1.65" /><circle cx="19" cy="12" r="1.65" />
        </svg>
      </button>
      <div id={id} ref={menuRef} popover="auto" className={styles.menu} role="group" aria-label={t("files.actions")}>
        {local && <NativeFileButtons filePath={filePath} isDirectory={isDirectory} onSuccess={close} />}
        {onMention && <button type="button" onClick={() => { close(); onMention(); }}>{t("files.insertPath")}</button>}
        {downloadHref && (
          <a href={downloadHref} download={getFileName(filePath)} onClick={close}>
            {t(local ? "files.saveCopy" : "files.download")}
          </a>
        )}
        {onDelete && (
          <button type="button" className={styles.delete} onClick={() => { close(); onDelete(); }}>
            {t("files.delete")}
          </button>
        )}
      </div>
    </>
  );
}

export function UnpreviewableFileActions({ filePath, downloadHref }: { filePath: string; downloadHref: string }) {
  const { t } = useI18n();
  const local = useLocalDesktop();
  return (
    <div className={styles.details}>
      <p>{t("files.previewUnavailable")}</p>
      <div className={styles.detailsActions}>
        {local
          ? <NativeFileButtons filePath={filePath} />
          : <a href={downloadHref} download={getFileName(filePath)}>{t("files.download")}</a>}
      </div>
    </div>
  );
}
