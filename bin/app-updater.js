#!/usr/bin/env node
"use strict";

/* eslint-disable @typescript-eslint/no-require-imports -- standalone updater must run after its package is replaced */

// This helper is intentionally standalone. The running Next.js process starts
// it detached, then this process owns backup, shutdown, install, rollback, and
// restart so replacing the package cannot terminate the updater itself.
const { appendFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, unlinkSync } = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const { connect } = require("node:net");
const { dirname, join } = require("node:path");
const { homedir } = require("node:os");
const http = require("node:http");

function decodePayload(value) {
  const parsed = JSON.parse(Buffer.from(value || "", "base64url").toString("utf8"));
  const requiredStrings = ["targetVersion", "packagePath", "packageRoot", "hostname", "port", "logPath"];
  if (!parsed || typeof parsed !== "object" || requiredStrings.some((key) => typeof parsed[key] !== "string" || !parsed[key])) {
    throw new Error("Invalid updater payload");
  }
  if (!Number.isSafeInteger(parsed.launcherPid) || parsed.launcherPid <= 1) throw new Error("Invalid launcher pid");
  if (!Number.isSafeInteger(parsed.serverPid) || parsed.serverPid <= 1) throw new Error("Invalid server pid");
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
  appendFileSync(payload.logPath, `[${new Date().toISOString()}] ${message}\n`, { encoding: "utf8", mode: 0o600 });
}

function run(command, args, options = {}) {
  log(`run: ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  if (result.stdout?.trim()) log(result.stdout.trim());
  if (result.stderr?.trim()) log(result.stderr.trim());
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
  return result.stdout?.trim() || "";
}

const registry = "https://registry.npmmirror.com";
const backupDirectory = dirname(payload.packagePath);
let backupPath;
let launchdWasUnloaded = false;

function npmInvocation(args) {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean);
  const npmCli = candidates.find((candidate) => existsSync(candidate));
  if (npmCli) return { command: process.execPath, args: [npmCli, ...args] };
  return { command: process.platform === "win32" ? "npm.cmd" : "npm", args };
}

function runNpm(args) {
  const invocation = npmInvocation(args);
  return run(invocation.command, invocation.args);
}

function packBackup() {
  const raw = runNpm(["pack", payload.packageRoot, "--pack-destination", backupDirectory, "--json", "--ignore-scripts", "--loglevel=error"]);
  const result = JSON.parse(raw);
  const filename = Array.isArray(result) && typeof result[0]?.filename === "string" ? result[0].filename : undefined;
  if (!filename) throw new Error("npm pack did not return a backup filename");
  backupPath = join(backupDirectory, filename);
  if (!existsSync(backupPath)) throw new Error("Updater backup was not created");
  log(`backup: ${backupPath}`);
}

function unloadLaunchAgent() {
  if (process.platform !== "darwin") return;
  const plist = join(homedir(), "Library", "LaunchAgents", "fun.meteor21c.webagent.plist");
  if (!existsSync(plist)) return;
  const domain = `gui/${process.getuid()}`;
  const result = spawnSync("launchctl", ["bootout", domain, plist], { encoding: "utf8" });
  launchdWasUnloaded = result.status === 0;
  log(`launchd bootout: ${result.status}`);
}

function stopOldService() {
  unloadLaunchAgent();
  for (const pid of [payload.launcherPid, payload.serverPid]) {
    try {
      process.kill(pid, "SIGTERM");
      log(`sent SIGTERM to ${pid}`);
    } catch (error) {
      log(`process ${pid} already stopped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function portIsOpen() {
  return new Promise((resolve) => {
    const socket = connect({ host: payload.hostname, port: Number(payload.port) });
    const finish = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPortClosed() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!(await portIsOpen())) return;
    await delay(250);
  }
  throw new Error("Old MeteorAgent service did not stop");
}

function install(packagePath) {
  runNpm([
    "install", "-g", packagePath,
    `--registry=${registry}`,
    "--no-audit", "--no-fund", "--loglevel=error",
  ]);
}

function installedVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(payload.packageRoot, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "";
  } catch {
    return "";
  }
}

function directStart() {
  const entrypoint = join(payload.packageRoot, "bin", "pi-web.js");
  if (!existsSync(entrypoint)) throw new Error("Installed MeteorAgent entrypoint is missing");
  const out = openSync(payload.logPath, "a", 0o600);
  const childEnv = { ...process.env };
  delete childEnv.METEORAGENT_AUTO_UPDATE_CHILD;
  const child = spawn(process.execPath, [
    entrypoint,
    "--no-open",
    "--hostname", payload.hostname,
    "--port", payload.port,
  ], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", out, out],
    env: childEnv,
  });
  child.unref();
  closeSync(out);
  log(`started MeteorAgent pid ${child.pid}`);
}

function restartService() {
  if (process.platform === "darwin" && launchdWasUnloaded) {
    const plist = join(homedir(), "Library", "LaunchAgents", "fun.meteor21c.webagent.plist");
    const domain = `gui/${process.getuid()}`;
    const bootstrap = spawnSync("launchctl", ["bootstrap", domain, plist], { encoding: "utf8" });
    log(`launchd bootstrap: ${bootstrap.status}`);
    if (bootstrap.status === 0) {
      spawnSync("launchctl", ["kickstart", "-k", `${domain}/fun.meteor21c.webagent`], { encoding: "utf8" });
      return;
    }
  }
  directStart();
}

function healthVersion() {
  return new Promise((resolve) => {
    const request = http.get({
      hostname: payload.hostname,
      port: Number(payload.port),
      path: "/api/relay-health",
      timeout: 1_500,
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try {
          const value = JSON.parse(body);
          resolve(value.product === "MeteorAgent" && value.status === "ok" ? value.version || "unknown" : "");
        } catch {
          resolve("");
        }
      });
    });
    request.once("timeout", () => { request.destroy(); resolve(""); });
    request.once("error", () => resolve(""));
  });
}

async function waitForHealthy(expectedVersion, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const version = await healthVersion();
    if (version === expectedVersion) return true;
    await delay(1_000);
  }
  return false;
}

function unlinkIfPresent(path) {
  if (!path || !existsSync(path)) return;
  try { unlinkSync(path); } catch (error) { log(`cleanup failed for ${path}: ${error.message}`); }
}

async function main() {
  log(`starting update to ${payload.targetVersion}`);
  packBackup();
  stopOldService();
  await waitForPortClosed();
  try {
    install(payload.packagePath);
    if (installedVersion() !== payload.targetVersion) throw new Error("Installed version does not match the update manifest");
    restartService();
    if (!(await waitForHealthy(payload.targetVersion))) throw new Error("Updated service did not become healthy");
    log(`update to ${payload.targetVersion} completed`);
    unlinkIfPresent(payload.packagePath);
    unlinkIfPresent(backupPath);
  } catch (error) {
    log(`update failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    try {
      if (backupPath) install(backupPath);
      restartService();
      log("rollback completed");
    } catch (rollbackError) {
      log(`rollback failed: ${rollbackError instanceof Error ? rollbackError.stack || rollbackError.message : String(rollbackError)}`);
    }
    unlinkIfPresent(payload.packagePath);
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  log(`updater stopped before installation: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  unlinkIfPresent(payload.packagePath);
  process.exitCode = 1;
});
