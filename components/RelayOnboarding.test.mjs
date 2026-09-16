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
  // v5: AuthGate 还接入 onPhaseChange，把 busy 阶段切到 BootSplash 品牌启动屏。
  assert.match(gate, /<RelayOnboarding key=\{generation\} onSuccess=\{enterWorkspace\} onPhaseChange=\{setOnboardingPhase\} \/>/);
  assert.doesNotMatch(gate, /RelayAccountSettings/);
});
