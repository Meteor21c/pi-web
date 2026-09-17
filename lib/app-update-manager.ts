import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import type { AppUpdateInstallStatus } from "./api-types";
import { isNewerStableVersion, parseAppUpdateManifest, type AppUpdateManifest } from "./app-update";
import { getRunningRpcSessionIds } from "./rpc-manager";
import packageJson from "../package.json";

const CURRENT_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? packageJson.version;
const MANIFEST_URL = "https://dl.meteor21c.fun/webagent/latest.json";
const DOWNLOAD_BASE_URL = "https://dl.meteor21c.fun/webagent/";
const FETCH_TIMEOUT_MS = 5_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

interface UpdateStore {
  state: Omit<AppUpdateInstallStatus, "automaticUpdateSupported" | "runningSessionIds">;
  task?: Promise<void>;
}

declare global {
  var __meteorAgentUpdateStore: UpdateStore | undefined;
}

function store(): UpdateStore {
  return globalThis.__meteorAgentUpdateStore ??= {
    state: { phase: "idle", downloadedBytes: 0 },
  };
}

function setState(next: UpdateStore["state"]): void {
  store().state = next;
}

function updateState(patch: Partial<UpdateStore["state"]>): void {
  store().state = { ...store().state, ...patch };
}

function launcherPid(): number | undefined {
  const value = Number(process.env.METEORAGENT_LAUNCHER_PID);
  return Number.isSafeInteger(value) && value > 1 ? value : undefined;
}

export function automaticAppUpdateSupported(): boolean {
  if (process.env.PI_WEB_DISABLE_SELF_UPDATE === "1") return false;
  const root = process.env.METEORAGENT_PACKAGE_ROOT;
  return process.env.METEORAGENT_AUTO_UPDATE === "1"
    && Boolean(launcherPid())
    && typeof root === "string"
    && existsSync(join(root, "bin", "app-updater.js"));
}

export function getAppUpdateInstallStatus(): AppUpdateInstallStatus {
  return {
    ...store().state,
    automaticUpdateSupported: automaticAppUpdateSupported(),
    runningSessionIds: getRunningRpcSessionIds(),
  };
}

async function fetchManifest(): Promise<AppUpdateManifest> {
  const response = await fetch(MANIFEST_URL, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`更新服务器返回 HTTP ${response.status}`);
  const manifest = parseAppUpdateManifest(await response.json());
  if (!manifest) throw new Error("更新清单格式或签名信息无效");
  return manifest;
}

async function downloadAndVerify(manifest: AppUpdateManifest): Promise<string> {
  const target = join(tmpdir(), `meteoragent-update-${manifest.version}-${randomUUID()}.tgz`);
  const response = await fetch(new URL(manifest.artifact, DOWNLOAD_BASE_URL), {
    cache: "no-store",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) throw new Error(`安装包下载失败：HTTP ${response.status}`);
  const advertisedLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertisedLength) && advertisedLength > 0 && advertisedLength !== manifest.bytes) {
    throw new Error("安装包大小与更新清单不一致");
  }

  const file = await open(target, "wx", 0o600);
  const hash = createHash("sha256");
  let downloadedBytes = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      downloadedBytes += value.byteLength;
      if (downloadedBytes > manifest.bytes) throw new Error("安装包超过更新清单声明的大小");
      hash.update(value);
      await file.write(value);
      updateState({ downloadedBytes });
    }
  } catch (error) {
    await file.close().catch(() => {});
    await unlink(target).catch(() => {});
    throw error;
  }
  await file.close();
  if (downloadedBytes !== manifest.bytes || hash.digest("hex") !== manifest.sha256) {
    await unlink(target).catch(() => {});
    throw new Error("安装包 SHA-256 校验失败，更新已取消");
  }
  return target;
}

function updateLogPath(): string {
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, "MeteorAgent", "logs", "update.log");
  }
  if (process.platform === "darwin") return join(homedir(), "Library", "Logs", "MeteorAgent", "update.log");
  return join(homedir(), ".pi", "agent", "update.log");
}

function launchUpdater(packagePath: string, manifest: AppUpdateManifest): void {
  const packageRoot = process.env.METEORAGENT_PACKAGE_ROOT!;
  const helper = join(packageRoot, "bin", "app-updater.js");
  const logPath = updateLogPath();
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  const payload = {
    targetVersion: manifest.version,
    packagePath,
    packageRoot,
    launcherPid: launcherPid(),
    serverPid: process.pid,
    hostname: process.env.METEORAGENT_LAUNCH_HOSTNAME || "127.0.0.1",
    port: process.env.METEORAGENT_LAUNCH_PORT || "30141",
    logPath,
  };
  const child = spawn(process.execPath, [helper, Buffer.from(JSON.stringify(payload)).toString("base64url")], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, METEORAGENT_AUTO_UPDATE_CHILD: "1" },
  });
  child.once("error", (error) => {
    setState({
      phase: "error",
      targetVersion: manifest.version,
      downloadedBytes: manifest.bytes,
      totalBytes: manifest.bytes,
      message: `无法启动更新程序：${error.message}`,
    });
  });
  child.unref();
}

async function runUpdate(targetVersion: string): Promise<void> {
  let downloadedPath: string | undefined;
  try {
    const manifest = await fetchManifest();
    if (manifest.version !== targetVersion || !isNewerStableVersion(manifest.version, CURRENT_VERSION)) {
      throw new Error("目标版本已变化，请重新检查更新");
    }
    updateState({ totalBytes: manifest.bytes });
    downloadedPath = await downloadAndVerify(manifest);
    setState({
      phase: "verifying",
      targetVersion,
      downloadedBytes: manifest.bytes,
      totalBytes: manifest.bytes,
      message: "安装包校验通过",
    });
    if (getRunningRpcSessionIds().length > 0) {
      throw new Error("下载期间有任务开始运行，请等待任务结束后重试更新");
    }
    setState({
      phase: "preparing-restart",
      targetVersion,
      downloadedBytes: manifest.bytes,
      totalBytes: manifest.bytes,
      message: "正在交给独立更新程序，服务即将重启",
    });
    const finalPath = downloadedPath;
    downloadedPath = undefined;
    setTimeout(() => launchUpdater(finalPath, manifest), 1_000).unref();
  } catch (error) {
    if (downloadedPath) await unlink(downloadedPath).catch(() => {});
    setState({
      phase: "error",
      targetVersion,
      downloadedBytes: store().state.downloadedBytes,
      totalBytes: store().state.totalBytes,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function startAutomaticAppUpdate(targetVersion: string): AppUpdateInstallStatus {
  if (!automaticAppUpdateSupported()) throw new Error("当前启动方式不支持应用内更新，请下载新版启动器");
  if (!isNewerStableVersion(targetVersion, CURRENT_VERSION)) throw new Error("目标版本不是可安装的新版本");
  const runningSessionIds = getRunningRpcSessionIds();
  if (runningSessionIds.length > 0) throw new Error("仍有任务正在运行，请等待任务结束后再更新");
  const current = store();
  if (current.task) return getAppUpdateInstallStatus();
  if (current.state.phase !== "idle" && current.state.phase !== "error") {
    return getAppUpdateInstallStatus();
  }
  setState({ phase: "downloading", targetVersion, downloadedBytes: 0, message: "正在下载安装包" });
  current.task = runUpdate(targetVersion).finally(() => {
    current.task = undefined;
  });
  return getAppUpdateInstallStatus();
}
