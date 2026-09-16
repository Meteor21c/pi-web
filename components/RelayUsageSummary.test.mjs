import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const usageSource = readFileSync(new URL("./RelayUsageSummary.tsx", import.meta.url), "utf8");
const modelsSource = readFileSync(new URL("./ModelsConfig.tsx", import.meta.url), "utf8");

test("group usage hides the duplicate account wallet", () => {
  assert.match(usageSource, /showBalance = true/);
  assert.match(usageSource, /\{showBalance && <div/);
  assert.match(modelsSource, /<RelayUsageSummary providerId=\{group\.providerId\} enabled showBalance=\{false\} \/>/);
});

test("usage cards keep sub-cent upstream charges visible", () => {
  assert.match(usageSource, /formatUsdPrecise/);
  assert.doesNotMatch(usageSource, /value\)\.toFixed\(2\)/);
});
