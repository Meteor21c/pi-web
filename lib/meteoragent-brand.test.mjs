import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { rebrandMeteorAgentSystemPrompt } = await jiti.import("./meteoragent-brand.ts");

test("rebrands the SDK default prompt and hides upstream documentation branding", () => {
  const prompt = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Guidelines:
- Inspect PI_* environment variables for current model and session details.

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: /runtime/node_modules/@earendil-works/pi-coding-agent/README.md
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)

Current working directory: /workspace`;
  const branded = rebrandMeteorAgentSystemPrompt(prompt);
  assert.match(branded, /^You are Magent, the expert coding assistant inside MeteorAgent\./);
  assert.match(branded, /Inspect the runtime state/);
  assert.doesNotMatch(branded, /Pi documentation|inside pi|pi-coding-agent/);
  assert.match(branded, /Current working directory/);
});

test("does not rewrite a user-authored system prompt", () => {
  const custom = "Use pi as the mathematical constant in every answer.";
  assert.equal(rebrandMeteorAgentSystemPrompt(custom), custom);
});

test("cleans upstream documentation left in an already branded default prompt", () => {
  const prompt = `You are Magent, the expert coding assistant inside MeteorAgent. You help users by reading files, executing commands, editing code, and writing new files.

Guidelines:
- You can inspect PI_* environment variables for current model and session details.

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: /runtime/node_modules/@earendil-works/pi-coding-agent/README.md
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)

Current working directory: /workspace`;
  const branded = rebrandMeteorAgentSystemPrompt(prompt);
  assert.match(branded, /^You are Magent, the expert coding assistant inside MeteorAgent\./);
  assert.match(branded, /Inspect the runtime state/);
  assert.doesNotMatch(branded, /Pi documentation|PI_\*|pi-coding-agent/);
  assert.match(branded, /Current working directory/);
});
