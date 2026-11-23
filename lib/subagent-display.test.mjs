import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getSubagentDisplayName } = await jiti.import("./subagent-display.ts");
const { zhCNLocale } = await jiti.import("./i18n/messages/zh-CN.ts");
const t = (key) => zhCNLocale.messages[key];

test("subagent names use the task label and strip legacy identifiers", () => {
  assert.equal(getSubagentDisplayName({ description: "审查登录流程", profile: "explore" }, t), "审查登录流程");
  assert.equal(getSubagentDisplayName({ description: "pi-web: 验证构建" }, t), "验证构建");
  assert.equal(getSubagentDisplayName({ description: "Review workspace layout" }, t), "Review workspace layout");
});

test("subagent names fall back to localized built-in profiles and a generic name", () => {
  assert.equal(getSubagentDisplayName({ description: "General purpose" }, t), "通用任务");
  assert.equal(getSubagentDisplayName({ description: "pi-web:subagent-notification", profile: "explore" }, t), "代码调研");
  assert.equal(getSubagentDisplayName({ name: "Pi-Web:subagent-notification" }, t), "子智能体");
});
