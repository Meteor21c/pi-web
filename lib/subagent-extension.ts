import { Type } from "typebox";
import {
  defineTool,
  type ExtensionContext,
  type InlineExtension,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import {
  SUBAGENT_CONTROL_TOOL_NAMES,
  type SubagentProfile,
  type SubagentRunInfo,
} from "./subagents";
import { MAX_SUBAGENT_INPUT_FILES } from "./subagent-input";
import { waitForSubagent } from "./subagent-task";

export const HOST_SUBAGENT_EXTENSION_NAME = "pi-web-subagents";
const HOST_SUBAGENT_EXTENSION_PATH = `<inline:${HOST_SUBAGENT_EXTENSION_NAME}>`;
const SUBAGENT_TOOL_NAMES = new Set<string>(SUBAGENT_CONTROL_TOOL_NAMES);
const LEGACY_SUBAGENT_PACKAGE_NAME = "pi-subagents";

export interface SubagentToolDetails {
  kind: "pi-web-subagent";
  sessionId: string;
  parentToolCallId?: string;
  profile: string;
  description: string;
  status: SubagentRunInfo["status"];
  runInBackground: boolean;
  createdAt: string;
  completedAt?: string;
  error?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeCleanupError?: string;
}

export interface StartSubagentRequest {
  parentContext: ExtensionContext;
  parentToolCallId: string;
  profile?: string;
  task: string;
  inputFiles?: string[];
  description: string;
  runInBackground?: boolean;
  model?: string;
  thinking?: string;
  maxTurns?: number;
  inheritContext?: boolean;
  isolation?: "worktree";
  signal?: AbortSignal;
  onUpdate?: (run: SubagentRunInfo) => void;
}

export interface ResumeSubagentRequest {
  parentContext: ExtensionContext;
  parentToolCallId: string;
  sessionId: string;
  task: string;
  description: string;
  runInBackground?: boolean;
  signal?: AbortSignal;
  onUpdate?: (run: SubagentRunInfo) => void;
}

export interface SubagentExecution {
  run: SubagentRunInfo;
  completion: Promise<SubagentRunInfo>;
  ownedByTask: boolean;
}

export interface SubagentExtensionRuntime {
  start(request: StartSubagentRequest): Promise<SubagentExecution>;
  resume(request: ResumeSubagentRequest): Promise<SubagentExecution>;
  get(sessionId: string, parentSessionId?: string, wait?: { signal?: AbortSignal }): Promise<SubagentRunInfo | null>;
  steer(sessionId: string, message: string, parentSessionId?: string): Promise<void>;
  notifyParent(run: SubagentRunInfo): Promise<void>;
}

export type SubagentProfileProvider = () => readonly SubagentProfile[];
export type SubagentEnabledProvider = () => boolean;

function agentTypeDescription(profiles: readonly SubagentProfile[]): string {
  const available = profiles.filter((profile) => profile.enabled);
  if (available.length === 0) return "No subagent profiles are currently enabled.";
  return available.map((profile) => {
    const details = [`Tools: ${profile.tools.length > 0 ? profile.tools.join(", ") : "none"}`];
    if (profile.model) details.push(`Model: ${profile.model}`);
    return `- ${profile.name}: ${profile.description} (${details.join("; ")})`;
  }).join("\n");
}

export function subagentToolDetails(run: SubagentRunInfo): SubagentToolDetails {
  return {
    kind: "pi-web-subagent",
    sessionId: run.sessionId,
    parentToolCallId: run.parentToolCallId,
    profile: run.profile,
    description: run.description,
    status: run.status,
    runInBackground: run.runInBackground,
    createdAt: run.createdAt,
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    ...(run.error ? { error: run.error } : {}),
    ...(run.worktreePath ? { worktreePath: run.worktreePath } : {}),
    ...(run.worktreeBranch ? { worktreeBranch: run.worktreeBranch } : {}),
    ...(run.worktreeCleanupError ? { worktreeCleanupError: run.worktreeCleanupError } : {}),
  };
}

export function isActiveSubagentStatus(status: SubagentRunInfo["status"]): boolean {
  return status === "starting" || status === "running" || status === "queued";
}

export function subagentFinalText(run: SubagentRunInfo): string {
  if (isActiveSubagentStatus(run.status)) {
    return `Subagent ${run.sessionId} is ${run.status}.`;
  }
  if (run.status === "completed") return run.result?.trim() || "Subagent completed without text output.";
  if (run.status === "aborted") return `Subagent ${run.sessionId} was stopped.`;
  if (run.status === "interrupted") return `Subagent ${run.sessionId} was interrupted before completion.`;
  return `Subagent ${run.sessionId} failed: ${run.error ?? "Unknown error"}`;
}

export function createSubagentExtension(
  runtime: SubagentExtensionRuntime,
  getProfiles: SubagentProfileProvider,
  isEnabled: SubagentEnabledProvider = () => true,
): InlineExtension {
  return {
    name: HOST_SUBAGENT_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      if (!isEnabled()) return;
      const profiles = getProfiles().filter((profile) => profile.enabled);
      const profileNames = profiles.map((profile) => profile.name);
      const availableTypes = profileNames.length > 0 ? profileNames.join(", ") : "none";
      pi.registerTool(defineTool({
        name: "Agent",
        label: "Agent",
        description: `Delegate a focused task to a subagent. Built-in profiles run in the background by default in separate, inspectable sessions using the current model. Use foreground execution only when your next step needs the result and there is no independent work you can do while waiting.\n\nAvailable agent types:\n${agentTypeDescription(profiles)}`,
        promptSnippet: "Delegate a focused task to an inspectable subagent session",
        promptGuidelines: [
          "Once you have enough context to identify independent work, delegate it early and continue a separate part of the task yourself. Handle straightforward tasks directly when delegation is optional.",
          "Give each child a concrete deliverable, acceptance criteria, and clear file ownership or a read-only scope. Keep concurrent edits in disjoint files and avoid duplicating delegated work.",
          "Identify the first step that needs each result. When research or artifact retrieval is only needed for final comparison or verification, begin implementation while that work runs in the background.",
          "Use get_subagent_result with wait: true when a specific result blocks the next dependent step and you have no useful independent work left. Review the outcome and verify the integrated work before reporting completion.",
        ],
        executionMode: "parallel",
        parameters: Type.Object({
          subagent_type: Type.Optional(Type.String({ description: `Optional profile. Omit for the built-in general-purpose subagent. Available profiles: ${availableTypes}.` })),
          prompt: Type.String({ description: "The complete task for the subagent." }),
          resume: Type.Optional(Type.String({ description: "Existing subagent session ID to continue instead of creating a new session." })),
          input_files: Type.Optional(Type.Array(Type.String(), {
            description: "UTF-8 text files under the session cwd to include with the task.",
            maxItems: MAX_SUBAGENT_INPUT_FILES,
          })),
          description: Type.String({ description: "Short task name shown in the UI, in the same language as the user’s request." }),
          run_in_background: Type.Optional(Type.Boolean({ description: "Return a session ID without waiting for completion. Set false to wait inside this tool call." })),
          model: Type.Optional(Type.String({ description: "Optional provider/modelId override." })),
          thinking: Type.Optional(Type.String({ description: "Optional thinking level override." })),
          max_turns: Type.Optional(Type.Number({ description: "Optional positive agent turn limit." })),
          inherit_context: Type.Optional(Type.Boolean({ description: "Include the parent session's active conversation context." })),
          isolation: Type.Optional(Type.String({ description: "Run the subagent in an isolated git worktree." })),
        }),
        async execute(toolCallId, params, signal, onUpdate, ctx) {
          try {
            const resume = params.resume?.trim();
            const common = {
              parentContext: ctx,
              parentToolCallId: toolCallId,
              task: params.prompt,
              description: params.description,
              runInBackground: params.run_in_background,
              signal,
              onUpdate: (run: SubagentRunInfo) => onUpdate?.({
                content: [{ type: "text" as const, text: `${run.profile}: ${run.description} (${run.status})` }],
                details: subagentToolDetails(run),
              }),
            };
            const launch = resume
              ? runtime.resume({ ...common, sessionId: resume })
              : runtime.start({
                  ...common,
                  profile: params.subagent_type?.trim() || undefined,
                  inputFiles: params.input_files,
                  model: params.model || undefined,
                  thinking: params.thinking || undefined,
                  maxTurns: params.max_turns || undefined,
                  inheritContext: params.inherit_context,
                  isolation: params.isolation === "worktree" ? "worktree" : undefined,
                });

            const execution = await waitForSubagent(launch, signal);
            if (execution.run.runInBackground && isActiveSubagentStatus(execution.run.status)) {
              if (!execution.ownedByTask) {
                void execution.completion
                  .then((run) => runtime.notifyParent(run))
                  .catch((error) => {
                    console.error(
                      "[meteoragent] failed to deliver subagent completion:",
                      error instanceof Error ? error.message : error,
                    );
                  });
              }
              return {
                content: [{ type: "text", text: `Subagent started in background (${execution.run.status}). Session ID: ${execution.run.sessionId}. Start the part you can complete independently. Wait for this result when you reach the step that needs it.` }],
                details: subagentToolDetails(execution.run),
              };
            }

            const run = await waitForSubagent(execution.completion, signal);
            return {
              content: [{ type: "text", text: subagentFinalText(run) }],
              details: subagentToolDetails(run),
              ...(run.status === "failed" ? { isError: true } : {}),
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
              details: undefined,
              isError: true,
            };
          }
        },
      }));

      pi.registerTool(defineTool({
        name: "get_subagent_result",
        label: "Get agent result",
        description: "Retrieve a subagent's latest result. Wait only when this result is needed for your next step. Other subagents can keep running.",
        executionMode: "parallel",
        parameters: Type.Object({
          agent_id: Type.String({ description: "Subagent session ID." }),
          wait: Type.Optional(Type.Boolean({ description: "Wait until the subagent finishes." })),
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
          const parentId = ctx?.sessionManager.getSessionId();
          const run = await runtime.get(params.agent_id, parentId, params.wait ? { signal } : undefined);
          if (!run) return { content: [{ type: "text", text: `Subagent not found: ${params.agent_id}` }], details: undefined, isError: true };
          return {
            content: [{ type: "text", text: subagentFinalText(run) }],
            details: subagentToolDetails(run),
            ...(run.status === "failed" ? { isError: true } : {}),
          };
        },
      }));

      pi.registerTool(defineTool({
        name: "steer_subagent",
        label: "Steer agent",
        description: "Send a steering message to a currently running subagent session.",
        parameters: Type.Object({
          agent_id: Type.String({ description: "Subagent session ID." }),
          message: Type.String({ description: "Instruction to inject after the current tool execution." }),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          try {
            await runtime.steer(params.agent_id, params.message, ctx?.sessionManager.getSessionId());
            return { content: [{ type: "text", text: `Steering message sent to ${params.agent_id}.` }], details: undefined };
          } catch (error) {
            return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: undefined, isError: true };
          }
        },
      }));
    },
  };
}

/** Keep Pi Web's integrated implementation when the legacy package is loaded. */
export function preferPiWebSubagentExtension(base: LoadExtensionsResult): LoadExtensionsResult {
  const host = base.extensions.find((extension) => extension.path === HOST_SUBAGENT_EXTENSION_PATH);
  if (!host?.tools.has("Agent")) return base;
  const legacyPaths = new Set(base.extensions
    .filter((extension) => extension.path !== HOST_SUBAGENT_EXTENSION_PATH)
    .filter((extension) => {
      const source = extension.sourceInfo?.source ?? "";
      const sourcePackage = source.replace(/^npm:/, "").split("@")[0];
      const pathSegments = extension.path.replaceAll("\\", "/").split("/");
      return sourcePackage === LEGACY_SUBAGENT_PACKAGE_NAME
        || pathSegments.some((segment) => segment === LEGACY_SUBAGENT_PACKAGE_NAME);
    })
    .filter((extension) => [...SUBAGENT_TOOL_NAMES].some((name) => extension.tools.has(name)))
    .map((extension) => extension.path));
  if (legacyPaths.size === 0) return base;
  return {
    ...base,
    extensions: base.extensions.filter((extension) => !legacyPaths.has(extension.path)),
    errors: base.errors.filter((error) => {
      if (legacyPaths.has(error.path)) return false;
      if (error.path !== HOST_SUBAGENT_EXTENSION_PATH) return true;
      return ![...legacyPaths].some((legacyPath) =>
        [...SUBAGENT_TOOL_NAMES].some((name) =>
          error.error === `Tool "${name}" conflicts with ${legacyPath}`
        )
      );
    }),
  };
}
