import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const onboarding = readFileSync(new URL("./RelayOnboarding.tsx", import.meta.url), "utf8");
const gate = readFileSync(new URL("./AuthGate.tsx", import.meta.url), "utf8");

test("successful relay sync enters the workspace without a completion page", () => {
  assert.match(onboarding, /body\.ok && \(body\.totalModelCount \?\? 0\) > 0[\s\S]*?onSuccess\(\)/);
  assert.doesNotMatch(onboarding, /phase === "done"/);
  assert.doesNotMatch(onboarding, /workspace\.getStarted/);
});

test("the authentication gate no longer duplicates account settings", () => {
  assert.match(gate, /<RelayOnboarding key=\{generation\} onSuccess=\{enterWorkspace\} \/>/);
  assert.doesNotMatch(gate, /RelayAccountSettings/);
});
