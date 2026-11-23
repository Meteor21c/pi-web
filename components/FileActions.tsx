"use client";

import { useId, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import { getFileName } from "@/lib/file-paths";
import { isLocalDesktopHost } from "@/lib/local-desktop";
import type { NativeFileAction } from "@/lib/native-directory";
import { useI18n } from "@/hooks/useI18n";
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
    const availableBelow = window.innerHeight - bottom;
    const above = availableBelow < 228 && top > availableBelow;
    const maxLeft = window.innerWidth - MENU_WIDTH - 8;
    menu.style.left = `${Math.max(8, Math.min(maxLeft, right - MENU_WIDTH))}px`;
    menu.style.top = above ? "auto" : `${bottom + 4}px`;
    menu.style.bottom = above ? `${window.innerHeight - top + 4}px` : "auto";
    menu.style.maxHeight = `${Math.max(48, (above ? top : availableBelow) - 12)}px`;
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
