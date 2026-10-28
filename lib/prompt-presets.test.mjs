import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, getSystemMessageText } from "@earendil-works/pi-ai";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const store = await jiti.import("./prompt-preset-store.ts");
const { promptSelectionFromSettings, readSessionPromptSelection, PROMPT_SELECTION_TYPE } = await jiti.import("./prompt-presets.ts");
const preset = { id: "concise", name: "简洁中文", content: "请用中文回答。Preserve pi literally." };

test("editing and deleting presets preserve conversation snapshots and corrupt files", () => {
  const path = join(mkdtempSync(join(tmpdir(), "magent-preset-test-")), "presets.json");
  try {
    store.updatePromptPresetSettings({ type: "save", preset }, path);
    store.updatePromptPresetSettings({ type: "select", selectedPresetId: preset.id, mode: "goal" }, path);
    const snapshot = promptSelectionFromSettings(store.readPromptPresetSettings(path));
    const entries = [{ type: "custom", customType: PROMPT_SELECTION_TYPE, data: structuredClone(snapshot) }];
    store.updatePromptPresetSettings({ type: "save", preset: { ...preset, content: "CHANGED" } }, path);
    store.updatePromptPresetSettings({ type: "delete", id: preset.id }, path);
    assert.equal(store.readPromptPresetSettings(path).selectedPresetId, null);
    assert.equal(readSessionPromptSelection(entries).preset.content, preset.content);
    assert.equal(readSessionPromptSelection(entries).mode, "goal");
    assert.equal(readSessionPromptSelection([]), undefined);
    writeFileSync(path, "{");
    assert.throws(() => store.updatePromptPresetSettings({ type: "save", preset }, path));
    assert.equal(readFileSync(path, "utf8"), "{");
  } finally {
    unlinkSync(path);
  }
});

for (const mode of ["plan", "goal"]) {
  test(`${mode} mode projects instructions on every provider call and enforces tool execution`, async () => {
    let executed = 0;
    let calls = 0;
    const captures = [];
    const tools = ["read", "write"].map((name) => ({
      name, label: name, description: name,
      parameters: { type: "object", properties: {}, required: [] },
      execute: async () => {
        executed += 1;
        return { content: [{ type: "text", text: "tool result" }] };
      },
    }));
    const agent = new Agent({
      initialState: { systemPrompt: "BASE RULES", tools, model: { id: "mock", provider: "test", api: "test" }, thinkingLevel: "off" },
      streamFn: (_model, context) => {
        captures.push(structuredClone(context.messages));
        const toolTurn = calls++ % 2 === 0;
        const message = {
          role: "assistant",
          content: toolTurn ? [{ type: "toolCall", id: `call-${calls}`, name: "write", arguments: {} }] : [{ type: "text", text: "Done" }],
          api: "test", provider: "test", model: "mock",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: toolTurn ? "toolUse" : "stop", timestamp: Date.now(),
        };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => stream.push({ type: "done", reason: message.stopReason, message }));
        return stream;
      },
    });
    const wrapper = new AgentSessionWrapper({ agent, dispose() {} }, { promptSelection: { version: 1, mode, preset } });
    try {
      await agent.prompt("Complete this simulated task.");
      agent.reset();
      await agent.prompt("After context reset, complete another simulated task.");
      assert.equal(captures.length, 4);
      for (const messages of captures) {
        const system = messages.filter((message) => message.role === "system").map(getSystemMessageText).join("\n");
        assert.match(system, /BASE RULES/);
        assert.equal(system.split(preset.content).length - 1, 1);
        assert.match(system, mode === "plan" ? /Plan mode/ : /Goal mode/);
        const names = messages.filter((message) => message.role === "system").flatMap((message) => message.toolsAdded ?? []).map((tool) => tool.name);
        assert.equal(names.includes("write"), mode !== "plan");
      }
      assert.equal(executed, mode === "plan" ? 0 : 2);
      if (mode === "plan") {
        await assert.rejects(wrapper.send({ type: "bash", command: "echo forbidden" }), /计划模式/);
      }
    } finally {
      wrapper.destroy();
    }
  });
}
