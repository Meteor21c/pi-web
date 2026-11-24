"use client";

import { useI18n } from "@/hooks/useI18n";
import { useFileContextMenu } from "@/hooks/useFileContextMenu";
import { getFileName, getRelativeFilePath } from "@/lib/file-paths";
import type { WrittenFile } from "@/lib/turn-written-files";
import { getFileIcon } from "./FileIcons";

export function TurnWrittenFiles({ files, cwd, onOpenFile }: {
  files: WrittenFile[];
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
}) {
  const { locale, t } = useI18n();
  const openFileMenu = useFileContextMenu();
  if (files.length === 0) return null;
  const heading = t("chat.filesWritten", { count: files.length.toLocaleString(locale) });

  return (
    <section className="turn-files-card" aria-label={heading}>
      <div className="turn-files-heading">{heading}</div>
      <ul className="turn-files-list">
        {files.map(({ filePath, change }) => {
          const filename = getFileName(filePath);
          const displayPath = getRelativeFilePath(filePath, cwd);
          const directory = displayPath.slice(0, displayPath.length - filename.length);
          const contents = (
            <>
              <span className="turn-files-icon" aria-hidden="true">{getFileIcon(filename, 14)}</span>
              <span className="turn-files-path">
                {directory && <span className="turn-files-directory">{directory}</span>}{filename}
              </span>
              {change && <span className="turn-files-change" data-change={change}>{t(`chat.fileChange.${change}`)}</span>}
              {onOpenFile && <span className="turn-files-open" aria-hidden="true">›</span>}
            </>
          );
          return (
            <li key={filePath} onContextMenu={(event) => openFileMenu(event, {
              filePath, onPreview: onOpenFile ? () => onOpenFile(filePath) : undefined,
            })}>
              {onOpenFile ? (
                <button
                  type="button"
                  className="turn-files-row"
                  title={displayPath}
                  aria-label={t("chat.openWrittenFile", { name: displayPath })}
                  onClick={() => onOpenFile(filePath)}
                >{contents}</button>
              ) : <div className="turn-files-row" title={displayPath}>{contents}</div>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
