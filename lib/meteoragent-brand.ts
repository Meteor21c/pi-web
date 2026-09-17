import type { InlineExtension } from "@earendil-works/pi-coding-agent";

export const METEORAGENT_NAME = "MeteorAgent";
export const METEORAGENT_SHORT_NAME = "Magent";
/** Public download page used by relay onboarding and in-product cross-promo links. */
export const METEORAGENT_DOWNLOAD_URL = "https://dl.meteor21c.fun";

const UPSTREAM_DOCS_BLOCK = /\n\n[A-Z][a-z] documentation \(read only[\s\S]*?- Always read [a-z]+ \.md files completely and follow links to related docs \(e\.g\., tui\.md for TUI API details\)/;
const UPSTREAM_PROMPT_SIGNATURE = /^You are an expert coding assistant operating inside [a-z]+, a coding agent harness\./;
const UPSTREAM_PROMPT_INTRO = /^You are an expert coding assistant operating inside [a-z]+, a coding agent harness\. You help users by reading files, executing commands, editing code, and writing new files\./;
const METEORAGENT_PROMPT_SIGNATURE = "You are Magent, the expert coding assistant inside MeteorAgent.";

/** Rebrand only the SDK-owned default prompt; user instructions are untouched. */
export function rebrandMeteorAgentSystemPrompt(prompt: string): string {
  if (!UPSTREAM_PROMPT_SIGNATURE.test(prompt) && !prompt.includes(METEORAGENT_PROMPT_SIGNATURE)) {
    return prompt;
  }
  return prompt
    .replace(
      UPSTREAM_PROMPT_INTRO,
      "You are Magent, the expert coding assistant inside MeteorAgent. You help users by reading files, executing commands, editing code, and writing new files.",
    )
    .replace(UPSTREAM_DOCS_BLOCK, "")
    .replace(/(?:You can inspect|Inspect) PI_\* environment variables for current model and session details\.?/g, "Inspect the runtime state for current model and session details.")
    .replace(/(?<![/@._-])\bpi\b(?![/._*-])/gi, METEORAGENT_NAME);
}

/** Also sanitize state returned by a wrapper created before a dev-server hot reload. */
export function rebrandMeteorAgentState<T>(state: T): T {
  if (!state || typeof state !== "object" || Array.isArray(state)) return state;
  const record = state as Record<string, unknown>;
  if (typeof record.systemPrompt !== "string") return state;
  const systemPrompt = rebrandMeteorAgentSystemPrompt(record.systemPrompt);
  if (systemPrompt === record.systemPrompt) return state;
  return { ...record, systemPrompt } as T;
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
