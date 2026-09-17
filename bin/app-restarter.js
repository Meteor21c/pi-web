#!/usr/bin/env node
"use strict";

/* eslint-disable @typescript-eslint/no-require-imports -- standalone helper survives the service it restarts */

// This process is started detached by the running Next.js server. It must not
// import the application package: the package is about to be stopped, and on
// Windows killing the launcher process can otherwise take this helper down too.
const { appendFileSync, closeSync, existsSync, mkdirSync, openSync } = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const { connect } = require("node:net");
const { dirname, isAbsolute, join } = require("node:path");
const { homedir } = require("node:os");
const http = require("node:http");

function decodePayload(value) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(value || "", "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid restart payload");
  }
  const requiredStrings = ["packageRoot", "hostname", "port", "logPath"];
  if (!parsed || typeof parsed !== "object" || requiredStrings.some((key) => typeof parsed[key] !== "string" || !parsed[key])) {
    throw new Error("Invalid restart payload");
  }
  if (!isAbsolute(parsed.packageRoot) || !isAbsolute(parsed.logPath)) throw new Error("Invalid restart paths");
  if (!Number.isSafeInteger(parsed.launcherPid) || parsed.launcherPid <= 1) throw new Error("Invalid launcher pid");
  if (!Number.isSafeInteger(parsed.serverPid) || parsed.serverPid <= 1) throw new Error("Invalid server pid");
  if (!/^\d{1,5}$/.test(parsed.port) || Number(parsed.port) < 1 || Number(parsed.port) > 65535) throw new Error("Invalid server port");
  if (!existsSync(join(parsed.packageRoot, "bin", "pi-web.js"))) throw new Error("Installed MeteorAgent entrypoint is missing");
  return parsed;
}

let payload;
try {
  payload = decodePayload(process.argv[2]);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

mkdirSync(dirname(payload.logPath), { recursive: true, mode: 0o700 });
function log(message) {
  try {
    appendFileSync(payload.logPath, `[${new Date().toISOString()}] ${message}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Logging must never prevent the service from restarting.
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probeHostname() {
  return payload.hostname === "0.0.0.0" || payload.hostname === "::" || payload.hostname === "[::]"
    ? "127.0.0.1"
    : payload.hostname;
}

function portIsOpen() {
  return new Promise((resolve) => {
    const socket = connect({ host: probeHostname(), port: Number(payload.port) });
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function waitForPortClosed() {
  for (let attempt = 0; attempt < 48; attempt += 1) {
    if (!(await portIsOpen())) return;
    await delay(250);
  }
  throw new Error("旧的 MeteorAgent 服务未能退出");
}

function unloadLaunchAgent() {
  if (process.platform !== "darwin") return false;
  const plist = join(homedir(), "Library", "LaunchAgents", "fun.meteor21c.webagent.plist");
  if (!existsSync(plist)) return false;
  const domain = `gui/${process.getuid()}`;
  const result = spawnSync("launchctl", ["bootout", domain, plist], { encoding: "utf8" });
  log(`launchd bootout: ${result.status}`);
  return result.status === 0;
}

function stopProcessTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  if (process.platform === "win32") {
    const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true,
    });
    log(`taskkill ${pid}: ${result.status}`);
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    log(`sent SIGTERM to ${pid}`);
  } catch (error) {
    log(`process ${pid} already stopped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function stopOldService() {
  const launchdWasUnloaded = unloadLaunchAgent();
  // The launcher forwards SIGTERM to its Next child on POSIX. The explicit
  // server PID is still included for crash/partial-start cases. On Windows a
  // taskkill tree handles both the launcher and its child reliably.
  const pids = [...new Set([payload.launcherPid, payload.serverPid])];
  for (const pid of pids) stopProcessTree(pid);
  return launchdWasUnloaded;
}

function directStart() {
  const entrypoint = join(payload.packageRoot, "bin", "pi-web.js");
  const output = openSync(payload.logPath, "a", 0o600);
  const child = spawn(process.execPath, [
    entrypoint,
    "--no-open",
    "--hostname", payload.hostname,
    "--port", payload.port,
  ], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", output, output],
    env: {
      ...process.env,
      METEORAGENT_AUTO_UPDATE: "1",
      METEORAGENT_PACKAGE_ROOT: payload.packageRoot,
      METEORAGENT_LAUNCH_HOSTNAME: payload.hostname,
      METEORAGENT_LAUNCH_PORT: payload.port,
    },
  });
  child.unref();
  closeSync(output);
  log(`started MeteorAgent launcher ${child.pid}`);
}

function restartService(launchdWasUnloaded) {
  if (process.platform === "darwin" && launchdWasUnloaded) {
    const plist = join(homedir(), "Library", "LaunchAgents", "fun.meteor21c.webagent.plist");
    const domain = `gui/${process.getuid()}`;
    const bootstrap = spawnSync("launchctl", ["bootstrap", domain, plist], { encoding: "utf8" });
    log(`launchd bootstrap: ${bootstrap.status}`);
    if (bootstrap.status === 0) {
      const kickstart = spawnSync("launchctl", ["kickstart", "-k", `${domain}/fun.meteor21c.webagent`], { encoding: "utf8" });
      log(`launchd kickstart: ${kickstart.status}`);
      return;
    }
  }
  directStart();
}

function serviceIsHealthy() {
  return new Promise((resolve) => {
    const request = http.get({
      hostname: probeHostname(),
      port: Number(payload.port),
      path: "/api/relay-health?restart=1",
      timeout: 1_500,
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try {
          const value = JSON.parse(body);
          resolve(value.product === "MeteorAgent" && value.status === "ok");
        } catch {
          resolve(false);
        }
      });
    });
    request.once("timeout", () => { request.destroy(); resolve(false); });
    request.once("error", () => resolve(false));
  });
}

async function waitForHealthy() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (await serviceIsHealthy()) return true;
    await delay(1_000);
  }
  return false;
}

async function main() {
  // The manager delays launch before calling this helper; this extra pause
  // protects slow clients whose POST response is still being flushed.
  await delay(350);
  log("starting local service restart");
  const launchdWasUnloaded = stopOldService();
  await waitForPortClosed();
  restartService(launchdWasUnloaded);
  if (!(await waitForHealthy())) {
    log("MeteorAgent did not become healthy after restart");
    process.exitCode = 1;
    return;
  }
  log("local service restart completed");
}

void main().catch((error) => {
  log(`restart failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exitCode = 1;
});
