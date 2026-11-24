"use client";

import { createContext, useContext, type MouseEvent } from "react";

export interface FileContextMenuTarget {
  filePath: string;
  isDirectory?: boolean;
  nativeAvailable?: boolean;
  onPreview?: () => void;
  previewLabel?: string;
}

export type OpenFileContextMenu = (event: MouseEvent<HTMLElement>, target: FileContextMenuTarget) => void;

export const FileContextMenuContext = createContext<OpenFileContextMenu>(() => {});

export function useFileContextMenu(): OpenFileContextMenu {
  return useContext(FileContextMenuContext);
}
