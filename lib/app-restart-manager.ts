import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import type { AppRestartStatus } from "./api-types";
import { getRunningRpcSessionIds } from "./rpc-manager";

/**
 * Restarting is deliberately owned by a detached helper. The Next.js process
 * cannot safely stop and start its own launcher: on Windows it would leave a
 * child process behind, and on macOS launchd could immediately bring the old
 * process back. The helper therefore survives the shutdown and starts the
 * exact same installed entrypoint again.
 */

type RestartStore = {
  state: Omit<AppRestartStatus, "automaticRestartSupported" | "runningSessionIds">;
  task?: Promise<void>;
};

declare global {
  var __meteorAgentRestartStore: RestartStore | undefined;
}

function store(): RestartStore {
  return globalThis.__meteorAgentRestartStore ??= {
    state: { phase: "idle" },
  };
}

function setState(next: RestartStore["state"]): void {
  store().state = next;
}

function launcherPid(): number | undefined {
  const value = Number(process.env.METEORAGENT_LAUNCHER_PID);
  return Number.isSafeInteger(value) && value > 1 ? value : undefined;
}

/**
 * A plain `next start` process must not be allowed to kill itself from an HTTP
 * request. The packaged launcher sets these values for every production run;
 * development mode therefore exposes a disabled button instead of a risky
 * best-effort restart.
 */
export function automaticRestartSupported(): boolean {
  if (process.env.PI_WEB_DISABLE_RESTART === "1") return false;
  const root = process.env.METEORAGENT_PACKAGE_ROOT;
  return process.env.METEORAGENT_AUTO_UPDATE === "1"
    && Boolean(launcherPid())
    && typeof root === "string"
    && existsSync(join(root, "bin", "app-restarter.js"));
}

export function getAppRestartStatus(): AppRestartStatus {
  return {
    ...store().state,
    automaticRestartSupported: automaticRestartSupported(),
    runningSessionIds: getRunningRpcSessionIds(),
  };
}

function restartLogPath(): string {
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, "MeteorAgent", "logs", "restart.log");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Logs", "MeteorAgent", "restart.log");
  }
  return join(homedir(), ".pi", "agent", "restart.log");
}

function launchRestarter(): void {
  const packageRoot = process.env.METEORAGENT_PACKAGE_ROOT;
  const pid = launcherPid();
  if (!packageRoot || !pid) throw new Error("当前启动方式不支持本地重启，请使用 MeteorAgent 启动器启动");

  const helper = join(packageRoot, "bin", "app-restarter.js");
  if (!existsSync(helper)) throw new Error("本地重启程序缺失，请重新安装 MeteorAgent");

  const logPath = restartLogPath();
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  const payload = {
    packageRoot,
    launcherPid: pid,
    serverPid: process.pid,
    hostname: process.env.METEORAGENT_LAUNCH_HOSTNAME || process.env.PI_WEB_HOSTNAME || "127.0.0.1",
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
    setState({ phase: "error", message: `无法启动重启程序：${error.message}` });
  });
  child.unref();
}

async function scheduleRestart(): Promise<void> {
  // Give the HTTP response time to reach the browser before the server is
  // terminated. The helper itself waits again before sending any signal.
  await new Promise<void>((resolve) => setTimeout(resolve, 650));
  try {
    launchRestarter();
    // If the detached helper cannot stop the old process, this process would
    // otherwise advertise "preparing" forever and reject every retry. A
    // timeout only affects the current process; a successful restart replaces
    // it before the timer can fire.
    const timeout = setTimeout(() => {
      if (store().state.phase === "preparing-restart") {
        setState({ phase: "error", message: "重启程序未能在预期时间内恢复服务" });
      }
    }, 120_000);
    timeout.unref();
  } catch (error) {
    setState({
      phase: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function startLocalServiceRestart(): AppRestartStatus {
  if (!automaticRestartSupported()) {
    throw new Error("当前启动方式不支持本地重启，请使用 MeteorAgent 启动器启动");
  }

  const runningSessionIds = getRunningRpcSessionIds();
  if (runningSessionIds.length > 0) {
    throw new Error("仍有任务正在运行，请等待任务结束后再重启");
  }

  const current = store();
  if (current.task) return getAppRestartStatus();
  if (current.state.phase !== "idle" && current.state.phase !== "error") {
    return getAppRestartStatus();
  }

  setState({ phase: "preparing-restart", message: "正在准备重启本地服务" });
  current.task = scheduleRestart().finally(() => {
    current.task = undefined;
  });
  return getAppRestartStatus();
}
