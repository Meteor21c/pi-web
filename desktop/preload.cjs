"use strict";

/* eslint-disable @typescript-eslint/no-require-imports -- Electron loads sandboxed preloads as CommonJS. */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("piDesktop", {
  selectDirectory: () => ipcRenderer.invoke("magent:select-directory"),
});
