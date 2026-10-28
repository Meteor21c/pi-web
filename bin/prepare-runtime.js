#!/usr/bin/env node
"use strict";

// The SDK publishes its own shrinkwrap, which npm can prefer over our root
// overrides. Use the same locked, audited dependency shipped at the app root.
// Keep the replaced copy as a local backup; never delete directories here.
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function prepareRuntime(packageRoot = path.join(__dirname, "..")) {
  const sdkRoot = path.join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent");
  const app = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  for (const name of ["undici", "brace-expansion"]) {
    const source = path.join(packageRoot, "node_modules", name);
    const expected = app.dependencies[name];
    const installed = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
    if (!/^\d+\.\d+\.\d+$/.test(expected ?? "") || installed.version !== expected) {
      throw new Error(`Cannot prepare SDK ${name}: expected audited root version ${expected}`);
    }
    const target = path.join(sdkRoot, "node_modules", name);
    if (!fs.existsSync(target)) continue; // Normal Node resolution reaches the safe root.
    const current = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"));
    if (current.version === expected) continue;
    const staged = path.join(sdkRoot, "node_modules", `.meteoragent-${name}-${randomUUID()}`);
    fs.cpSync(source, staged, { recursive: true });
    const backupRoot = path.join(packageRoot, "node_modules", ".meteoragent-runtime-backups");
    fs.mkdirSync(backupRoot, { recursive: true });
    const backup = path.join(backupRoot, `${name}-${randomUUID()}`);
    fs.renameSync(target, backup);
    try {
      fs.renameSync(staged, target);
    } catch (error) {
      fs.renameSync(backup, target);
      throw error;
    }
    console.log(`[MeteorAgent] Prepared SDK ${name} ${expected}`);
  }
}

module.exports = { prepareRuntime };
if (require.main === module) prepareRuntime();
