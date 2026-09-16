import type { InlineExtension } from "@earendil-works/pi-coding-agent";

export const METEORAGENT_NAME = "MeteorAgent";
export const METEORAGENT_SHORT_NAME = "Magent";

const UPSTREAM_DOCS_BLOCK = /\n\nPi documentation \(read only[\s\S]*?- Always read pi \.md files completely and follow links to related docs \(e\.g\., tui\.md for TUI API details\)/;
const UPSTREAM_PROMPT_SIGNATURE = "You are an expert coding assistant operating inside pi, a coding agent harness.";
const METEORAGENT_PROMPT_SIGNATURE = "You are Magent, the expert coding assistant inside MeteorAgent.";

/** Rebrand only the SDK-owned default prompt; user instructions are untouched. */
export function rebrandMeteorAgentSystemPrompt(prompt: string): string {
  if (!prompt.includes(UPSTREAM_PROMPT_SIGNATURE) && !prompt.includes(METEORAGENT_PROMPT_SIGNATURE)) {
    return prompt;
  }
  return prompt
    .replace(
      "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
      "You are Magent, the expert coding assistant inside MeteorAgent. You help users by reading files, executing commands, editing code, and writing new files.",
    )
    .replace(UPSTREAM_DOCS_BLOCK, "")
    .replace(/(?:You can inspect|Inspect) PI_\* environment variables for current model and session details\.?/g, "Inspect the runtime state for current model and session details.")
    .replace(/(?<![/@._-])\bpi\b(?![/._*-])/gi, METEORAGENT_NAME);
}

/** Runs after the built-in extensions so the prompt shown in System is branded too. */
export function createMeteorAgentBrandExtension(): InlineExtension {
  return {
    name: "meteoragent-brand",
    hidden: true,
    factory: (runtime) => {
      runtime.on("before_agent_start", async (event) => ({
        systemPrompt: rebrandMeteorAgentSystemPrompt(event.systemPrompt),
      }));
    },
  };
}
