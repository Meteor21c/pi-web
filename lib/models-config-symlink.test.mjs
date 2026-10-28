import assert from "node:assert/strict";
import test from "node:test";
import { lstatSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { writeModelsConfig } = await jiti.import("./models-config-store.ts");

test("saving models writes through a symlink and refuses a dangling link", () => {
  const root = mkdtempSync(join(tmpdir(), "magent-model-link-"));
  const target = join(root, "target.json");
  const link = join(root, "models.json");
  const dangling = join(root, "dangling.json");
  writeFileSync(target, '{"providers":{}}');
  symlinkSync(target, link);
  symlinkSync(join(root, "missing.json"), dangling);
  try {
    const value = { providers: { test: { models: [{ id: "example" }] } } };
    writeModelsConfig(value, link);
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), value);
    assert.throws(() => writeModelsConfig(value, dangling), /dangling symbolic link/);
    assert.equal(lstatSync(dangling).isSymbolicLink(), true);
  } finally {
    unlinkSync(link);
    unlinkSync(dangling);
    unlinkSync(target);
  }
});
