import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { prepareRuntime } = require("../bin/prepare-runtime.js");

test("SDK shrinkwrapped dependencies resolve to the audited root versions after installation", () => {
  const root = mkdtempSync(join(tmpdir(), "magent-runtime-test-"));
  const dependencies = { undici: "8.12.3", "brace-expansion": "5.0.12" };
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies }));
  const sdk = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(sdk, { recursive: true });
  writeFileSync(join(sdk, "index.js"), "");
  for (const [name, version] of Object.entries(dependencies)) {
    for (const [folder, value] of [[join(root, "node_modules", name), version], [join(sdk, "node_modules", name), "0.0.1"]]) {
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "package.json"), JSON.stringify({ name, version: value }));
    }
  }
  prepareRuntime(root);
  const sdkRequire = createRequire(join(sdk, "index.js"));
  for (const [name, version] of Object.entries(dependencies)) {
    assert.equal(sdkRequire(`${name}/package.json`).version, version);
  }
  const backup = join(root, "node_modules", ".meteoragent-runtime-backups");
  assert.equal(readdirSync(backup).length, 2);
  prepareRuntime(root);
  assert.equal(readdirSync(backup).length, 2);
  writeFileSync(join(root, "node_modules", "undici", "package.json"), '{"version":"0.0.0"}');
  assert.throws(() => prepareRuntime(root), /expected audited root version/);
  assert.equal(JSON.parse(readFileSync(join(sdk, "node_modules", "undici", "package.json"))).version, "8.12.3");
});
