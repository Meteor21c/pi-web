"use strict";

/* eslint-disable @typescript-eslint/no-require-imports -- The desktop entry point is CommonJS. */
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, session, shell } = require("electron");
const { fork } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { createWriteStream, mkdirSync } = require("node:fs");
const { delimiter, join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const title = "MeteorAgent Beta";
const appId = "fun.meteor21c.magent.desktop.beta";
const onWindows = process.platform === "win32";
const onMac = process.platform === "darwin";
const host = "127.0.0.1";
const port = 30341;
const origin = `http://${host}:${port}`;
const webSessionCookie = "pi_web_session";
const nodeRoot = join(process.resourcesPath, "runtime", "node");
const nodeDirectory = onWindows ? nodeRoot : join(nodeRoot, "bin");
const nodeExecutable = join(nodeDirectory, onWindows ? "node.exe" : "node");
const packageDirectory = join(process.resourcesPath, "runtime", "webagent");
const desktopIcon = join(__dirname, "magent-desktop.png");

if (onWindows) app.setAppUserModelId(appId);

const profilePath = app.commandLine.getSwitchValue("user-data-dir");
if (profilePath) {
  mkdirSync(profilePath, { recursive: true, mode: 0o700 });
  app.setPath("userData", profilePath);
}

let mainWindow;
let backend;
let log;
let logPath;
let authenticated = false;
let quitting = false;

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLocal(value) {
  const url = parseUrl(value);
  return url?.protocol === "http:" && url.origin === origin && !url.username && !url.password;
}

function openWebLink(value) {
  const url = parseUrl(value);
  if (url && !url.username && !url.password && !isLocal(url.href) && ["https:", "http:"].includes(url.protocol)) {
    void shell.openExternal(url.href).catch((error) => log?.write(`Open link: ${error.code ?? "failed"}\n`));
  }
}

function protectWindow(window) {
  const { webContents } = window;
  webContents.on("context-menu", (_event, params) => {
    // A page-handled contextmenu (for example the file actions) cancels the
    // Chromium default, so only unhandled requests arrive here.
    if (!params.frame || params.frame !== webContents.mainFrame || !isLocal(params.frame.url)) return;
    const flags = params.editFlags;
    const locale = app.getLocale().toLowerCase();
    const labels = locale.startsWith("zh")
      ? /(?:hant|tw|hk|mo)/.test(locale)
        ? ["復原", "重做", "剪下", "複製", "貼上", "全選"]
        : ["撤销", "重做", "剪切", "复制", "粘贴", "全选"]
      : ["Undo", "Redo", "Cut", "Copy", "Paste", "Select All"];
    const [undo, redo, cut, copy, paste, selectAll] = labels;
    const items = params.isEditable ? [
      { role: "undo", label: undo, enabled: flags.canUndo },
      { role: "redo", label: redo, enabled: flags.canRedo },
      { type: "separator" },
      { role: "cut", label: cut, enabled: flags.canCut },
      { role: "copy", label: copy, enabled: flags.canCopy },
      { role: "paste", label: paste, enabled: flags.canPaste },
      { type: "separator" },
      { role: "selectAll", label: selectAll, enabled: flags.canSelectAll },
    ] : params.selectionText && flags.canCopy ? [{ role: "copy", label: copy }] : [];
    if (items.length) Menu.buildFromTemplate(items).popup({ window, frame: params.frame, x: params.x, y: params.y });
  });
  webContents.on("will-navigate", (event) => {
    if (isLocal(event.url)) return;
    event.preventDefault();
    openWebLink(event.url);
  });
  webContents.on("will-redirect", (event) => {
    if (event.isMainFrame && !isLocal(event.url)) event.preventDefault();
  });
  webContents.on("will-attach-webview", (event) => event.preventDefault());
  webContents.setWindowOpenHandler(({ url, referrer, postBody }) => {
    if (postBody) return { action: "deny" };
    if (!isLocal(referrer.url) && referrer.url !== "") return { action: "deny" };
    if (url === "about:blank") {
      // RelayBrowserLogin opens a blank tab synchronously, then navigates it
      // after it receives the one-time verification link from the relay.
      return { action: "allow", overrideBrowserWindowOptions: { show: false, parent: window } };
    }
    openWebLink(url);
    return { action: "deny" };
  });
  webContents.on("did-create-window", (popup) => {
    const cleanup = setTimeout(() => popup.destroy(), 30_000);
    popup.once("closed", () => clearTimeout(cleanup));
    popup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const redirectLogin = (event) => {
      if (event.url === "about:blank") return;
      event.preventDefault();
      openWebLink(event.url);
      popup.destroy();
    };
    popup.webContents.on("will-navigate", redirectLogin);
    popup.webContents.on("will-redirect", redirectLogin);
  });
}

async function showWindow() {
  if (!authenticated || quitting) return;
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    return;
  }
  const window = new BrowserWindow({
    title,
    icon: desktopIcon,
    width: 1280,
    height: 860,
    minWidth: 680,
    minHeight: 480,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, "preload.cjs"),
    },
  });
  mainWindow = window;
  window.on("closed", () => { mainWindow = undefined; });
  window.on("page-title-updated", (event) => event.preventDefault());
  protectWindow(window);
  await Promise.race([
    window.loadURL(origin),
    delay(15_000, undefined, { ref: false }).then(() => { throw new Error("界面加载超时。"); }),
  ]);
  if (!window.isDestroyed()) window.show();
}

async function authenticateBackend(password) {
  const end = Date.now() + 30_000;
  while (Date.now() < end && backend.exitCode === null && backend.signalCode === null && !quitting) {
    const response = await fetch(`${origin}/api/web-auth`, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(2_000),
    }).catch(() => null);
    const cookie = response?.headers.get("set-cookie")?.match(/^pi_web_session=(v1\.[\da-f.]+);/i);
    if (response?.ok && cookie) {
      await session.defaultSession.cookies.set({
        url: origin,
        name: webSessionCookie,
        value: cookie[1],
        httpOnly: true,
        sameSite: "strict",
        path: "/",
      });
      return;
    }
    await delay(250);
  }
  throw new Error("无法连接本地服务。");
}

function serverEnvironment(password) {
  const env = { ...process.env };
  const pathKey = onWindows ? "Path" : "PATH";
  const inheritedPath = onWindows
    ? Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1]
    : env.PATH;
  if (onWindows) {
    // CreateProcess consumes one case-insensitive PATH variable.
    for (const key of Object.keys(env)) {
      if (key !== pathKey && key.toLowerCase() === "path") delete env[key];
    }
  }
  const systemToolDirectories = onMac ? ["/opt/homebrew/bin", "/usr/local/bin"] : [];
  env[pathKey] = [nodeDirectory, ...systemToolDirectories, inheritedPath].filter(Boolean).join(delimiter);
  return {
    ...env,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    PI_WEB_HOSTNAME: host,
    METEORAGENT_LAUNCH_HOSTNAME: host,
    PI_WEB_PASSWORD: password,
    METEORAGENT_DESKTOP_PLATFORM: onWindows ? "windows-x64" : "macos-arm64",
    PI_WEB_DISABLE_SELF_UPDATE: "1",
    PI_WEB_DISABLE_RESTART: "1",
  };
}

async function startBackend() {
  const password = randomBytes(32).toString("hex");
  logPath = join(app.getPath("userData"), "backend.log");
  log = createWriteStream(logPath, { flags: "a", mode: 0o600 });
  log.on("error", (error) => console.error(error.message));
  backend = fork(join(__dirname, "server.cjs"), ["start", "-H", host, "-p", String(port)], {
    cwd: packageDirectory,
    execPath: nodeExecutable,
    execArgv: [],
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: serverEnvironment(password),
  });
  backend.stdout.pipe(log, { end: false });
  backend.stderr.pipe(log, { end: false });

  // Wait for this child to claim the port before sending its private password.
  await new Promise((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(() => reject(new Error("本地服务启动超时。")), 30_000);
    const onOutput = (chunk) => {
      stdout = (stdout + chunk).slice(-2048);
      if (!/\bReady in\b/.test(stdout)) return;
      clearTimeout(timeout);
      backend.stdout.off("data", onOutput);
      resolve();
    };
    backend.stdout.on("data", onOutput);
    backend.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    backend.once("exit", (code) => {
      clearTimeout(timeout);
      if (quitting) return;
      const error = new Error(`本地服务已退出（${code ?? "已中断"}）。`);
      if (authenticated) reportStartupError(error);
      else reject(error);
    });
  });
  await authenticateBackend(password);
  authenticated = true;
}

function reportStartupError(error) {
  if (quitting) return;
  log?.write(`\n${error.message}\n`);
  dialog.showErrorBox(`${title} 启动失败`, `${error.message}\n\n日志：${logPath ?? app.getPath("userData")}`);
  app.quit();
}

async function start() {
  ipcMain.handle("magent:select-directory", async (event) => {
    const window = mainWindow;
    const frame = event.senderFrame;
    if (!window || window.isDestroyed() || event.sender !== window.webContents
      || !frame || frame !== window.webContents.mainFrame || !isLocal(frame.url)) {
      throw new Error("Folder selection requires the main MeteorAgent window.");
    }
    const selected = await dialog.showOpenDialog(window, { properties: ["openDirectory"] });
    return selected.canceled ? null : selected.filePaths[0] ?? null;
  });
  // HTTP cookies are scoped to a host, so keep this profile's loopback requests
  // on the desktop service's port.
  session.defaultSession.webRequest.onBeforeRequest({ urls: [`http://${host}/*`, `https://${host}/*`] }, (details, done) => {
    done({ cancel: !isLocal(details.url) });
  });
  const permissions = new Set(["clipboard-sanitized-write", "notifications"]);
  session.defaultSession.setPermissionCheckHandler((_, permission, requestingOrigin) => (
    isLocal(requestingOrigin) && permissions.has(permission)
  ));
  session.defaultSession.setPermissionRequestHandler((_, permission, allow, details) => (
    allow(isLocal(details.requestingUrl) && permissions.has(permission))
  ));
  if (onMac) app.setAboutPanelOptions({ applicationName: title, applicationVersion: app.getVersion() });
  const about = onMac ? { role: "about" } : {
    label: `关于 ${title}`,
    click: () => { void dialog.showMessageBox({ message: title, detail: app.getVersion(), icon: nativeImage.createFromPath(desktopIcon) }); },
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: title,
      submenu: [
        about,
        { label: onMac ? "在访达中显示日志" : "在文件资源管理器中显示日志", click: () => shell.showItemInFolder(logPath) },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ]));
  await startBackend();
  await showWindow();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("before-quit", () => {
    quitting = true;
    if (backend?.connected) backend.disconnect();
  });
  app.on("window-all-closed", () => { if (!onMac) app.quit(); });
  app.on("activate", () => { void showWindow().catch(reportStartupError); });
  app.on("second-instance", () => { void showWindow().catch(reportStartupError); });
  void app.whenReady().then(start).catch(reportStartupError);
}
