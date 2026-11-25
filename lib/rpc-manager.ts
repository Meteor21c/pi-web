import { getCurrentSystemMessage, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ImageContent } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionServices, defineTool, getAgentDir, initTheme, SessionManager, SettingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { KeybindingsManager as TuiKeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { createHash, randomUUID } from "crypto";
import { isDeepStrictEqual } from "node:util";
import { existsSync, realpathSync } from "fs";
import { resolve } from "path";
import { validateAgentImages } from "./image-attachments";
import { AgentInputQueue } from "./agent-input-queue";
import { invalidateModelsCache } from "./models-cache";
import { withSavedRelayContextWindow } from "./models-config-store";
import { createMeteorAgentBrandExtension, METEORAGENT_REPLY_GUIDANCE, rebrandMeteorAgentSystemPrompt } from "./meteoragent-brand";
import {
  filterModelScopeByProviders,
  filterModelScopeByRelayAuthorization,
  resolveVisibleModels,
  selectInitialModelScope,
} from "./model-scope";
import { readRelayGroups, relayAuthorizedModelIdsByProvider } from "./relay-group-store";
import {
  createProjectCommandBashExtension,
  createProjectCommandBashOperations,
  preferUserBashExtension,
} from "./project-command-env";
import { cacheSessionPath, getLatestModelChange, invalidateSessionListCache, persistPreparedSession, resolveSessionPath } from "./session-reader";
import { getProjectTrustStatus, projectTrustReloadOptions } from "./project-trust";
import { persistExplicitStartupPreferences } from "./startup-preferences";
import { notifySessionComplete } from "./web-push";
import { hasActiveSessionLivenessProvider } from "./session-liveness";
import type { AgentBeforeSettleEvent, AgentBeforeSettleEventResult, InlineExtension, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike, ExtensionUiContextLike, ToolInfo } from "./pi-types";
import type {
  AssistantMessage,
  ExtensionUiRequest,
  ExtensionUiResponse,
  ExtensionWidgetItem,
  SessionEntry,
  SessionInfo,
  SessionMessageEntry,
  ToolResultMessage,
} from "./types";
import { createHeadlessCustomUiTui, DEFAULT_CUSTOM_UI_COLUMNS, type HeadlessCustomUiTui } from "./custom-ui-terminal";
import {
  createSubagentExtension,
  isActiveSubagentStatus,
  preferPiWebSubagentExtension,
  subagentFinalText,
  subagentToolDetails,
  type SubagentToolDetails,
} from "./subagent-extension";
import {
  listSubagentProfiles,
  readSubagentRun,
  readSubagentSessionResources,
  SUBAGENT_CONTROL_TOOL_NAMES,
  type SubagentRunInfo,
} from "./subagents";
import { createSubagentController } from "./subagent-runtime";
import { isBuiltInSubagentsEnabled } from "./subagent-settings";
import { AUTOMATIC_SUBAGENT_RETRY_TYPE, SUBAGENT_RESULTS_TYPE, isSubagentMode, type SubagentMode } from "./subagent-mode";
import { SubagentTask } from "./subagent-task";
import { getPresetFromToolNames } from "./tool-presets";
import { isComputerUseApprovalPolicy, type ComputerUseApprovalPolicy } from "./computer-use-approval-policy";
import { computerUseCaptureFailed, computerUsePermissionCheck, deniedComputerUsePermission, type ComputerUsePermission } from "./computer-use-permissions";
import { installToolFileChangeTracking } from "./tool-file-change";
import { resolveShellTools } from "./powershell-settings";
import { CHAT_ONLY_RESOURCE_LOADER_OPTIONS, contextFilesSystemPrompt } from "./chat-only";
import { createSessionScopedSettingsManager } from "./plugin-activation";
import { withRelayImageGenerationSession } from "./relay-image-generation";
import { appendRelayImageBillingEntries } from "./relay-image-billing";
import { createRelaySummaryPolicyExtension, installRelayResponseRepair } from "./relay-responses";
import { withProviderDefaultThinking } from "./model-auto-reasoning";
import { isModelThinkingLevel, resolveThinkingLevelOption, type ThinkingLevelOption } from "./model-capabilities";
import { readSessionThinkingSelection, THINKING_SELECTION_TYPE } from "./session-thinking";
import { readPromptPresetSettings } from "./prompt-preset-store";
import { readSessionGoal, updateSessionGoal, updateSessionGoalFromRun, type SessionGoal } from "./session-goal";
import { GOAL_CONTINUATION_TYPE, GOAL_OUTCOME_TYPE, type GoalOutcomeStatus } from "./session-goal-types";
import { stoppedWithoutFinalAnswer } from "./message-display";
import { TURN_TIMING_TYPE, type RunActivity } from "./session-timing";
import { normalizeUserQuestions, readUserQuestionAnswers, USER_QUESTION_TOOL, type UserQuestion, type UserQuestionAnswer, type UserQuestionResult } from "./user-questions";
import {
  appendSessionPromptSelection, composeSessionSystemPrompt, MODE_INSTRUCTIONS, PLAN_TOOL_NAMES,
  isWorkMode, promptSelectionFromSettings, readSessionPromptSelection, type SessionPromptSelection, type WorkMode,
} from "./prompt-presets";
import { appendSessionWorkMode, appendUserTurnMetadata, inheritSessionWorkMode, readSessionWorkMode, type SessionWorkMode } from "./session-work-mode";
import {
  appendSessionToolSelection,
  readSessionToolSelection,
  validateSessionToolSelection,
} from "./session-tool-selection";

// ============================================================================
// Types
// ============================================================================

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

type EventListener = (event: AgentEvent) => void;
type AgentRunCompleteListener = (sessionId: string) => void;

type RunTiming = {
  startedAt: number;
  startedMonotonic: number;
  lastActivityAt: number;
  sawUser: boolean;
};

const RUN_ACTIVITY_EVENTS = new Set([
  "agent_start", "message_start", "message_update", "message_end",
  "tool_execution_start", "tool_execution_end", "auto_retry_start", "auto_retry_end",
  "auto_compaction_start", "auto_compaction_end", "compaction_start", "compaction_end",
]);

function hasRunActivity(event: AgentEvent): boolean {
  if (RUN_ACTIVITY_EVENTS.has(event.type)) return true;
  if (event.type !== "tool_execution_update") return false;
  const result = event.partialResult as Partial<ToolResultMessage> | undefined;
  return Boolean(result?.content?.some((block) => block.type === "image" || (block.type === "text" && block.text.trim()))
    || result?.details);
}

type ComputerUseApprovalRun = {
  policy: ComputerUseApprovalPolicy;
  remembered: Set<string>;
};

type GoalReport = { status: "progress" | "complete" | "blocked"; detail: string; userAction?: string };

type GoalRun = {
  id: string;
  revision?: number;
  sawUser: boolean;
  replyCanResume: boolean;
  resumedGoal?: SessionGoal;
  continuations: number;
  recoveryUsed: boolean;
  progressCheckpoints: Set<string>;
  lastProgress?: string;
  pauseReason?: "no_progress" | "budget";
  computerPermissions: Set<ComputerUsePermission>;
  screenRecordingGranted?: boolean;
  screenCaptureFailed?: boolean;
  approvalRequired?: boolean;
  stopped: boolean;
  deliveredImage: boolean;
  lastAssistant?: AssistantMessage;
  report?: GoalReport & { subagentLaunchCount?: number };
};

const GOAL_REPORT_TOOL = "meteoragent_report_goal";
const MAX_GOAL_CONTINUATIONS = 8;
const GOAL_CONTINUATION = "Continue the current goal from the work already done. Verify the current state before repeating any operation. Work on the remaining steps. Before ending this round, call the goal report tool with verified completion, a new concrete checkpoint, or the specific action you need from the user. Give the user a brief update in the conversation's established reply language.";

type PendingUiResponse = {
  resolve: (response: ExtensionUiResponse) => void;
  cancel: () => void;
};

type CustomUiComponent = {
  render: (width: number) => readonly string[];
  handleInput?: (data: string) => void;
  dispose?: () => void;
  invalidate?: () => void;
};

type ExtensionWidgetComponent = {
  render: (width: number) => unknown;
  dispose?: () => void;
};

type ExtensionWidgetFactory = (tui: HeadlessCustomUiTui, theme: Theme) => unknown;

type ActiveExtensionWidget = {
  key: string;
  component: ExtensionWidgetComponent;
  placement: "aboveEditor" | "belowEditor";
  generation: number;
  clearEmitted: boolean;
  rendered: boolean;
};

type ActiveCustomUi = {
  component: CustomUiComponent;
  width: number;
  resolve: (value: unknown) => void;
  settled: boolean;
};

type ExtensionUiRequestBody = Record<string, unknown> & {
  method: ExtensionUiRequest["method"];
  timeout?: number;
  expiresAt?: number;
};

type ExtensionCommandContextActionsLike = {
  waitForIdle: () => Promise<void>;
  newSession: () => Promise<{ cancelled: boolean }>;
  fork: () => Promise<{ cancelled: boolean }>;
  navigateTree: (targetId: string, options?: { summarize?: boolean }) => Promise<{ cancelled: boolean }>;
  switchSession: () => Promise<{ cancelled: boolean }>;
  reload: () => Promise<void>;
};

type AgentSessionWrapperOptions = {
  exactSystemPrompt?: () => string;
  promptSelection?: SessionPromptSelection;
  chatOnly?: boolean;
  onAgentRunComplete?: AgentRunCompleteListener;
  suppressCompletionNotifications?: boolean;
};

const IDLE_RESET_EVENT_TYPES = new Set([
  "agent_end",
  "agent_settled",
  "auto_compaction_end",
  "compaction_end",
]);

const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Resolves the PI_WEB_IDLE_TIMEOUT_MS environment variable into a session idle
 * timeout in milliseconds. An unset/blank value returns the 10-minute default,
 * `0` disables idle shutdown, and positive values up to Node's timer limit
 * (2147483647 ms) are used as-is. Invalid or out-of-range values fall back to
 * the default with a console warning.
 * @param rawValue Value to parse; defaults to the environment variable.
 */
export function resolveSessionIdleTimeoutMs(
  rawValue: string | undefined = process.env.PI_WEB_IDLE_TIMEOUT_MS,
): number {
  if (rawValue !== undefined && rawValue.trim() !== "") {
    const parsed = Number(rawValue);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 2_147_483_647) return parsed;
    console.warn(`[meteoragent] invalid PI_WEB_IDLE_TIMEOUT_MS "${rawValue}", falling back to 10 minutes`);
  }
  return DEFAULT_SESSION_IDLE_TIMEOUT_MS;
}

const SESSION_IDLE_TIMEOUT_MS = resolveSessionIdleTimeoutMs();
const COMPUTER_USE_LAUNCH_TOOL = "computer_use_launch_app";
const COMPUTER_USE_LAUNCH_TITLE = "Allow computer use?";
const AUTO_APPROVABLE_COMPUTER_ACTIONS = new Set([
  "run_script",
  "run_steps",
  "replay_trajectory",
  "clipboard_read",
  "clipboard_write",
  "kill_app",
]);

const SESSION_REPLACEMENT_COMMAND_TYPES = new Set(["fork", "clone"]);
const COMMANDS_ALLOWED_DURING_SESSION_REPLACEMENT = new Set([
  "get_state",
  "get_prompt_selection",
  "get_session_stats",
  "get_last_assistant_text",
  "get_tools",
  "get_commands",
  "extension_ui_response",
  "extension_ui_input",
]);

export interface RpcSessionStartOptions {
  toolNames?: string[];
  initialModel?: { provider: string; modelId: string };
  allowInitialModelFallback?: boolean;
  thinkingLevel?: ThinkingLevelOption;
}

const CODING_TOOL_NAMES = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];

// Extensions require a complete Theme, while the web UI applies its own styling.
class PlainTextTheme extends Theme {
  constructor() {
    super(
      { muted: "", text: "", thinkingXhigh: "", searchMatchText: "" } as ConstructorParameters<typeof Theme>[0],
      { selectedBg: "" } as ConstructorParameters<typeof Theme>[1],
      "truecolor",
    );
  }

  override fg(...[, text]: Parameters<Theme["fg"]>): string { return text; }
  override bg(...[, text]: Parameters<Theme["bg"]>): string { return text; }
  override bold(text: string): string { return text; }
  override italic(text: string): string { return text; }
  override underline(text: string): string { return text; }
  override inverse(text: string): string { return text; }
  override strikethrough(text: string): string { return text; }
  override getFgAnsi(): string { return ""; }
  override getBgAnsi(): string { return ""; }
  override getThinkingBorderColor(): (text: string) => string {
    return (text) => text;
  }
  override getBashModeBorderColor(): (text: string) => string { return (text) => text; }
}

const PLAIN_TEXT_THEME = new PlainTextTheme();
const CUSTOM_UI_KEYBINDINGS = new TuiKeybindingsManager(TUI_KEYBINDINGS);
const SUBAGENT_CONTROL_TOOLS = new Set<string>(SUBAGENT_CONTROL_TOOL_NAMES);
const REQUIRE_SUBAGENT_INSTRUCTIONS = "Delegation is required for this task. Call Agent at least once as soon as you can define a focused task.";
const PROACTIVE_SUBAGENT_INSTRUCTIONS = "Look for independent work at the start of this task. Use Agent early when it can reduce completion time or provide an independent check. Handle a small or tightly sequential task yourself.";
const PARALLEL_SUBAGENT_INSTRUCTIONS = "Before delegating, identify the work you will do yourself and the first step that needs each child's result. Give each child a concrete deliverable and a distinct scope. Use background execution for independent work and start your own part immediately. If research or artifact retrieval is needed only for comparison or verification, start implementation in parallel with it. Wait for the specific result when you reach the dependent step and have no useful independent work left. Choose the number of children based on the work and verify the combined outcome.";

function subagentStatusEvent(run: SubagentRunInfo): AgentEvent {
  return { type: "subagent_status", toolCallId: run.parentToolCallId, subagent: subagentToolDetails(run) };
}

function withExtensionTools(session: AgentSessionLike, toolNames: string[]): string[] {
  if (toolNames.length === 0) return [];

  const codingToolNames = new Set(CODING_TOOL_NAMES);
  const readOnly = getPresetFromToolNames(toolNames) === "read-only";
  const activeTools = new Set(session.getActiveToolNames());
  const selectedToolNames = resolveShellTools(toolNames, session.settingsManager.getDefaultTools());
  const extensionToolNames = session
    .getAllTools()
    .filter(({ name, exposure }) => {
      if (codingToolNames.has(name)) return false;
      if (!name.startsWith("computer_use_")) return true;
      // Preserve the plugin's deferred groups when we reapply a tool preset.
      return !readOnly && (exposure !== "deferred" || activeTools.has(name));
    })
    .map(({ name }) => name);

  return [...new Set([...selectedToolNames, ...extensionToolNames])];
}

// ============================================================================
// AgentSessionWrapper
// Wraps AgentSession with the same interface the rest of the app expects
// ============================================================================

export class AgentSessionWrapper {
  private listeners: EventListener[] = [];
  private activeToolEvents = new Map<string, AgentEvent>();
  private pendingUiResponses = new Map<string, PendingUiResponse>();
  private pendingUiRequests = new Map<string, AgentEvent>();
  private readonly skippedUserQuestions = new Set<string>();
  private activeCustomUis = new Map<string, ActiveCustomUi>();
  private extensionUiAbortController = new AbortController();
  private computerUseApprovalRun?: ComputerUseApprovalRun;
  private readonly wrappedLaunchTools = new WeakSet<object>();
  private readonly autoApprovedLaunches = new Set<string>();
  private extensionStatuses = new Map<string, string>();
  private extensionWidgets = new Map<string, ExtensionWidgetItem>();
  private activeExtensionWidgets = new Map<string, ActiveExtensionWidget>();
  private extensionWidgetGenerations = new Map<string, number>();
  private extensionWidgetsResetting = false;
  private pendingPromptCount = 0;
  private reloadingResources = false;
  private activeMutatingCommands = 0;
  private sessionReplacement: "fork" | "clone" | null = null;
  private agentRunNeedsCompletion = false;
  private runTiming?: RunTiming;
  private runGoalSnapshot: SessionGoal | null | undefined;
  private goalRun?: GoalRun;
  private promptAdmissionTail: Promise<void> = Promise.resolve();
  private extensionsBound = false;
  private extensionBindingPromise: Promise<void> | null = null;
  private extensionBindingError: unknown = null;
  private readonly exactSystemPrompt?: () => string;
  private promptSelection?: SessionPromptSelection;
  private workModeState: SessionWorkMode;
  private configuredToolNames?: string[];
  private useDefaultPlanTools = false;
  private activeQueueSubmissions = 0;
  private readonly inputQueue: AgentInputQueue;
  private subagentMode?: SubagentMode;
  private currentSubagentTask?: SubagentTask;
  private subagentWait?: AbortController;
  private readonly chatOnly: boolean;
  private readonly onAgentRunComplete?: AgentRunCompleteListener;
  private readonly suppressCompletionNotifications: boolean;
  private readonly clearToolFileChangeTracking: () => void;
  private unsubscribe: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onDestroyCallback: (() => void) | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private sessionShutdownEmitted = false;
  private forceShutdownOnIdle = false;
  private _alive = true;

  constructor(
    public readonly inner: AgentSessionLike,
    options: AgentSessionWrapperOptions = {},
  ) {
    this.inputQueue = new AgentInputQueue(inner);
    this.exactSystemPrompt = options.exactSystemPrompt;
    this.promptSelection = options.promptSelection;
    this.chatOnly = options.chatOnly ?? false;
    this.onAgentRunComplete = options.onAgentRunComplete;
    this.suppressCompletionNotifications = options.suppressCompletionNotifications ?? false;
    this.workModeState = readSessionWorkMode(
      (inner.sessionManager?.getEntries?.() ?? []) as unknown as SessionEntry[],
      this.promptSelection?.mode,
    );
    this.refreshRelayContextWindow();
    this.installExactSystemPromptContinuation();
    this.installPromptPresetProjection();
    this.installThinkingSelection();
    this.clearToolFileChangeTracking = installToolFileChangeTracking(inner);
  }

  get sessionId(): string {
    return this.inner.sessionId;
  }

  get sessionFile(): string {
    return this.inner.sessionFile ?? "";
  }

  get cwd(): string {
    return this.inner.sessionManager.getCwd();
  }

  get streamingMessage() {
    return this.inner.agent.state?.streamingMessage;
  }

  get isStreaming(): boolean {
    return this.inner.isStreaming;
  }

  get activeComputerUseApprovalPolicy(): ComputerUseApprovalPolicy {
    return this.computerUseApprovalRun?.policy ?? "ask";
  }

  isAlive(): boolean {
    return this._alive;
  }

  isRunning(): boolean {
    return this._alive && (this.reloadingResources || this.pendingPromptCount > 0
      || this.inner.isStreaming || this.inner.isCompacting || this.inner.isBashRunning);
  }

  isChatOnly(): boolean {
    return this.chatOnly;
  }

  hasSuppressedCompletionNotifications(): boolean {
    return this.suppressCompletionNotifications;
  }

  private subagentsBlocked(toolNames?: readonly string[]): boolean {
    return this.chatOnly || this.suppressCompletionNotifications || this.workModeState.workMode === "plan"
      || getPresetFromToolNames(toolNames ?? this.inner.getActiveToolNames?.() ?? []) === "read-only";
  }

  effectiveSubagentMode(toolNames?: readonly string[]): SubagentMode {
    if (this.subagentsBlocked(toolNames)) return "off";
    return this.subagentMode ?? (isBuiltInSubagentsEnabled() ? "auto" : "off");
  }

  get subagentTask(): SubagentTask | undefined { return this.currentSubagentTask; }

  publishSubagentStatus(run: SubagentRunInfo): void {
    const activityAt = Date.now();
    if (this.runTiming) {
      this.runTiming.lastActivityAt = Math.max(this.runTiming.lastActivityAt, activityAt);
    }
    this.emit({ ...subagentStatusEvent(run), activityAt });
  }

  static userQuestionTool(getWrapper: () => AgentSessionWrapper | undefined) {
    return defineTool({
      name: USER_QUESTION_TOOL,
      label: "Ask the user",
      exposure: "model-only",
      description: "Show a question dialog and wait for the user's reply. Use this for missing information or a consequential choice that context and reasonable assumptions cannot resolve.",
      promptSnippet: "Ask for essential information or a user decision",
      promptGuidelines: [
        "Use available context and safe, reversible assumptions for ordinary details. Ask only when the answer would materially change the task or unblock it.",
        "Ask in the user's language with plain wording. Group related questions in one call. Include meaningful choices when available. The user can always write their own answer.",
        "Call this tool by itself before doing work that depends on the answer. Use the existing approval controls for operations that require authorization.",
      ],
      parameters: Type.Object({
        questions: Type.Array(Type.Object({
          question: Type.String({ minLength: 1, maxLength: 300 }),
          options: Type.Optional(Type.Array(Type.Object({
            label: Type.String({ minLength: 1, maxLength: 80 }),
            description: Type.Optional(Type.String({ maxLength: 200 })),
          }), { minItems: 2, maxItems: 4 })),
        }), { minItems: 1, maxItems: 3 }),
      }),
      async execute(_toolCallId, { questions }, signal) {
        const wrapper = getWrapper();
        if (!wrapper?.isRunning()) throw new Error("Questions require an active chat task.");
        const answers = await wrapper.askUser(normalizeUserQuestions(questions), signal);
        const details: UserQuestionResult = answers ? { status: "answered", answers } : { status: "skipped" };
        return {
          content: [{
            type: "text",
            text: answers
              ? "The user answered the clarification in this task.\n" + JSON.stringify(answers)
              : "The user skipped the clarification. Continue wherever a safe assumption works. If an answer is essential, explain what you still need and wait for a new user message. In Goal mode, report the blocker. Do not repeat the skipped question in this run.",
          }],
          details,
        };
      },
    });
  }

  private async askUser(questions: UserQuestion[], signal?: AbortSignal): Promise<UserQuestionAnswer[] | null> {
    if ([...this.pendingUiRequests.values()].some((request) => request.method === "question")) {
      throw new Error("A question is already waiting for the user's answer.");
    }
    const keys = questions.map(({ question }) => question.replace(/\s+/g, " ").toLowerCase());
    if (keys.some((key) => this.skippedUserQuestions.has(key))) {
      throw new Error("The user already skipped this question. Continue safely or explain the outstanding blocker.");
    }
    const goal = this.goalRun;
    if (goal?.report?.status === "complete") goal.report = undefined;
    const answers = await this.requestExtensionUi<UserQuestionAnswer[] | null>(
      { method: "question", questions },
      null,
      (response) => "cancelled" in response && response.cancelled === true
        ? null
        : readUserQuestionAnswers(questions, "answers" in response ? response.answers : undefined),
      undefined,
      signal,
    );
    if (answers === null) {
      for (const key of keys) this.skippedUserQuestions.add(key);
    } else if (goal && this.goalRun === goal && goal.report?.status === "blocked") {
      goal.report = undefined;
    }
    return answers;
  }

  static goalExtension(getWrapper: () => AgentSessionWrapper | undefined): InlineExtension {
    return {
      name: "meteoragent-goal",
      hidden: true,
      factory(pi) {
        pi.on("agent_start", () => getWrapper()?.resumeGoalOnUserReply());
        pi.on("agent_before_settle", (event) => {
          const wrapper = getWrapper();
          return wrapper?.joinSubagents(event) ?? wrapper?.continueGoalRun(event);
        });
        // Pi dispatches nested calls via the extension runner, independently of
        // Agent.beforeToolCall. Apply the same policy to each nested operation.
        pi.on("tool_call", (event) => event.parentToolCallId ? getWrapper()?.guardToolCall(event.toolName) : undefined);
        pi.registerTool(defineTool({
          name: GOAL_REPORT_TOOL,
          label: "Goal progress",
          description: "Record a concrete checkpoint, verified completion, or a blocker that requires the user to act. Review the results of any delegated work before reporting completion.",
          parameters: Type.Object({
            status: Type.Union([Type.Literal("progress"), Type.Literal("complete"), Type.Literal("blocked")]),
            detail: Type.String({ minLength: 1, maxLength: 2_000, description: "Concrete evidence for progress or completion, or the reason the goal is blocked." }),
            userAction: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000, description: "For blocked only: the specific action or answer needed from the user, in their reply language." })),
          }),
          async execute(_callId, report, signal) {
            const wrapper = getWrapper();
            if (!wrapper) throw new Error("Goal tracking is unavailable.");
            wrapper.reportGoalProgress(report, signal);
            return { content: [{ type: "text", text: "Goal report recorded. Continue if useful, or summarize the outcome for the user." }], details: {} };
          },
        }));
      },
    };
  }

  private goalRunIsCurrent(run: GoalRun): boolean {
    if (this.goalRun !== run || !run.sawUser || run.revision === undefined
      || this.workModeState.workMode !== "goal" || this.workModeState.pendingWorkMode !== null) return false;
    try {
      const goal = readSessionGoal(this.sessionFile);
      return goal?.status === "active" && goal.revision === run.revision;
    } catch (error) {
      console.error("[meteoragent] could not check the session goal:", error);
      return false;
    }
  }

  private reportGoalProgress(report: GoalReport, signal?: AbortSignal): void {
    const run = this.goalRun;
    if (!run || run.stopped || signal?.aborted || !this.goalRunIsCurrent(run)) {
      throw new Error("The active goal changed or is no longer running.");
    }
    const detail = report.detail.trim();
    if (!detail) throw new Error("Provide evidence or explain the blocker before reporting goal progress.");
    const userAction = report.status === "blocked" ? report.userAction?.trim() : undefined;
    if (report.status === "blocked" && !userAction) throw new Error("Describe exactly what the user needs to do or answer before you can continue.");
    if (this.isCurrentGoalCompletion(run.report) || run.report?.status === "blocked") {
      throw new Error("A final report has already been recorded for this run.");
    }
    if (report.status === "complete" && this.subagentTask?.hasUnreadResults) {
      throw new Error("Review outstanding subagent results before reporting completion. Use get_subagent_result when you need a specific result.");
    }
    run.report = {
      status: report.status,
      detail,
      ...(userAction ? { userAction } : {}),
      subagentLaunchCount: this.subagentTask?.launchCount,
    };
  }

  private isCurrentGoalCompletion(report: GoalRun["report"]): boolean {
    return report?.status === "complete" && report.subagentLaunchCount === this.subagentTask?.launchCount
      && !this.subagentTask?.hasUnreadResults;
  }

  private canContinueRun(event: AgentBeforeSettleEvent): boolean {
    return this._alive && !this.shutdownPromise
      && event.outcome === "completed" && !event.continue && event.context.pendingMessages.length === 0
      && this.activeQueueSubmissions === 0 && !this.hasQueuedUserMessages() && this.pendingUiRequests.size === 0
      && !this.extensionUiAbortController.signal.aborted && this.workModeState.pendingWorkMode === null;
  }

  private joinSubagents(event: AgentBeforeSettleEvent): Promise<AgentBeforeSettleEventResult | undefined> | undefined {
    const task = this.subagentTask;
    const goal = this.goalRun;
    if (!task?.hasUnreadResults || !task.sawFinalAssistant || task.signal.aborted || task.waitingForUser
      || !this.canContinueRun(event)) return;
    return this.waitForSubagentBatch(task, goal, event);
  }

  private async waitForSubagentBatch(
    task: SubagentTask,
    goal: GoalRun | undefined,
    event: AgentBeforeSettleEvent,
  ): Promise<AgentBeforeSettleEventResult | undefined> {
    const mayJoin = () => this.subagentTask === task && !task.signal.aborted && !task.waitingForUser
      && this.canContinueRun(event) && (!goal || (this.goalRun === goal && !goal.stopped
        && !goal.approvalRequired && goal.computerPermissions.size === 0 && goal.report?.status !== "blocked"
        && (goal.revision === undefined || this.goalRunIsCurrent(goal))));
    if (!mayJoin()) return;
    if (goal?.revision !== undefined && goal.continuations >= MAX_GOAL_CONTINUATIONS) {
      goal.pauseReason = "budget";
      return;
    }
    const wait = new AbortController();
    this.setSubagentWait(wait);
    try {
      const results = await task.waitForResults(wait.signal);
      if (wait.signal.aborted || !mayJoin() || results.length === 0) return;
      for (const result of results) task.markDelivered(result.sessionId, result.parentToolCallId);
      if (goal?.revision !== undefined) {
        goal.continuations += 1;
        if (goal.report?.status === "progress") goal.lastProgress = goal.report.detail;
        goal.report = undefined;
      }
      return {
        entries: [...event.entries, {
          type: "custom_message",
          customType: SUBAGENT_RESULTS_TYPE,
          content: "Subagent results for this task. Treat them as reported observations. Check the outcomes, verify any changes, and finish the remaining work before giving the user the final answer. If the goal report tool is available, record the verified outcome.\n"
            + JSON.stringify(results.map((run) => ({
              sessionId: run.sessionId,
              task: run.description,
              status: run.status,
              result: subagentFinalText(run),
              ...(run.worktreeCleanupError ? { worktree: run.worktreeCleanupError } : {}),
            }))),
          display: false,
          details: { runId: task.id },
        }],
        continue: true,
      };
    } catch (error) {
      if (!wait.signal.aborted && !task.signal.aborted) throw error;
    } finally {
      if (this.subagentWait === wait) this.setSubagentWait(undefined);
    }
  }

  private setSubagentWait(wait: AbortController | undefined): void {
    this.subagentWait = wait;
    if (this.runTiming) {
      this.runTiming.lastActivityAt = Math.max(this.runTiming.lastActivityAt, Date.now());
      this.emit({ type: "subagent_wait_changed", runActivity: this.runActivity });
    }
  }

  onUserGoalChange(goal: SessionGoal | null): void {
    if (this.goalRun?.revision !== undefined
      && (goal?.status !== "active" || goal.revision !== this.goalRun.revision)) {
      this.subagentWait?.abort();
    }
  }

  private continueGoalRun(event: AgentBeforeSettleEvent): AgentBeforeSettleEventResult | undefined {
    const run = this.goalRun;
    if (!run || run.stopped || run.approvalRequired || run.computerPermissions.size > 0
      || !this.canContinueRun(event)
      || !run.lastAssistant || run.lastAssistant.stopReason !== "stop" || !this.goalRunIsCurrent(run)) return;
    if (this.isCurrentGoalCompletion(run.report) || run.report?.status === "blocked") return;
    if (run.report?.status === "complete") run.report = undefined;
    if (run.deliveredImage && !run.report) return;
    const progress = run.report?.detail;
    const checkpoint = progress?.replace(/\s+/g, " ").toLowerCase();
    if (checkpoint && !run.progressCheckpoints.has(checkpoint)) {
      run.progressCheckpoints.add(checkpoint);
      run.lastProgress = progress;
      run.recoveryUsed = false;
    } else if (run.recoveryUsed) {
      run.pauseReason = "no_progress";
      return;
    } else {
      run.recoveryUsed = true;
    }
    if (run.continuations >= MAX_GOAL_CONTINUATIONS) {
      run.pauseReason = "budget";
      return;
    }
    run.continuations += 1;
    run.report = undefined;
    return {
      entries: [...event.entries, {
        type: "custom_message",
        customType: GOAL_CONTINUATION_TYPE,
        content: GOAL_CONTINUATION,
        display: false,
        details: { runId: run.id },
      }],
      continue: true,
    };
  }

  private async settleGoalRun(run: GoalRun | undefined, requestFailed = false): Promise<void> {
    if (!run?.sawUser || this.goalRun !== run) return;
    if (run.revision === undefined) {
      if (!requestFailed && !run.stopped && run.lastAssistant?.stopReason === "stop") {
        this.recordGoalOutcome("untracked");
      }
      return;
    }
    if (!this.goalRunIsCurrent(run)) {
      this.recordGoalOutcome("paused");
      return;
    }
    const stopReason = run.lastAssistant?.stopReason;
    const failed = requestFailed || stopReason === "error" || stopReason === "length" || stopReason === "aborted";
    const report = run.report;
    let outcome: Parameters<typeof updateSessionGoalFromRun>[2] = { status: "paused", reason: "needs_review" };
    if (run.stopped) {
      outcome = { status: "paused", reason: "user_stop" };
    } else if (run.computerPermissions.size > 0) {
      outcome = { status: "blocked", reason: run.computerPermissions.values().next().value };
    } else if (run.approvalRequired) {
      outcome = { status: "blocked", reason: "approval_required" };
    } else if (report?.status === "blocked") {
      outcome = { status: "blocked", reason: "blocked", detail: report.detail, userAction: report.userAction };
    } else if (!failed && report?.status === "complete" && this.isCurrentGoalCompletion(report)
      && (this.subagentTask?.preference !== "required" || this.subagentTask.launchCount > 0)) {
      outcome = { status: "completed", evidence: report.detail };
    } else if (stopReason === "length") {
      outcome = { status: "paused", reason: "output_limit" };
    } else if (failed) {
      outcome = { status: "paused", reason: "request_error" };
    } else if (run.pauseReason === "budget") {
      outcome = { status: "paused", reason: "budget" };
    } else if (run.screenCaptureFailed && run.pauseReason === "no_progress") {
      outcome = { status: "paused", reason: "screen_capture_failed" };
    } else if (run.lastAssistant && !run.deliveredImage && stoppedWithoutFinalAnswer(run.lastAssistant)) {
      outcome = { status: "paused", reason: "empty_reply" };
    } else if (run.pauseReason === "no_progress") {
      outcome = { status: "paused", reason: "no_progress" };
    }
    if (outcome.status !== "completed") {
      const latestProgress = report?.status === "progress" && run.pauseReason !== "no_progress" ? report.detail : undefined;
      outcome.evidence = latestProgress ?? run.lastProgress;
    }
    let saved: SessionGoal | null = null;
    try {
      saved = await updateSessionGoalFromRun(this.sessionFile, run.revision, outcome);
    } catch (error) {
      console.error("[meteoragent] could not save the session goal outcome:", error);
    }
    this.recordGoalOutcome(saved ? outcome.status : "paused");
  }

  private recordGoalOutcome(status: GoalOutcomeStatus): void {
    const details = { status };
    try {
      this.inner.sessionManager.appendCustomMessageEntry(GOAL_OUTCOME_TYPE, "", false, details);
      this.emit({ type: "message_end", message: {
        role: "custom", customType: GOAL_OUTCOME_TYPE, content: "", display: false, details, timestamp: Date.now(),
      } });
    } catch (error) {
      console.error("[meteoragent] could not record the goal outcome for this turn:", error);
    }
  }

  private async resumeGoalOnUserReply(): Promise<void> {
    const run = this.goalRun;
    if (!run?.replyCanResume || run.stopped || this.workModeState.workMode !== "goal"
      || this.workModeState.pendingWorkMode !== null) return;
    run.replyCanResume = false;
    try {
      const goal = readSessionGoal(this.sessionFile);
      if (goal?.status === "blocked" && goal.reason === "blocked" && goal.userAction) {
        const result = await updateSessionGoal(this.sessionFile, { action: { type: "resume" }, expectedRevision: goal.revision });
        if (!result.conflict && result.goal?.status === "active") run.resumedGoal = result.goal;
      }
    } catch (error) {
      console.error("[meteoragent] could not resume the goal from the user's reply:", error);
    }
  }

  private recordGoalComputerUseResult(run: GoalRun, result: ToolResultMessage): void {
    if (process.platform !== "darwin" || !result.toolName?.startsWith("computer_use_")) return;
    const denied = deniedComputerUsePermission(result);
    if (denied) run.computerPermissions.add(denied);
    if (denied === "screen_recording" || computerUseCaptureFailed(result)) run.screenCaptureFailed = true;
    if (!result.isError && result.content.some((block) => block.type === "image")) {
      run.screenCaptureFailed = false;
      run.screenRecordingGranted = true;
      run.computerPermissions.delete("screen_recording");
    }
    const screenGrant = computerUsePermissionCheck(result, "screen_recording");
    if (screenGrant !== undefined) run.screenRecordingGranted = screenGrant;
    if (screenGrant) run.computerPermissions.delete("screen_recording");
    if (run.screenCaptureFailed && run.screenRecordingGranted === false) run.computerPermissions.add("screen_recording");
    if (computerUsePermissionCheck(result, "accessibility")) run.computerPermissions.delete("accessibility");
  }

  get runActivity(): RunActivity | undefined {
    const timing = this.runTiming;
    if (!timing) return;
    const tools: RunActivity["tools"] = [];
    for (const [id, event] of this.activeToolEvents) {
      if (typeof event.toolName === "string") tools.push({ id, name: event.toolName });
    }
    return {
      startedAt: timing.startedAt, lastActivityAt: timing.lastActivityAt, tools,
      ...(this.subagentWait ? { waitingForSubagents: true } : {}),
    };
  }

  private beginRunTiming(): void {
    if (this.runTiming) return;
    this.skippedUserQuestions.clear();
    const startedAt = Date.now();
    this.runTiming = { startedAt, startedMonotonic: performance.now(), lastActivityAt: startedAt, sawUser: false };
  }

  private finishRunTiming(): void {
    const timing = this.runTiming;
    this.runTiming = undefined;
    if (!timing?.sawUser) return;
    const details = { durationMs: Math.max(0, Math.round(performance.now() - timing.startedMonotonic)) };
    try {
      this.inner.sessionManager.appendCustomMessageEntry(TURN_TIMING_TYPE, "", false, details);
      this.emit({ type: "message_end", message: {
        role: "custom", customType: TURN_TIMING_TYPE, content: "", display: false, details, timestamp: Date.now(),
      } });
    } catch (error) {
      console.error("[meteoragent] could not save turn timing:", error);
    }
  }

  start(): void {
    this.unsubscribe = this.inner.subscribe((event: AgentEvent) => {
      if (event.type === "agent_start") {
        this.agentRunNeedsCompletion = true;
        this.beginRunTiming();
        this.computerUseApprovalRun ??= { policy: "ask", remembered: new Set() };
        if (this.runGoalSnapshot === undefined && this.workModeState.workMode === "goal" && !this.suppressCompletionNotifications) {
          // Freeze the objective for the entire run, including retries and queued messages.
          this.runGoalSnapshot = null;
          try {
            const goal = readSessionGoal(this.sessionFile);
            if (goal?.status === "active") {
              this.runGoalSnapshot = goal;
              if (this.goalRun && !this.chatOnly) this.goalRun.revision = goal.revision;
            }
          } catch (error) {
            console.error("[meteoragent] could not read the session goal:", error);
          }
        }
      }
      if (this.runTiming && hasRunActivity(event)) {
        const activityAt = Math.max(this.runTiming.lastActivityAt, Date.now());
        this.runTiming.lastActivityAt = activityAt;
        if (event.type === "message_end" && (event.message as { role?: string } | undefined)?.role === "user") {
          this.runTiming.sawUser = true;
        }
        event = { ...event, activityAt };
      }
      if (event.type === "message_end" && this.goalRun) {
        const message = event.message as AssistantMessage | ToolResultMessage | { role?: string } | undefined;
        if (message?.role === "user") {
          this.goalRun.sawUser = true;
          this.goalRun.lastAssistant = undefined;
          this.goalRun.deliveredImage = false;
          this.goalRun.report = undefined;
        } else if (message?.role === "assistant") {
          this.goalRun.lastAssistant = message as AssistantMessage;
        } else if (message?.role === "toolResult" && this.goalRun.revision !== undefined) {
          const result = message as ToolResultMessage;
          this.recordGoalComputerUseResult(this.goalRun, result);
          if (result.toolName === "image_generate" && !result.isError
            && (result.content.some((block) => block.type === "image")
              || Boolean((result.details as { images?: unknown[] } | undefined)?.images?.length))) {
            this.goalRun.deliveredImage = true;
          }
        }
      }
      if (event.type === "message_end" && this.subagentTask) {
        const message = event.message as AssistantMessage | ToolResultMessage | { role?: string } | undefined;
        if (message?.role === "assistant") {
          this.subagentTask.sawFinalAssistant = (message as AssistantMessage).stopReason === "stop";
        } else if (message?.role === "toolResult"
          && this.goalRun?.revision === undefined && deniedComputerUsePermission(message as ToolResultMessage)) {
          this.subagentTask.waitingForUser = true;
        }
      }
      if (event.type === "agent_end") {
        this.clearToolFileChangeTracking();
        try {
          // pi-image-gen returns a successful image as a toolResult rather than
          // a normal assistant usage message. Persist a small, private billing
          // marker before the web client reloads the session so the relay usage
          // overlay can reconcile the image charge independently of text cost.
          appendRelayImageBillingEntries(this.inner.sessionManager);
        } catch (error) {
          console.error(
            "[meteoragent] failed to persist image billing metadata:",
            error instanceof Error ? error.message : error,
          );
        }
        invalidateSessionListCache();
      }
      const toolCallId = event.toolCallId;
      if (typeof toolCallId === "string") {
        if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
          this.activeToolEvents.set(toolCallId, event);
        } else if (event.type === "tool_execution_end") {
          this.activeToolEvents.delete(toolCallId);
        }
      }
      if (IDLE_RESET_EVENT_TYPES.has(event.type)) this.resetIdleTimer();
      if (event.type === "agent_settled") {
        this.computerUseApprovalRun = undefined;
        this.finishRunTiming();
      }
      if (event.type === "queue_update") {
        // Pi emits before inserting the core message. Publish the settled state.
        queueMicrotask(() => {
          if (this._alive) this.emit({ type: "queue_update", ...this.inputQueue.snapshot() });
        });
      } else if (event.type === "agent_start") {
        const resumedGoal = this.goalRun?.resumedGoal;
        if (this.goalRun) this.goalRun.resumedGoal = undefined;
        this.emit({ ...event, computerUseApprovalPolicy: this.activeComputerUseApprovalPolicy,
          runActivity: this.runActivity, ...(resumedGoal ? { resumedGoal } : {}) });
      } else if (event.type === "message_end" && (event.message as { role?: string } | undefined)?.role === "user") {
        const mode = this.workModeState.workMode;
        const isSteering = this.inputQueue.isSteeringInput(event.message);
        // Pi writes the user message directly after this callback returns.
        try {
          appendUserTurnMetadata(this.inner.sessionManager, mode, isSteering);
        } catch (error) {
          console.error("[meteoragent] failed to persist user turn metadata:", error);
        }
        this.emit({ ...event, turnWorkMode: mode, ...(isSteering ? { isSteering: true } : {}) });
      } else {
        this.emit(event);
      }
      if (event.type === "agent_settled") this.notifyAgentRunCompleteIfIdle();
    });
    this.resetIdleTimer();
  }

  private notifyAgentRunCompleteIfIdle(): void {
    if (this.isRunning()) return;
    this.finishRunTiming();
    this.computerUseApprovalRun = undefined;
    this.runGoalSnapshot = undefined;
    this.goalRun = undefined;
    if (!this.agentRunNeedsCompletion) return;
    this.agentRunNeedsCompletion = false;
    if (this.suppressCompletionNotifications) return;
    try {
      this.onAgentRunComplete?.(this.sessionId);
    } catch (error) {
      console.error("[meteoragent] completion listener failed:", error instanceof Error ? error.message : error);
    }
  }

  beginExtensionBinding(): void {
    void this.ensureExtensionsBound().catch((err) => {
      console.error("[meteoragent] failed to dispatch session_start to extensions:", err instanceof Error ? err.message : err);
    });
  }

  async waitUntilReady(): Promise<void> {
    await this.waitForExtensionsBound();
  }

  private ensureExtensionsBound(): Promise<void> {
    if (this.extensionsBound) {
      return Promise.resolve();
    }
    if (this.extensionBindingPromise) return this.extensionBindingPromise;

    this.extensionBindingError = null;
    this.extensionBindingPromise = (async () => {
      if (!this._alive) return;
      const uiContext = this.createExtensionUiContext();
      if (typeof this.inner.bindExtensions === "function") {
        const bindExtensions = this.inner.bindExtensions as (bindings: {
          uiContext?: ExtensionUiContextLike;
          mode?: "rpc";
          commandContextActions?: ExtensionCommandContextActionsLike;
          shutdownHandler?: () => void;
          onError?: (error: { extensionPath: string; event: string; error: string }) => void;
        }) => Promise<void>;
        await bindExtensions.call(this.inner, {
          uiContext,
          mode: "rpc",
          commandContextActions: this.createExtensionCommandContextActions(),
          shutdownHandler: () => this.emit({
            type: "extension_ui_request",
            id: randomUUID(),
            method: "notify",
            notifyType: "warning",
            message: "Extension requested shutdown, but shutdown is not supported in MeteorAgent.",
          } as ExtensionUiRequest as AgentEvent),
          onError: (error) => this.emit({
            type: "extension_error",
            extensionPath: error.extensionPath,
            event: error.event,
            error: error.error,
          }),
        });
      } else {
        this.inner.extensionRunner.setUIContext?.(uiContext, "rpc");
      }
      this.extensionsBound = true;
      console.log(`[meteoragent] session_start dispatched to extensions for session ${this.inner.sessionId}`);
    })().catch((err) => {
      this.extensionBindingError = err;
      throw err;
    });

    return this.extensionBindingPromise;
  }

  private async waitForExtensionsBound(): Promise<void> {
    try {
      if (this.extensionBindingPromise) await this.extensionBindingPromise;
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (this.extensionBindingError) {
      throw this.extensionBindingError instanceof Error
        ? this.extensionBindingError
        : new Error(String(this.extensionBindingError));
    }
  }

  private shouldWaitForExtensions(type: string): boolean {
    return type === "prompt"
      || type === "steer"
      || type === "follow_up"
      || type === "get_commands"
      || type === "get_state";
  }

  private async withFinalIdleReset<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      this.resetIdleTimer();
    }
  }

  /** Reject requests that would use a stale/unauthorized relay model. */
  private assertRelayModelAuthorized(provider: string, modelId: string): void {
    const relayGroups = readRelayGroups();
    const indexedRelayProviders = new Set(relayGroups.map((group) => group.providerId));
    if (process.env.NEXT_PUBLIC_AUTH_GATE === "1" && !indexedRelayProviders.has(provider)) {
      throw new Error("该模型不属于当前账户分组，请先同步账户分组");
    }
    const authorized = relayAuthorizedModelIdsByProvider().get(provider);
    if (authorized && !authorized.has(modelId)) {
      throw new Error("该模型未开放给当前 API Key，请先同步当前账户分组");
    }
  }

  private installExactSystemPromptContinuation(): void {
    if (!this.exactSystemPrompt) return;
    const previous = this.inner.agent.prepareNextTurnWithContext;
    this.inner.agent.prepareNextTurnWithContext = async (turn, signal) => {
      const prepared = await previous?.(turn, signal);
      return {
        ...prepared,
        context: {
          ...(prepared?.context ?? turn.context),
          systemPrompt: this.exactSystemPrompt!(),
        },
      };
    };
  }

  getThinkingSelection(): ThinkingLevelOption | undefined {
    const branch = this.inner.sessionManager?.getBranch?.() as SessionEntry[] | undefined;
    return branch ? readSessionThinkingSelection(branch) : undefined;
  }

  private refreshRelayContextWindow(): void {
    const model = this.inner.model;
    const state = this.inner.agent.state;
    if (!model || !state) return;
    const resolved = withSavedRelayContextWindow(model);
    if (resolved !== model) state.model = resolved;
  }

  private currentThinkingLevel(): ThinkingLevelOption {
    const selection = this.getThinkingSelection();
    if (selection) return resolveThinkingLevelOption(selection, this.inner.getAvailableThinkingLevels());
    const level = this.inner.agent.state?.thinkingLevel;
    return level === "auto" || isModelThinkingLevel(level) ? level : "off";
  }

  private installThinkingSelection(): void {
    const stream = this.inner.agent.streamFunction?.bind(this.inner.agent);
    if (!stream) return;
    this.inner.agent.streamFunction = (model, context, options) => {
      const selection = this.getThinkingSelection();
      if (!selection) return stream(model, context, options);
      const effective = resolveThinkingLevelOption(selection, getSupportedThinkingLevels(model));
      if (effective === "auto") {
        return stream(model, context, withProviderDefaultThinking(model, { ...options, reasoning: undefined }, true));
      }
      if (effective === selection) return stream(model, context, options);
      return stream(model, context, { ...options, reasoning: effective === "off" ? undefined : effective });
    };
  }

  private selectThinkingLevel(requested: ThinkingLevelOption): ThinkingLevelOption {
    const level = resolveThinkingLevelOption(requested, this.inner.getAvailableThinkingLevels());
    if (level !== "auto") this.inner.setThinkingLevel(level);
    if (this.getThinkingSelection() !== level) {
      this.inner.sessionManager.appendCustomEntry(THINKING_SELECTION_TYPE, level);
    }
    invalidateSessionListCache();
    return level;
  }

  private installPromptPresetProjection(): void {
    const previousTransform = this.inner.agent.transformContext;
    this.inner.agent.transformContext = async (messages, signal) => {
      // Pi can enter the next model step after an interrupted tool batch.
      signal?.throwIfAborted();
      const current = messages.filter((message) => {
        if (message.role !== "custom") return true;
        if (message.customType === GOAL_OUTCOME_TYPE || message.customType === TURN_TIMING_TYPE) return false;
        if (message.customType === AUTOMATIC_SUBAGENT_RETRY_TYPE) return false;
        const runId = (message.details as { runId?: string } | undefined)?.runId;
        if (message.customType === GOAL_CONTINUATION_TYPE) return Boolean(this.goalRun && runId === this.goalRun.id);
        if (message.customType === SUBAGENT_RESULTS_TYPE) return Boolean(this.subagentTask && runId === this.subagentTask.id);
        return true;
      });
      const transformed = previousTransform ? await previousTransform(current, signal) : current;
      signal?.throwIfAborted();
      const subagentTask = this.subagentTask;
      if (subagentTask?.hasUnreadResults) {
        // A sibling goal-report tool in the same batch has not seen these results.
        // Count explicit retrieval only when the next model request includes them.
        for (const message of transformed) {
          if (message.role !== "toolResult" || !SUBAGENT_CONTROL_TOOLS.has(message.toolName)) continue;
          const details = message.details as SubagentToolDetails | undefined;
          if (details?.kind === "pi-web-subagent" && details.parentToolCallId && !isActiveSubagentStatus(details.status)) {
            subagentTask.markDelivered(details.sessionId, details.parentToolCallId);
          }
        }
      }
      const selection = this.effectivePromptSelection();
      const showGoalTool = selection?.mode === "goal" && this.goalRun !== undefined && this.goalRunIsCurrent(this.goalRun);
      let projectedMessages = transformed;
      if (selection?.version === 1) {
        // Keep the original behavior for conversations that already have a v1
        // snapshot. New sessions store v2 full-prompt selections.
        const extra = composeSessionSystemPrompt("", selection);
        if (extra) {
          const head = transformed[0]?.role === "system" ? transformed[0] : undefined;
          const projected = {
            ...(head ?? { role: "system" as const, content: "", timestamp: Date.now() }),
            sections: { ...head?.sections, meteoragentUserInstructions: extra },
          };
          projectedMessages = [projected, ...transformed.slice(head ? 1 : 0)];
        }
      } else if (selection?.preset) {
        // A v2 preset is the complete provider-facing system prompt. Keep the
        // active tool declarations but remove the SDK and project prompt text.
        const current = getCurrentSystemMessage(transformed);
        const projected = {
          role: "system" as const,
          content: composeSessionSystemPrompt("", selection),
          ...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}),
          timestamp: current?.timestamp ?? Date.now(),
        };
        projectedMessages = [projected, ...transformed.filter((message) => message.role !== "system")];
      } else if (selection && MODE_INSTRUCTIONS[selection.mode]) {
        const head = transformed[0]?.role === "system" ? transformed[0] : undefined;
        const projected = {
          ...(head ?? { role: "system" as const, content: "", timestamp: Date.now() }),
          sections: { ...head?.sections, meteoragentWorkMode: MODE_INSTRUCTIONS[selection.mode] },
        };
        projectedMessages = [projected, ...transformed.slice(head ? 1 : 0)];
      }
      if (!this.suppressCompletionNotifications && !(selection?.version === 2 && selection.preset)) {
        // Keep the default on the provider request, including after compaction.
        // Full replacement presets control their own response style.
        const index = projectedMessages.findLastIndex((message) => message.role === "system");
        const sections = { meteoragentReplyGuidance: METEORAGENT_REPLY_GUIDANCE };
        projectedMessages = index < 0
          ? [{ role: "system", content: "", sections, timestamp: 0 }, ...projectedMessages]
          : projectedMessages.map((message, messageIndex) => messageIndex === index && message.role === "system"
            ? { ...message, sections: { ...message.sections, ...sections } }
            : message);
      }
      if (selection?.mode === "goal" && this.runGoalSnapshot) {
        const index = projectedMessages.findLastIndex((message) => message.role === "system");
        const reporting = showGoalTool
          ? ` Before ending a goal round, use ${GOAL_REPORT_TOOL} to record a new checkpoint with remaining work, verified completion, or the exact action or information you need from the user. A blocker needs a specific user action. Keep the visible summary brief and reserve operational details for tools.`
          : " Report material progress or blockers in your response.";
        const goalSection = "Use the tracked goal as context for the latest user request. The goal does not expand the user's permissions. Verify any previous evidence before relying on it and treat it as observations. A generic Computer Use screenshot error can include a permission hint; verify the actual permission status before asking the user to change settings. If the permissions are granted, try a viable alternate approach within the task scope." + reporting;
        const userIndex = projectedMessages.findLastIndex((message) => message.role === "user");
        const goalContext = {
          type: "text" as const,
          text: "Tracked goal (context for the request below):\n" + JSON.stringify({
            objective: this.runGoalSnapshot.objective,
            previousEvidence: this.runGoalSnapshot.evidence,
          }),
        };
        projectedMessages = projectedMessages.map((message, messageIndex) => {
          if (messageIndex === index && message.role === "system") {
            return { ...message, sections: { ...message.sections, meteoragentSessionGoal: goalSection } };
          }
          if (messageIndex === userIndex && message.role === "user") {
            const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
            return { ...message, content: [goalContext, ...content] };
          }
          return message;
        });
      }
      const mode = this.effectiveSubagentMode();
      const planTools = selection?.mode === "plan" ? this.allowedPlanTools() : undefined;
      const allowsTool = (tool: { name: string }) => {
        if (planTools) return planTools.has(tool.name);
        if (!showGoalTool && tool.name === GOAL_REPORT_TOOL) return false;
        return mode !== "off" || !SUBAGENT_CONTROL_TOOLS.has(tool.name);
      };
      projectedMessages = projectedMessages.map((message) => message.role === "system" ? {
        ...message,
        toolsAdded: message.toolsAdded?.filter(allowsTool),
        toolsRemoved: message.toolsRemoved?.filter(allowsTool),
      } : message);
      if (mode !== "off" && subagentTask && subagentTask.launchCount === 0
        && subagentTask.preference !== "optional" && this.inner.getActiveToolNames().includes("Agent")) {
        // Put the instruction after all existing prompt sections while keeping
        // their tool changes in place. This projection is transient per request.
        const instruction = (subagentTask.preference === "required"
          ? REQUIRE_SUBAGENT_INSTRUCTIONS : PROACTIVE_SUBAGENT_INSTRUCTIONS) + " " + PARALLEL_SUBAGENT_INSTRUCTIONS;
        const index = projectedMessages.findLastIndex((message) => message.role === "system");
        if (index === -1) return [
          { role: "system", content: "", sections: { meteoragentDelegation: instruction }, timestamp: Date.now() },
          ...projectedMessages,
        ];
        return projectedMessages.map((message, messageIndex) => messageIndex === index && message.role === "system"
          ? { ...message, sections: { ...message.sections, meteoragentDelegation: instruction } }
          : message);
      }
      return projectedMessages;
    };
    const previousBeforeTool = this.inner.agent.beforeToolCall;
    this.inner.agent.beforeToolCall = async (context, signal) => {
      const blockingQuestion = context.assistantMessage?.content.find((block) => block.type === "toolCall" && block.name === USER_QUESTION_TOOL);
      if (blockingQuestion?.type === "toolCall"
        && (context.toolCall.name !== USER_QUESTION_TOOL || blockingQuestion.id !== context.toolCall.id)
        && this.inner.getActiveToolNames().includes(USER_QUESTION_TOOL)) {
        return { block: true, reason: "Wait for the user's answer before making another tool call." };
      }
      return this.guardToolCall(context.toolCall.name) ?? await previousBeforeTool?.(context, signal);
    };
  }

  private getBaseSystemPromptForDisplay(): string {
    const current = this.inner.agent.state?.systemPrompt ?? "";
    const base = this.exactSystemPrompt?.() ?? (this.chatOnly ? current : rebrandMeteorAgentSystemPrompt(current));
    return this.suppressCompletionNotifications
      ? base
      : [base, METEORAGENT_REPLY_GUIDANCE].filter(Boolean).join("\n\n");
  }

  private allowedPlanTools(): Set<string> {
    return new Set(this.inner.getAllTools().filter(({ name, sourceInfo }) =>
      (PLAN_TOOL_NAMES.has(name) && sourceInfo?.source === "builtin" && sourceInfo.path === `builtin:${name}`)
      || (name === USER_QUESTION_TOOL && sourceInfo?.source === "sdk" && sourceInfo.path === `<sdk:${name}>`),
    ).map(({ name }) => name));
  }

  private guardToolCall(name: string): { block: true; reason: string } | undefined {
    if (this.workModeState.workMode === "plan" && !this.allowedPlanTools().has(name)) {
      return { block: true, reason: "计划模式只允许读取、搜索和向用户提问。要执行操作，请切换到自动或目标模式后再发送新消息。" };
    }
    if (name.startsWith("computer_use_")
      && getPresetFromToolNames(this.configuredToolNames ?? this.inner.getActiveToolNames?.() ?? []) === "read-only") {
      return { block: true, reason: "只读工具预设不允许电脑操作。" };
    }
    if (SUBAGENT_CONTROL_TOOLS.has(name) && this.effectiveSubagentMode() === "off") {
      return { block: true, reason: "Subagents are disabled for this task." };
    }
    if (name === GOAL_REPORT_TOOL && (!this.goalRun || !this.goalRunIsCurrent(this.goalRun))) {
      return { block: true, reason: "No active goal is running." };
    }
    if (name === COMPUTER_USE_LAUNCH_TOOL) this.bindComputerUseLaunchApproval();
  }

  getWorkMode() {
    return this.workModeState;
  }

  private effectivePromptSelection(): SessionPromptSelection | undefined {
    const { workMode } = this.workModeState;
    if (this.promptSelection) return { ...this.promptSelection, mode: workMode };
    return workMode === "auto" ? undefined : { version: 2, preset: null, mode: workMode };
  }

  private setWorkModeState(workMode: WorkMode, pendingWorkMode: WorkMode | null): SessionWorkMode {
    const previous = this.workModeState;
    if (previous.workMode === workMode && previous.pendingWorkMode === pendingWorkMode) return previous;
    const next = { workMode, pendingWorkMode, workModeRevision: previous.workModeRevision + 1 };
    appendSessionWorkMode(this.inner.sessionManager, next);
    this.workModeState = next;
    if (pendingWorkMode !== null) this.subagentWait?.abort();
    if (workMode !== previous.workMode) this.applyActiveToolSelection();
    this.emit({ type: "work_mode_changed", ...next });
    return next;
  }

  private changeWorkMode(mode: unknown): SessionWorkMode {
    if (!isWorkMode(mode)) throw new Error("work mode must be auto, plan, or goal");
    if (this.suppressCompletionNotifications) throw new Error("A subagent cannot change its work mode");
    this.refreshUnstartedPromptSelection();
    if (!this.isRunning() && !this.activeQueueSubmissions && !this.hasQueuedUserMessages()) {
      return this.setWorkModeState(mode, null);
    }
    const modeInUse = this.workModeState.workMode;
    return this.setWorkModeState(modeInUse, mode === modeInUse ? null : mode);
  }

  private refreshUnstartedPromptSelection(): void {
    if (!this.promptSelection || this.isRunning()) return;
    const entries = this.inner.sessionManager.getEntries() as unknown as SessionEntry[];
    if (entries.some((entry) => entry.type === "message"
      && (entry.message.role === "user" || entry.message.role === "assistant"))) return;
    const next = promptSelectionFromSettings(readPromptPresetSettings());
    if (JSON.stringify(next) === JSON.stringify(this.promptSelection)) return;
    this.promptSelection = next;
    appendSessionPromptSelection(this.inner.sessionManager, next);
    if (this.workModeState.workModeRevision === 0) {
      this.workModeState = { ...this.workModeState, workMode: next.mode };
    }
    this.applyActiveToolSelection();
  }

  setActiveToolSelection(toolNames: string[], useDefaultPlanTools = false): void {
    this.configuredToolNames = [...toolNames];
    this.useDefaultPlanTools = useDefaultPlanTools;
    this.applyActiveToolSelection();
  }

  private applyActiveToolSelection(): void {
    if (this.chatOnly) return;
    const toolNames = this.configuredToolNames ??= this.inner.getActiveToolNames();
    const planTools = this.workModeState.workMode === "plan" ? this.allowedPlanTools() : undefined;
    const selected = this.suppressCompletionNotifications ? toolNames
      : planTools ? (this.useDefaultPlanTools ? [...planTools] : [...new Set([...toolNames, USER_QUESTION_TOOL])].filter((name) => planTools.has(name)))
      : withExtensionTools(this.inner, toolNames);
    this.inner.setActiveToolsByName(this.effectiveSubagentMode(selected) === "off"
      ? selected.filter((name) => !SUBAGENT_CONTROL_TOOLS.has(name))
      : selected);
  }

  private hasQueuedUserMessages(): boolean {
    return Boolean(this.inner.getSteeringMessages?.().length || this.inner.getFollowUpMessages?.().length);
  }

  private finalizeBranchedSession(manager: SessionManager, path: string): string {
    if (!this.suppressCompletionNotifications) inheritSessionWorkMode(manager, this.workModeState.workMode);
    if (manager.getSessionFile() !== path || !persistPreparedSession(manager)) {
      throw new Error("Forked session is missing its session file");
    }
    return manager.getSessionId();
  }

  private assertWorkModeAllowsPrompt(workMode: WorkMode, message: unknown): void {
    if (workMode === "plan" && /^\s*\//.test(String(message ?? ""))) {
      throw new Error("计划模式不运行插件命令。请直接描述要分析的任务，或切换到自动或目标模式。");
    }
  }

  private async queueUserPrompt(
    behavior: "steer" | "followUp",
    message: string,
    images: ImageContent[] | undefined,
  ): Promise<void> {
    this.assertWorkModeAllowsPrompt(this.workModeState.workMode, message);
    if (this.workModeState.pendingWorkMode !== null && !this.inner.isStreaming) {
      throw new Error("上一轮已结束。消息没有排入队列，请重新发送，让新模式生效。");
    }
    this.activeQueueSubmissions += 1;
    try {
      if (behavior === "steer") await this.inner.steer(message, images, { source: "rpc" });
      else await this.inner.followUp(message, images, { source: "rpc" });
      if (this.hasQueuedUserMessages()) this.subagentWait?.abort();
    } finally {
      this.activeQueueSubmissions -= 1;
    }
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error(
          `[meteoragent] failed to deliver ${event.type} event:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  private async acquirePromptAdmission(): Promise<() => void> {
    const previous = this.promptAdmissionTail;
    let release!: () => void;
    this.promptAdmissionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this._alive) return;
    // A resolved timeout of 0 disables idle shutdown entirely.
    if (SESSION_IDLE_TIMEOUT_MS === 0) return;
    if (!this.isRunning()) this.forceShutdownOnIdle = false;
    this.idleTimer = setTimeout(() => {
      if (!this.forceShutdownOnIdle && (this.isRunning() || hasActiveSessionLivenessProvider({
        sessionId: this.sessionId,
        sessionFile: this.sessionFile || undefined,
      }))) {
        this.resetIdleTimer();
        return;
      }
      void this.shutdown().catch((error) => {
        console.error("[meteoragent] failed to shut down idle session:", error instanceof Error ? error.message : error);
      });
    }, SESSION_IDLE_TIMEOUT_MS);
  }

  persistUnflushedSession(): void {
    const sessionFile = persistPreparedSession(this.inner.sessionManager);
    if (sessionFile) cacheSessionPath(this.inner.sessionId, sessionFile);
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    for (const event of this.pendingUiRequests.values()) listener(event);
    for (const event of this.activeToolEvents.values()) listener(event);
    for (const run of SUBAGENT_CONTROLLER.listActive(this.sessionId)) listener(subagentStatusEvent(run));
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  onDestroy(cb: () => void): void {
    this.onDestroyCallback = cb;
  }

  private async withSessionReplacement<T>(
    replacement: "fork" | "clone",
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.sessionReplacement) throw new Error("Session is already being copied");
    this.sessionReplacement = replacement;
    try {
      return await operation();
    } finally {
      if (this._alive) this.sessionReplacement = null;
    }
  }

  private isSessionRunningForReplacement(): boolean {
    return this.inner.isBashRunning
      || this.inner.isStreaming
      || this.inner.isCompacting
      || this.activeQueueSubmissions > 0
      || this.pendingPromptCount > 0;
  }

  private async shutdownAfterSessionReplacement(replacement: "fork" | "clone"): Promise<void> {
    try {
      await this.shutdown();
    } catch (error) {
      console.error(
        `[meteoragent] ${replacement} succeeded, but source session shutdown failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    const type = command.type as string;
    const allowedDuringReplacement = COMMANDS_ALLOWED_DURING_SESSION_REPLACEMENT.has(type);
    if (this.reloadingResources && !allowedDuringReplacement) {
      throw new Error("会话正在重新加载，请稍后再试。");
    }
    if (this.sessionReplacement && !allowedDuringReplacement) {
      throw new Error("Session is being copied to a new session");
    }
    if (SESSION_REPLACEMENT_COMMAND_TYPES.has(type) && this.activeMutatingCommands > 0) {
      throw new Error(`Cannot ${type} while another session command is running`);
    }

    const tracksMutation = !allowedDuringReplacement;
    if (tracksMutation) this.activeMutatingCommands += 1;

    try {
      // Status reconciliation must not postpone forced cleanup after Stop.
      if (type !== "get_state") this.resetIdleTimer();
      if (this.shouldWaitForExtensions(type)) await this.waitForExtensionsBound();
      if (this.sessionReplacement && !allowedDuringReplacement) {
        throw new Error("Session is being copied to a new session");
      }

      if (type === "prompt" || type === "steer" || type === "follow_up") {
        const imageError = validateAgentImages(command.images);
        if (imageError) throw new Error(imageError);
        if (Array.isArray(command.images)) {
          this.inputQueue.rememberDraft(command.images as ImageContent[], command.draftMessage, command.imagePaths);
        }
      }

      switch (type) {
      case "set_work_mode":
        return this.changeWorkMode(command.mode);

      case "get_prompt_selection": {
        this.refreshUnstartedPromptSelection();
        return { selection: this.effectivePromptSelection() ?? null, baseSystemPrompt: this.getBaseSystemPromptForDisplay() };
      }
      case "prompt": {
        // Serialize only admission. Once the preceding prompt has either
        // passed or failed preflight, the SDK can atomically decide whether
        // this submission starts a run or joins its streaming queue.
        const releaseAdmission = await this.acquirePromptAdmission();
        let promotedFrom: SessionWorkMode | undefined;
        let promotedRevision: number | undefined;
        let preflightAccepted = false;
        try {
          this.refreshUnstartedPromptSelection();
          const streamingBehavior = command.streamingBehavior as "steer" | "followUp" | undefined;
          const freshPrompt = !this.isRunning() && !streamingBehavior;
          const { workMode, pendingWorkMode } = this.workModeState;
          const nextWorkMode = freshPrompt ? pendingWorkMode ?? workMode : workMode;
          this.assertWorkModeAllowsPrompt(nextWorkMode, command.message);
          const requestedApproval = command.computerUseApprovalPolicy;
          if (requestedApproval !== undefined && !isComputerUseApprovalPolicy(requestedApproval)) {
            throw new Error("Invalid computer use approval policy");
          }
          if (this.inner.isBashRunning) {
            throw new Error("Cannot send a prompt while a shell command is running");
          }
          if (this.inner.model) {
            this.assertRelayModelAuthorized(this.inner.model.provider, this.inner.model.id);
          }
          if (freshPrompt) this.refreshRelayContextWindow();
          if (this.extensionUiAbortController.signal.aborted) {
            this.extensionUiAbortController = new AbortController();
          }
          const promptImages = command.images as ImageContent[] | undefined;
          if (pendingWorkMode !== null) {
            if (streamingBehavior) {
              // SDK prompt(streamingBehavior) may start a fresh turn once the
              // running turn settles. An explicit queue call never does.
              await this.queueUserPrompt(streamingBehavior, command.message as string, promptImages?.length ? promptImages : undefined);
              return null;
            }
            if (!freshPrompt) throw new Error("当前任务还未结束。请排队发送，或等任务结束后再试。");
            if (this.activeQueueSubmissions || this.hasQueuedUserMessages()) {
              throw new Error("请先撤回上一轮的排队消息，再发送应用新模式的消息。");
            }
          }
          const requestedSubagentMode = command.subagentMode;
          if (requestedSubagentMode !== undefined && !isSubagentMode(requestedSubagentMode)) {
            throw new Error("subagentMode must be auto, off, or on");
          }
          if (freshPrompt) {
            if (requestedSubagentMode === "on" && (nextWorkMode === "plan" || this.chatOnly || this.suppressCompletionNotifications
              || getPresetFromToolNames(this.configuredToolNames ?? this.inner.getActiveToolNames()) === "read-only")) {
              throw new Error("Subagents cannot be required in Plan mode, read-only mode, Chat only, or a child session.");
            }
            if (pendingWorkMode !== null) {
              promotedFrom = this.workModeState;
              promotedRevision = this.setWorkModeState(nextWorkMode, null).workModeRevision;
            }
            if (this.subagentMode !== requestedSubagentMode) {
              this.subagentMode = requestedSubagentMode;
              // Keep every other tool in its current state. Queued messages
              // inherit the active run's delegation policy.
              if (!this.chatOnly && !this.suppressCompletionNotifications) {
                const active = this.inner.getActiveToolNames().filter((name) => !SUBAGENT_CONTROL_TOOLS.has(name));
                const available = this.effectiveSubagentMode() === "off"
                  ? []
                  : this.inner.getAllTools().map(({ name }) => name).filter((name) => SUBAGENT_CONTROL_TOOLS.has(name));
                const next = [...active, ...available];
                this.inner.setActiveToolsByName(next);
              }
            }
            if (requestedSubagentMode === "on" && !this.inner.getActiveToolNames().includes("Agent")) {
              throw new Error("The Agent tool is unavailable. Reload the session before requiring a subagent.");
            }
          }
          // Only the foreground user's standalone prompt can start a full-access
          // run. Queued messages use the current run's policy.
          const fullApproval = freshPrompt && requestedApproval === "full"
            && nextWorkMode !== "plan" && !this.chatOnly && !this.suppressCompletionNotifications
            && !/^\s*\//.test(String(command.message ?? ""))
            && getPresetFromToolNames(this.configuredToolNames ?? this.inner.getActiveToolNames()) !== "read-only";
          const approvalRun: ComputerUseApprovalRun | undefined = freshPrompt
            ? { policy: fullApproval ? "full" : "ask", remembered: new Set() }
            : undefined;
          const goalRun: GoalRun | undefined = freshPrompt && nextWorkMode === "goal"
            && !this.suppressCompletionNotifications && !/^\s*\//.test(String(command.message ?? ""))
            ? {
                id: randomUUID(), sawUser: false,
                replyCanResume: !this.chatOnly && Boolean(String(command.message ?? "").trim() || promptImages?.length),
                continuations: 0, recoveryUsed: false, progressCheckpoints: new Set(),
                computerPermissions: new Set(), stopped: false, deliveredImage: false,
              }
            : undefined;
          let preflightSettled = false;
          let promptSettled = false;
          let subagentTask: SubagentTask | undefined;
          let acceptPreflight!: () => void;
          let rejectPreflight!: (error: unknown) => void;
          const preflight = new Promise<void>((resolve, reject) => {
            acceptPreflight = () => {
              preflightAccepted = true;
              if (preflightSettled) return;
              preflightSettled = true;
              resolve();
            };
            rejectPreflight = (error) => {
              if (preflightSettled) return;
              preflightSettled = true;
              reject(error);
            };
          });
          const finishPrompt = (completed = false) => {
            if (promptSettled) return;
            promptSettled = true;
            if (approvalRun && this.computerUseApprovalRun === approvalRun) this.computerUseApprovalRun = undefined;
            if (subagentTask && this.currentSubagentTask === subagentTask) {
              if (completed && subagentTask.preference === "required" && subagentTask.sawFinalAssistant
                && !subagentTask.launchCount && !subagentTask.waitingForUser && !subagentTask.signal.aborted
                && goalRun?.report?.status !== "blocked" && !goalRun?.computerPermissions.size
                && this.workModeState.pendingWorkMode === null) {
                this.emit({ type: "subagent_required_unmet" });
              }
              this.currentSubagentTask = undefined;
            }
            subagentTask?.cancel();
            this.pendingPromptCount = Math.max(0, this.pendingPromptCount - 1);
            this.resetIdleTimer();
            this.notifyAgentRunCompleteIfIdle();
          };

          this.pendingPromptCount += 1;
          if (goalRun) this.goalRun = goalRun;
          let prompt: Promise<void>;
          try {
            prompt = this.inner.prompt(command.message as string, {
              ...(promptImages?.length ? { images: promptImages } : {}),
              ...(streamingBehavior ? { streamingBehavior } : {}),
              source: "rpc",
              // Queue delivery and input handlers can accept a message without
              // starting a model run. Only a started run owns its approval policy.
              preflightResult: (disposition) => {
                if (disposition === "started") {
                  this.agentRunNeedsCompletion = true;
                  this.beginRunTiming();
                  const mode = this.effectiveSubagentMode();
                  if (mode !== "off" && !this.extensionUiAbortController.signal.aborted) {
                    const prioritizeDelegation = ["high", "xhigh", "max"].includes(this.currentThinkingLevel())
                      && !/^\s*\//.test(String(command.message ?? ""));
                    subagentTask = new SubagentTask(mode === "on" ? "required" : prioritizeDelegation ? "proactive" : "optional");
                    this.currentSubagentTask = subagentTask;
                  }
                  if (approvalRun && !this.extensionUiAbortController.signal.aborted) {
                    this.computerUseApprovalRun = approvalRun;
                  }
                } else if (disposition === "queued") {
                  this.subagentWait?.abort();
                }
                acceptPreflight();
              },
            });
          } catch (error) {
            finishPrompt();
            throw error;
          }

          void prompt.then(async () => {
            // Compatibility fallback if a future SDK resolves without invoking
            // the internal callback. This waits for the run, but never acks early.
            acceptPreflight();
            if (goalRun) await this.settleGoalRun(goalRun);
            finishPrompt(true);
            if (!streamingBehavior) this.emit({ type: "prompt_done" });
          }, async (error) => {
            rejectPreflight(error);
            subagentTask?.cancel();
            if (preflightAccepted && goalRun) await this.settleGoalRun(goalRun, true);
            finishPrompt();
            invalidateSessionListCache();
            // A preflight rejection is returned by the POST itself. Only an
            // unexpected failure after acceptance needs the asynchronous event.
            if (preflightAccepted) {
              this.emit({
                type: "prompt_error",
                errorMessage: error instanceof Error ? error.message : String(error),
              });
              if (!streamingBehavior) this.emit({ type: "prompt_done" });
            }
          }).catch((error) => {
            console.error(
              "[meteoragent] prompt completion handler failed:",
              error instanceof Error ? error.message : error,
            );
          });

          await preflight;
          return null;
        } catch (error) {
          if (!preflightAccepted && promotedFrom && this.workModeState.workModeRevision === promotedRevision) {
            // Nothing ran and no newer mode choice was made. Keep the queued
            // mode change available to the user's next accepted submission.
            this.setWorkModeState(promotedFrom.workMode, promotedFrom.pendingWorkMode);
          }
          throw error;
        } finally {
          releaseAdmission();
        }
      }

      case "abort":
        this.forceShutdownOnIdle = true;
        this.computerUseApprovalRun = undefined;
        if (this.goalRun) this.goalRun.stopped = true;
        this.subagentTask?.cancel();
        // Stop must unwind extension commands that have not started the agent yet.
        this.extensionUiAbortController.abort(new DOMException("Extension UI cancelled by Stop", "AbortError"));
        try {
          await this.withFinalIdleReset(() => this.inner.abort());
          return null;
        } finally {
          if (!this.isRunning()) this.forceShutdownOnIdle = false;
        }

      case "get_state": {
        this.refreshUnstartedPromptSelection();
        if (!this.isRunning()) this.refreshRelayContextWindow();
        const model = this.inner.model;
        const contextUsage = this.inner.getContextUsage();
        const visibleSystemPrompt = this.getBaseSystemPromptForDisplay();
        return {
          sessionId: this.inner.sessionId,
          sessionFile: this.inner.sessionFile ?? "",
          isStreaming: this.inner.isStreaming,
          computerUseApprovalPolicy: this.activeComputerUseApprovalPolicy,
          isPromptRunning: this.pendingPromptCount > 0,
          runActivity: this.runActivity,
          isBashRunning: this.inner.isBashRunning,
          isCompacting: this.inner.isCompacting,
          autoCompactionEnabled: this.inner.autoCompactionEnabled,
          autoRetryEnabled: this.inner.autoRetryEnabled,
          model: model ? { id: model.id, provider: model.provider } : undefined,
          messageCount: 0,
          pendingMessageCount: this.inner.pendingMessageCount,
          queuedMessages: this.inputQueue.snapshot(),
          contextUsage: contextUsage
            ? { percent: contextUsage.percent, contextWindow: contextUsage.contextWindow, tokens: contextUsage.tokens }
            : null,
          systemPrompt: composeSessionSystemPrompt(visibleSystemPrompt, this.effectivePromptSelection()),
          baseSystemPrompt: visibleSystemPrompt,
          promptSelection: this.effectivePromptSelection() ?? null,
          ...this.workModeState,
          subagentMode: this.effectiveSubagentMode(),
          thinkingLevel: this.currentThinkingLevel(),
          extensionStatuses: this.getExtensionStatuses(),
          extensionWidgets: this.getExtensionWidgets(),
        };
      }

      case "set_model": {
        const { provider, modelId } = command as { provider: string; modelId: string };
        this.assertRelayModelAuthorized(provider, modelId);
        let model = this.inner.modelRuntime.getModel(provider, modelId);
        if (!model) {
          await this.inner.modelRuntime.refresh({ allowNetwork: false });
          model = this.inner.modelRuntime.getModel(provider, modelId);
        }
        if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
        const selection = this.getThinkingSelection();
        const previousLevel = this.currentThinkingLevel();
        await this.inner.setModel(withSavedRelayContextWindow(model));
        const mustFallBack = previousLevel !== "off"
          && resolveThinkingLevelOption(previousLevel, this.inner.getAvailableThinkingLevels()) !== previousLevel;
        const thinkingLevel = selection || mustFallBack
          ? this.selectThinkingLevel(previousLevel)
          : this.currentThinkingLevel();
        invalidateModelsCache();
        invalidateSessionListCache();
        return { id: model.id, provider: model.provider, thinkingLevel };
      }

      case "fork": {
        if (this.isSessionRunningForReplacement()) {
          throw new Error("Cannot fork while the session is running");
        }
        return this.withSessionReplacement("fork", async () => {
          const entryId = command.entryId as string;
          const sessionManager = this.inner.sessionManager;
          const currentSessionFile = this.inner.sessionFile;

          if (!sessionManager.isPersisted()) return { cancelled: true };
          if (!currentSessionFile) throw new Error("Persisted session is missing a session file");

          const entry = sessionManager.getEntry(entryId);
          if (!entry) throw new Error("Invalid entry ID for forking");

          const sessionDir = sessionManager.getSessionDir();
          let newSessionFile: string;
          let forkedManager: SessionManager;

          if (!entry.parentId) {
            // Fork before the first message: create an empty session linked to this one
            forkedManager = SessionManager.create(sessionManager.getCwd(), sessionDir, {
              parentSession: currentSessionFile,
            });
            newSessionFile = forkedManager.getSessionFile() as string;
            if (this.promptSelection) appendSessionPromptSelection(forkedManager, this.promptSelection);
          } else {
            // Fork after some history: copy path up to (but not including) the fork point
            forkedManager = SessionManager.open(currentSessionFile, sessionDir);
            const forkedPath = forkedManager.createBranchedSession(entry.parentId);
            if (!forkedPath) throw new Error("Failed to create forked session");
            newSessionFile = forkedPath;
          }

          const newSessionId = this.finalizeBranchedSession(forkedManager, newSessionFile);
          cacheSessionPath(newSessionId, newSessionFile);
          invalidateSessionListCache();
          await this.shutdownAfterSessionReplacement("fork");
          return { cancelled: false, newSessionId };
        });
      }

      case "fork_branch": {
        if (this.isSessionRunningForReplacement()) {
          throw new Error("Cannot fork while the session is running");
        }
        const entryId = command.entryId as string;
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;
        if (!sessionManager.isPersisted()) return { cancelled: true };
        if (!currentSessionFile) throw new Error("Persisted session is missing a session file");
        if (!sessionManager.getEntry(entryId)) throw new Error("Invalid entry ID for forking");

        const sessionDir = sessionManager.getSessionDir();
        const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
        const forkedPath = sourceManager.createBranchedSession(entryId);
        if (!forkedPath) throw new Error("Failed to create forked session");

        const newSessionId = this.finalizeBranchedSession(sourceManager, forkedPath);
        cacheSessionPath(newSessionId, forkedPath);
        invalidateSessionListCache();
        return { cancelled: false, newSessionId };
      }

      case "clone": {
        if (this.isSessionRunningForReplacement()) {
          throw new Error("Cannot clone while the session is running");
        }
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;
        const leafId = typeof command.leafId === "string" ? command.leafId : sessionManager.getLeafId();
        const branchHasAssistant = leafId && sessionManager.getBranch(leafId).some(
          (entry) => entry.type === "message" && entry.message.role === "assistant",
        );

        if (!sessionManager.isPersisted() || !leafId || !branchHasAssistant) return { cancelled: true };
        if (!currentSessionFile || !existsSync(currentSessionFile)) return { cancelled: true };

        return this.withSessionReplacement("clone", async () => {
          const sessionDir = sessionManager.getSessionDir();
          const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
          const clonedPath = sourceManager.createBranchedSession(leafId);
          if (!clonedPath || !existsSync(clonedPath)) throw new Error("Failed to clone current session branch");

          const newSessionId = this.finalizeBranchedSession(sourceManager, clonedPath);
          cacheSessionPath(newSessionId, clonedPath);
          invalidateSessionListCache();
          await this.shutdownAfterSessionReplacement("clone");
          return { cancelled: false, newSessionId };
        });
      }

      case "navigate_tree": {
        if (this.inner.isBashRunning) {
          throw new Error("Cannot navigate while a shell command is running");
        }
        const result = await this.inner.navigateTree(command.targetId as string, {});
        return { cancelled: result.cancelled };
      }

      case "set_thinking_level": {
        const level = command.level;
        if (level !== "auto" && !isModelThinkingLevel(level)) throw new Error("Invalid thinking level");
        if (this.isRunning()) throw new Error("Cannot change reasoning while a task is running");
        return { thinkingLevel: this.selectThinkingLevel(level) };
      }

      case "compact": {
        try {
          if (!this.isRunning()) this.refreshRelayContextWindow();
          return await this.withFinalIdleReset(() =>
            this.inner.compact(command.customInstructions as string | undefined)
          );
        } finally {
          invalidateSessionListCache();
        }
      }

      case "set_session_name": {
        const name = (command.name as string | undefined)?.trim();
        if (!name) throw new Error("Session name cannot be empty");
        this.inner.setSessionName(name);
        invalidateSessionListCache();
        return null;
      }

      case "get_session_stats": {
        return {
          ...this.inner.getSessionStats(),
          sessionName: this.inner.sessionManager.getSessionName(),
        };
      }

      case "get_last_assistant_text": {
        return { text: this.inner.getLastAssistantText() ?? "" };
      }

      case "set_auto_compaction": {
        this.inner.setAutoCompactionEnabled(command.enabled as boolean);
        return null;
      }

      case "clear_queue": {
        return this.inner.clearQueue();
      }

      case "update_queue_item": {
        const { id, action } = command;
        if (typeof id !== "string" || (action !== "recall" && action !== "steer")) {
          throw new Error("A queue item ID and valid action are required");
        }
        const draft = this.inputQueue.update(id, action, this.inner.isStreaming || Boolean(this.subagentWait));
        if (action === "steer") this.subagentWait?.abort();
        this.emit({ type: "queue_update", ...this.inputQueue.snapshot() });
        return draft;
      }

      case "steer": {
        const steerImages = command.images as ImageContent[] | undefined;
        if (this.inner.model) this.assertRelayModelAuthorized(this.inner.model.provider, this.inner.model.id);
        await this.queueUserPrompt("steer", command.message as string, steerImages?.length ? steerImages : undefined);
        return null;
      }

      case "follow_up": {
        const followImages = command.images as ImageContent[] | undefined;
        if (this.inner.model) this.assertRelayModelAuthorized(this.inner.model.provider, this.inner.model.id);
        await this.queueUserPrompt("followUp", command.message as string, followImages?.length ? followImages : undefined);
        return null;
      }

      case "get_tools": {
        this.refreshUnstartedPromptSelection();
        const all: ToolInfo[] = this.inner.getAllTools();
        const active = new Set<string>(this.inner.getActiveToolNames());
        const configured = new Set(this.configuredToolNames ?? active);
        return all.filter((t) => t.name !== GOAL_REPORT_TOOL && t.name !== USER_QUESTION_TOOL).map((t) => ({
          ...t,
          active: active.has(t.name),
          ...(this.workModeState.workMode === "plan" ? { configuredActive: configured.has(t.name) } : {}),
        }));
      }

      case "get_commands": {
        if (this.workModeState.workMode === "plan") return { commands: [] };
        const commands: SlashCommandInfo[] = [];
        for (const registered of this.inner.extensionRunner.getRegisteredCommands()) {
          commands.push({
            name: registered.invocationName,
            description: registered.description,
            source: "extension",
            sourceInfo: registered.sourceInfo,
          });
        }
        for (const template of this.inner.promptTemplates) {
          commands.push({
            name: template.name,
            description: template.description,
            source: "prompt",
            sourceInfo: template.sourceInfo,
          });
        }
        for (const skill of this.inner.resourceLoader.getSkills().skills) {
          commands.push({
            name: `skill:${skill.name}`,
            description: skill.description,
            source: "skill",
            sourceInfo: skill.sourceInfo,
          });
        }
        return { commands };
      }

      case "set_tools": {
        const toolNames = command.toolNames as string[];
        this.setActiveToolSelection(toolNames);
        return null;
      }

      case "reload": {
        if (this.isSessionRunningForReplacement() || this.activeMutatingCommands > 1 || this.hasQueuedUserMessages()) {
          throw new Error("请等当前任务和排队消息处理完毕后再重新加载会话。");
        }
        this.reloadingResources = true;
        try {
          return await withRelayImageGenerationSession(this.inner.sessionManager, async () => {
            this.computerUseApprovalRun = undefined;
            if (this.extensionUiAbortController.signal.aborted) {
              this.extensionUiAbortController = new AbortController();
            }
            await this.waitForExtensionsBound();
            const activeToolNames = [...(this.configuredToolNames ?? this.inner.getActiveToolNames())];
            this.extensionStatuses.clear();
            this.resetExtensionWidgetsForReload();
            // Refresh the package settings before ResourceLoader resolves packages.
            await this.inner.settingsManager.reload?.();
            this.syncProjectTrust();
            await this.inner.reload();
            this.autoApprovedLaunches.clear();
            this.setActiveToolSelection(activeToolNames, this.useDefaultPlanTools);
            if (typeof this.inner.bindExtensions !== "function") {
              this.inner.extensionRunner.setUIContext?.(this.createExtensionUiContext(), "rpc");
            }
            invalidateModelsCache();
            return { success: true };
          });
        } finally {
          this.reloadingResources = false;
          this.resetIdleTimer();
        }
      }

      case "abort_compaction": {
        this.inner.abortCompaction();
        return null;
      }

      case "extension_ui_response": {
        this.resolveExtensionUiResponse(command as ExtensionUiResponse);
        return null;
      }

      case "extension_ui_input": {
        this.handleExtensionUiInput(command.id as string, command.data as string);
        return null;
      }

      case "set_auto_retry": {
        this.inner.setAutoRetryEnabled(command.enabled as boolean);
        return null;
      }

      case "bash": {
        if (this.workModeState.workMode === "plan" || this.workModeState.pendingWorkMode === "plan") {
          throw new Error("计划模式不执行命令，请先切换到自动或目标模式。");
        }
        if (this.pendingPromptCount > 0 || this.inner.isStreaming || this.inner.isCompacting || this.inner.isBashRunning) {
          throw new Error("Cannot run a shell command while the session is busy");
        }
        const execution = this.inner.executeBash(
          command.command as string,
          undefined,
          {
            excludeFromContext: command.excludeFromContext as boolean | undefined,
            operations: createProjectCommandBashOperations({
              shellPath: this.inner.settingsManager.getShellPath(),
            }),
          },
        );
        try {
          const result = await execution;
          this.persistUnflushedSession();
          return result;
        } finally {
          this.resetIdleTimer();
          invalidateSessionListCache();
        }
      }

      case "abort_bash": {
        this.forceShutdownOnIdle = true;
        this.inner.abortBash();
        return null;
      }

        default:
          throw new Error(`Unsupported command: ${type}`);
      }
    } finally {
      if (tracksMutation) this.activeMutatingCommands = Math.max(0, this.activeMutatingCommands - 1);
    }
  }

  destroy(): void {
    if (!this._alive) return;
    this._alive = false;
    this.subagentTask?.cancel();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.inner.isBashRunning) this.inner.abortBash();
    this.unsubscribe?.();
    for (const pending of this.pendingUiResponses.values()) pending.cancel();
    for (const id of Array.from(this.activeCustomUis.keys())) this.closeCustomUi(id, undefined);
    this.pendingUiResponses.clear();
    this.pendingUiRequests.clear();
    this.activeToolEvents.clear();
    this.computerUseApprovalRun = undefined;
    this.clearExtensionWidgets(false);

    const finishDispose = () => {
      try {
        this.inner.dispose();
      } finally {
        this.onDestroyCallback?.();
      }
    };

    // Always emit session_shutdown before dispose, even when callers skip
    // shutdown() (process exit, direct destroy). Await when possible so
    // extension MCP children can reap before the runner is invalidated.
    if (this.sessionShutdownEmitted) {
      finishDispose();
      return;
    }

    this.sessionShutdownEmitted = true;
    const emit = this.inner.extensionRunner?.emit;
    if (typeof emit !== "function") {
      finishDispose();
      return;
    }

    void (async () => emit.call(
      this.inner.extensionRunner,
      { type: "session_shutdown", reason: "quit" },
    ))()
      .catch((error) => {
        console.error(
          "[meteoragent] session_shutdown before dispose failed:",
          error instanceof Error ? error.message : error,
        );
      })
      .finally(finishDispose);
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (!this._alive) return;
    this.subagentTask?.cancel();

    this.shutdownPromise = (async () => {
      try {
        try {
          await this.waitForExtensionsBound();
        } catch (error) {
          console.error(
            "[meteoragent] extension binding failed before session shutdown:",
            error instanceof Error ? error.message : error,
          );
        }
        if (!this.sessionShutdownEmitted) {
          this.sessionShutdownEmitted = true;
          await this.inner.extensionRunner.emit?.({ type: "session_shutdown", reason: "quit" });
        }
      } finally {
        this.destroy();
      }
    })();
    return this.shutdownPromise;
  }

  private resolveExtensionUiResponse(response: ExtensionUiResponse): void {
    const pending = this.pendingUiResponses.get(response.id);
    if (!pending) return;
    pending.resolve(response);
  }

  private getExtensionStatuses(): Array<{ key: string; text: string }> {
    return Array.from(this.extensionStatuses, ([key, text]) => ({ key, text }));
  }

  private getExtensionWidgets(): ExtensionWidgetItem[] {
    return Array.from(this.extensionWidgets.values());
  }

  private nextExtensionWidgetGeneration(key: string): number {
    const generation = (this.extensionWidgetGenerations.get(key) ?? 0) + 1;
    this.extensionWidgetGenerations.set(key, generation);
    return generation;
  }

  private disposeExtensionWidgetComponent(component: unknown): void {
    if (!component || (typeof component !== "object" && typeof component !== "function")) return;
    const dispose = (component as { dispose?: unknown }).dispose;
    if (typeof dispose !== "function") return;
    try {
      dispose.call(component);
    } catch {
      // Ignore dispose errors from extension widgets.
    }
  }

  private emitExtensionWidgetClear(key: string): void {
    this.emit({
      type: "extension_ui_request",
      id: randomUUID(),
      method: "setWidget",
      widgetKey: key,
      widgetLines: undefined,
      widgetPlacement: undefined,
    } as ExtensionUiRequest as AgentEvent);
  }

  private clearExtensionWidget(key: string, emitClear = true): number {
    const generation = this.nextExtensionWidgetGeneration(key);

    const active = this.activeExtensionWidgets.get(key);
    this.activeExtensionWidgets.delete(key);
    this.extensionWidgets.delete(key);
    if (active) this.disposeExtensionWidgetComponent(active.component);
    if (this.extensionWidgetGenerations.get(key) !== generation) return generation;
    if (emitClear) this.emitExtensionWidgetClear(key);
    return generation;
  }

  private clearExtensionWidgets(emitClear: boolean): void {
    const keys = new Set([
      ...this.extensionWidgets.keys(),
      ...this.activeExtensionWidgets.keys(),
    ]);
    for (const key of keys) this.clearExtensionWidget(key, emitClear);
  }

  private resetExtensionWidgetsForReload(): void {
    this.extensionWidgetsResetting = true;
    try {
      const factoryKeys = [...this.activeExtensionWidgets.keys()];
      for (const key of factoryKeys) this.clearExtensionWidget(key);
      // Keep the existing array-widget reload behavior: snapshots are reset and
      // the next extension session_start repopulates them.
      this.extensionWidgets.clear();
    } finally {
      this.extensionWidgetsResetting = false;
    }
  }

  private emitExtensionWidgetError(key: string, error: unknown): void {
    this.emit({
      type: "extension_error",
      extensionPath: `extension-widget:${key}`,
      event: "setWidget",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private failExtensionWidget(
    key: string,
    generation: number,
    error: unknown,
    clearEmitted: boolean,
    component?: unknown,
  ): void {
    if (this.extensionWidgetGenerations.get(key) !== generation) {
      this.disposeExtensionWidgetComponent(component);
      return;
    }

    const active = this.activeExtensionWidgets.get(key);
    let shouldEmitClear = !clearEmitted;
    if (active?.generation === generation) {
      shouldEmitClear = active.rendered || !active.clearEmitted;
      this.activeExtensionWidgets.delete(key);
      this.disposeExtensionWidgetComponent(active.component);
    } else {
      this.disposeExtensionWidgetComponent(component);
    }
    if (this.extensionWidgetGenerations.get(key) !== generation) {
      this.emitExtensionWidgetError(key, error);
      return;
    }
    this.extensionWidgets.delete(key);
    if (shouldEmitClear) this.emitExtensionWidgetClear(key);
    this.emitExtensionWidgetError(key, error);
  }

  private renderExtensionWidget(active: ActiveExtensionWidget): void {
    if (
      this.activeExtensionWidgets.get(active.key) !== active
      || this.extensionWidgetGenerations.get(active.key) !== active.generation
    ) return;

    let lines: unknown;
    try {
      lines = active.component.render(DEFAULT_CUSTOM_UI_COLUMNS);
    } catch (error) {
      this.failExtensionWidget(active.key, active.generation, error, active.clearEmitted);
      return;
    }
    if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string")) {
      this.failExtensionWidget(
        active.key,
        active.generation,
        new Error("Extension widget render must return string[]"),
        active.clearEmitted,
      );
      return;
    }
    if (
      this.activeExtensionWidgets.get(active.key) !== active
      || this.extensionWidgetGenerations.get(active.key) !== active.generation
    ) return;

    const widgetLines = [...lines] as string[];
    this.extensionWidgets.set(active.key, {
      key: active.key,
      lines: widgetLines,
      placement: active.placement,
    });
    active.rendered = true;
    this.emit({
      type: "extension_ui_request",
      id: randomUUID(),
      method: "setWidget",
      widgetKey: active.key,
      widgetLines,
      widgetPlacement: active.placement,
    } as ExtensionUiRequest as AgentEvent);
  }

  private setExtensionWidgetFactory(
    key: string,
    factory: ExtensionWidgetFactory,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void {
    const hadPrevious = this.extensionWidgets.has(key) || this.activeExtensionWidgets.has(key);
    const generation = this.clearExtensionWidget(key, hadPrevious);
    if (this.extensionWidgetGenerations.get(key) !== generation) return;
    const tui = createHeadlessCustomUiTui(() => {
      const active = this.activeExtensionWidgets.get(key);
      if (active?.generation === generation) this.renderExtensionWidget(active);
    }, DEFAULT_CUSTOM_UI_COLUMNS);

    let component: unknown;
    try {
      component = factory(tui, PLAIN_TEXT_THEME);
    } catch (error) {
      this.failExtensionWidget(key, generation, error, hadPrevious);
      return;
    }
    if (this.extensionWidgetGenerations.get(key) !== generation) {
      this.disposeExtensionWidgetComponent(component);
      return;
    }
    if (
      !component
      || (typeof component !== "object" && typeof component !== "function")
      || typeof (component as { render?: unknown }).render !== "function"
    ) {
      this.failExtensionWidget(
        key,
        generation,
        new Error("Extension widget factory must return a component with render(width)"),
        hadPrevious,
        component,
      );
      return;
    }

    const active: ActiveExtensionWidget = {
      key,
      component: component as ExtensionWidgetComponent,
      placement: options?.placement ?? "aboveEditor",
      generation,
      clearEmitted: hadPrevious,
      rendered: false,
    };
    this.activeExtensionWidgets.set(key, active);
    this.renderExtensionWidget(active);
  }

  private getCustomUiWidth(options: unknown): number {
    if (!options || typeof options !== "object") return DEFAULT_CUSTOM_UI_COLUMNS;
    const overlayOptions = (options as { overlayOptions?: unknown }).overlayOptions;
    const resolved = typeof overlayOptions === "function" ? overlayOptions() : overlayOptions;
    if (!resolved || typeof resolved !== "object") return DEFAULT_CUSTOM_UI_COLUMNS;
    const width = (resolved as { width?: unknown }).width;
    return typeof width === "number" && Number.isFinite(width)
      ? Math.max(40, Math.min(140, Math.round(width)))
      : 92;
  }

  private emitCustomUiRender(id: string, custom: ActiveCustomUi): void {
    let lines: string[];
    try {
      lines = [...custom.component.render(custom.width)];
    } catch (error) {
      lines = [`Extension custom UI render failed: ${error instanceof Error ? error.message : String(error)}`];
    }
    const event = {
      type: "extension_ui_request",
      id,
      method: "custom",
      lines,
    } as ExtensionUiRequest as AgentEvent;
    this.pendingUiRequests.set(id, event);
    this.emit(event);
  }

  private closeCustomUi(id: string, value: unknown): void {
    const custom = this.activeCustomUis.get(id);
    if (!custom || custom.settled) return;
    custom.settled = true;
    this.activeCustomUis.delete(id);
    this.pendingUiRequests.delete(id);
    try {
      custom.component.dispose?.();
    } catch {
      // Ignore dispose errors from extension UI components.
    }
    this.emit({
      type: "extension_ui_request",
      id,
      method: "custom",
      lines: [],
      closed: true,
    } as ExtensionUiRequest as AgentEvent);
    custom.resolve(value);
  }

  private handleExtensionUiInput(id: string, data: string): void {
    const custom = this.activeCustomUis.get(id);
    if (!custom || typeof data !== "string") return;
    try {
      custom.component.handleInput?.(data);
      if (this.activeCustomUis.has(id)) this.emitCustomUiRender(id, custom);
    } catch (error) {
      this.closeCustomUi(id, undefined);
      this.emit({
        type: "extension_error",
        extensionPath: `custom-ui:${id}`,
        event: "custom_ui_input",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private requestExtensionCustomUi<T>(
    factory: unknown,
    options?: unknown,
  ): Promise<T> {
    if (typeof factory !== "function") return Promise.resolve(undefined as T);

    const stopSignal = this.extensionUiAbortController.signal;
    if (stopSignal.aborted) return Promise.reject(stopSignal.reason);

    const id = randomUUID();
    const width = this.getCustomUiWidth(options);

    return new Promise<T>((resolve, reject) => {
      let completed = false;
      const tui = createHeadlessCustomUiTui(
        () => {
          const custom = this.activeCustomUis.get(id);
          if (custom) this.emitCustomUiRender(id, custom);
        },
        width,
      );
      const finish = (value: T) => {
        if (completed) return;
        completed = true;
        stopSignal.removeEventListener("abort", onStop);
        if (stopSignal.aborted) reject(stopSignal.reason);
        else resolve(value);
      };
      const done = (value: T) => {
        if (this.activeCustomUis.has(id)) {
          this.closeCustomUi(id, value);
        } else {
          finish(value);
        }
      };
      const onStop = () => done(undefined as T);
      stopSignal.addEventListener("abort", onStop, { once: true });

      Promise.resolve()
        .then(() => completed ? undefined : factory(tui, PLAIN_TEXT_THEME, CUSTOM_UI_KEYBINDINGS, done))
        .then((component) => {
          if (completed) {
            try {
              (component as CustomUiComponent | undefined)?.dispose?.();
            } catch {
              // Ignore dispose errors from a component completed before mounting.
            }
            return;
          }
          if (!component || typeof component !== "object" || typeof (component as CustomUiComponent).render !== "function") {
            finish(undefined as T);
            return;
          }
          const custom: ActiveCustomUi = {
            component: component as CustomUiComponent,
            width,
            resolve: (value) => finish(value as T),
            settled: false,
          };
          this.activeCustomUis.set(id, custom);
          this.emitCustomUiRender(id, custom);
        })
        .catch((error) => {
          if (completed) return;
          this.emit({
            type: "extension_error",
            extensionPath: `custom-ui:${id}`,
            event: "custom_ui",
            error: error instanceof Error ? error.message : String(error),
          });
          finish(undefined as T);
        });
    });
  }

  private requestExtensionUi<T>(
    request: ExtensionUiRequestBody,
    defaultValue: T,
    parseResponse: (response: ExtensionUiResponse) => T,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.resolve(defaultValue);
    const stopSignal = this.extensionUiAbortController.signal;
    if (stopSignal.aborted) return Promise.reject(stopSignal.reason);
    const abortSignal = signal ? AbortSignal.any([signal, stopSignal]) : stopSignal;
    const goalRun = this.goalRun;
    const subagentTask = this.subagentTask;

    const id = randomUUID();
    const fullRequest = {
      type: "extension_ui_request",
      id,
      ...request,
      ...(timeout ? { timeout, expiresAt: Date.now() + timeout } : {}),
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        abortSignal.removeEventListener("abort", onAbort);
        this.pendingUiRequests.delete(id);
        this.pendingUiResponses.delete(id);
        this.emit({ type: "extension_ui_closed", id });
      };
      const settle = (value: T) => {
        if (settled) return;
        settled = true;
        if (request.method === "confirm" && value === false && !abortSignal.aborted) {
          if (goalRun && this.goalRun === goalRun) goalRun.approvalRequired = true;
          if (subagentTask && this.subagentTask === subagentTask) subagentTask.waitingForUser = true;
        }
        cleanup();
        if (stopSignal.aborted) reject(stopSignal.reason);
        else resolve(value);
      };
      const onAbort = () => settle(defaultValue);

      if (timeout) timeoutId = setTimeout(() => settle(defaultValue), timeout);
      abortSignal.addEventListener("abort", onAbort, { once: true });

      this.pendingUiRequests.set(id, fullRequest as AgentEvent);
      this.pendingUiResponses.set(id, {
        resolve: (response) => settle(parseResponse(response)),
        cancel: () => settle(defaultValue),
      });
      this.emit(fullRequest as AgentEvent);
    });
  }

  private computerUseToolSource(toolName: string) {
    const source = this.inner.getAllTools().find((tool) => tool.name === toolName)?.sourceInfo;
    if (source?.origin === "package" && source.path
      && /^npm:@amaster\.ai\/pi-computer-use(?:@[^/\s]+)?$/.test(source.source)) return source;
  }

  private bindComputerUseLaunchApproval(): void {
    const tool = this.inner.getToolDefinition?.(COMPUTER_USE_LAUNCH_TOOL);
    if (!tool || this.wrappedLaunchTools.has(tool)) return;
    const source = this.computerUseToolSource(COMPUTER_USE_LAUNCH_TOOL);
    if (!source) return;

    // Pi's registered tool wrapper reads the definition's execute method at call time.
    // Scope the approval to this execution, even when other extension tools run alongside it.
    const execute = tool.execute;
    this.wrappedLaunchTools.add(tool);
    tool.execute = async (id, args, signal, onUpdate, context) => {
      signal?.throwIfAborted();
      const params = args as Record<string, unknown>;
      const target = params.bundle_id ?? params.aumid ?? params.name ?? params.app_name ?? params.path ?? params.command;
      if (typeof target !== "string" || !target.trim()) return execute.call(tool, id, args, signal, onUpdate, context);

      const run = this.computerUseApprovalRun;
      const canAutoApprove = () => run?.policy === "full" && this.computerUseApprovalRun === run
        && this.isRunning() && this.workModeState.workMode !== "plan"
        && getPresetFromToolNames(this.configuredToolNames ?? this.inner.getActiveToolNames()) !== "read-only";
      const message = `Allow pi-computer-use to launch and control ${target} for this session?`;
      // Match the extension's session cache, which uses all validated launch arguments.
      const sortedParams = Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
      const key = createHash("sha256").update(JSON.stringify([source.source, source.path, sortedParams])).digest("hex");
      let launchContext = context;
      if (canAutoApprove() && context.hasUI) {
        const ui = context.ui;
        const launchUi: typeof ui = {
          ...ui,
          confirm: (title, prompt, opts) => {
            if (title === COMPUTER_USE_LAUNCH_TITLE && prompt === message && canAutoApprove()
              && !opts?.signal?.aborted && !signal?.aborted && !this.extensionUiAbortController.signal.aborted) {
              this.autoApprovedLaunches.add(key);
              return Promise.resolve(true);
            }
            return ui.confirm(title, prompt, opts?.signal ? opts : { ...opts, signal });
          },
        };
        launchContext = Object.create(context, { ui: { value: launchUi } });
      } else if (this.autoApprovedLaunches.has(key)) {
        // An automatic approval must not count as an explicit user decision in a later task.
        if (!context.hasUI || !await this.confirmExtensionUi(COMPUTER_USE_LAUNCH_TITLE, message, { signal })) {
          throw new Error("launch_app requires interactive user confirmation.");
        }
        this.autoApprovedLaunches.delete(key);
      }
      signal?.throwIfAborted();
      return execute.call(tool, id, args, signal, onUpdate, launchContext);
    };
  }

  private computerUseApproval(title: string, message: string) {
    if (!this.computerUseApprovalRun || !this.isRunning() || this.suppressCompletionNotifications
      || this.workModeState.workMode === "plan" || this.activeToolEvents.size !== 1
      || title !== "Confirm high-risk computer action") return;
    const [toolCallId, call] = this.activeToolEvents.entries().next().value!;
    const toolName = call.toolName;
    if (typeof toolName !== "string" || !toolName.startsWith("computer_use_")) return;
    const action = toolName.slice("computer_use_".length);
    if (!AUTO_APPROVABLE_COMPUTER_ACTIONS.has(action)) return;
    const prefix = `Allow ${action} with arguments `;
    if (!message.startsWith(prefix) || !message.endsWith("?")) return;
    const source = this.computerUseToolSource(toolName);
    if (!source) return;
    try {
      const args: unknown = JSON.parse(message.slice(prefix.length, -1));
      if (!args || typeof args !== "object" || Array.isArray(args) || !isDeepStrictEqual(args, call.args)) return;
    } catch {
      return;
    }
    const key = createHash("sha256").update(JSON.stringify([source.source, source.path, title, message])).digest("hex");
    return { key, toolCallId, canRemember: action === "run_script" };
  }

  private confirmExtensionUi(title: string, message: string, opts?: { timeout?: number; signal?: AbortSignal }): Promise<boolean> {
    const run = this.computerUseApprovalRun;
    const approval = this.computerUseApproval(title, message);
    const deadline = opts?.timeout ? Date.now() + opts.timeout : undefined;
    if (approval && (run?.policy === "full" || run?.remembered.has(approval.key))
      && !opts?.signal?.aborted && !this.extensionUiAbortController.signal.aborted) {
      return Promise.resolve(true);
    }
    return this.requestExtensionUi(
      { method: "confirm", title, message, ...(approval?.canRemember ? { approvalScope: "computer-use-exact" } : {}) },
      false,
      (response) => {
        if (!("confirmed" in response) || response.confirmed !== true
          || opts?.signal?.aborted || (deadline !== undefined && Date.now() >= deadline)) return false;
        if (response.rememberForRun === true && run && this.computerUseApprovalRun === run && approval?.canRemember) {
          const current = this.computerUseApproval(title, message);
          if (current?.key === approval.key && current.toolCallId === approval.toolCallId) run.remembered.add(approval.key);
        }
        return true;
      },
      opts?.timeout,
      opts?.signal,
    );
  }

  private createExtensionUiContext(): ExtensionUiContextLike {
    return {
      select: (title, options, opts) => this.requestExtensionUi(
        { method: "select", title, options, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      confirm: (title, message, opts) => this.confirmExtensionUi(title, message, opts),
      input: (title, placeholder, opts) => this.requestExtensionUi(
        { method: "input", title, ...(placeholder !== undefined ? { placeholder } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      editor: (title, prefill, opts) => this.requestExtensionUi(
        { method: "editor", title, ...(prefill !== undefined ? { prefill } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      notify: (message, type) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "notify",
          message,
          notifyType: type,
        } as ExtensionUiRequest as AgentEvent);
      },
      onTerminalInput: () => () => {},
      setStatus: (key, text) => {
        if (text === undefined) this.extensionStatuses.delete(key);
        else this.extensionStatuses.set(key, text);
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setStatus",
          statusKey: key,
          statusText: text,
        } as ExtensionUiRequest as AgentEvent);
      },
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: (key, content, options) => {
        if (!this._alive || this.extensionWidgetsResetting) return;
        if (typeof content === "function") {
          this.setExtensionWidgetFactory(
            key,
            content as unknown as ExtensionWidgetFactory,
            options,
          );
          return;
        }
        if (content !== undefined && !Array.isArray(content)) return;
        if (content === undefined) {
          this.clearExtensionWidget(key);
          return;
        }
        const generation = this.activeExtensionWidgets.has(key)
          ? this.clearExtensionWidget(key)
          : this.nextExtensionWidgetGeneration(key);
        if (this.extensionWidgetGenerations.get(key) !== generation) return;
        this.extensionWidgets.set(key, {
          key,
          lines: content,
          placement: options?.placement ?? "aboveEditor",
        });
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setWidget",
          widgetKey: key,
          widgetLines: content,
          widgetPlacement: options?.placement,
        } as ExtensionUiRequest as AgentEvent);
      },
      setFooter: () => {},
      setHeader: () => {},
      setTitle: (title) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setTitle",
          title,
        } as ExtensionUiRequest as AgentEvent);
      },
      custom: <T = unknown>(factory: unknown, options?: unknown) => this.requestExtensionCustomUi<T>(factory, options),
      pasteToEditor: (text) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as ExtensionUiRequest as AgentEvent);
      },
      setEditorText: (text) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as ExtensionUiRequest as AgentEvent);
      },
      getEditorText: () => "",
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      get theme() { return PLAIN_TEXT_THEME; },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Theme switching is not supported in MeteorAgent extension UI yet" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }

  private createExtensionCommandContextActions(): ExtensionCommandContextActionsLike {
    return {
      waitForIdle: async () => {
        const agent = this.inner.agent as { waitForIdle?: () => Promise<void> };
        await agent.waitForIdle?.();
      },
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      navigateTree: async (targetId, options) => {
        const result = await this.inner.navigateTree(targetId, { summarize: options?.summarize });
        return { cancelled: result.cancelled };
      },
      switchSession: async () => ({ cancelled: true }),
      reload: async () => {
        this.computerUseApprovalRun = undefined;
        this.extensionStatuses.clear();
        this.resetExtensionWidgetsForReload();
        await this.inner.settingsManager.reload?.();
        this.syncProjectTrust();
        await this.inner.reload({
          beforeSessionStart: () => {
            this.inner.extensionRunner.setUIContext?.(this.createExtensionUiContext(), "rpc");
          },
        });
        this.autoApprovedLaunches.clear();
        this.applyActiveToolSelection();
      },
    };
  }

  private syncProjectTrust(): void {
    const status = getProjectTrustStatus(this.cwd, getAgentDir());
    this.inner.settingsManager.setProjectTrusted(status.trusted);
  }
}

// ============================================================================
// Session registry
// ============================================================================

declare global {
  var __piSessions: Map<string, AgentSessionWrapper> | undefined;
  var __piStartLocks: Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> | undefined;
  var __piStartingSessionCwds: Map<string, number> | undefined;
}

function getRegistry(): Map<string, AgentSessionWrapper> {
  if (!globalThis.__piSessions) {
    globalThis.__piSessions = new Map();
    const destroy = () => globalThis.__piSessions?.forEach((session) => session.destroy());
    const shutdown = () => {
      const sessions = Array.from(globalThis.__piSessions?.values() ?? []);
      void Promise.allSettled(sessions.map((session) => session.shutdown()));
    };
    // Node cannot await work from an exit handler; direct destruction starts
    // extension cleanup synchronously as a final best effort.
    process.once("exit", destroy);
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
  return globalThis.__piSessions;
}

function registerRpcWrapper(wrapper: AgentSessionWrapper): void {
  const registry = getRegistry();
  const sessionId = wrapper.sessionId;
  if (wrapper.sessionFile) cacheSessionPath(sessionId, wrapper.sessionFile);
  wrapper.onDestroy(() => registry.delete(sessionId));
  registry.set(sessionId, wrapper);
  wrapper.start();
  if (!wrapper.isChatOnly()) wrapper.beginExtensionBinding();
}

const SUBAGENT_CONTROLLER = createSubagentController({
  getSession: (sessionId) => getRegistry().get(sessionId),
  registerSession: (inner, options) => {
    const wrapper = new AgentSessionWrapper(inner, {
      ...(options?.exactSystemPrompt !== undefined
        ? { exactSystemPrompt: () => options.exactSystemPrompt! }
        : {}),
      chatOnly: options?.chatOnly,
      suppressCompletionNotifications: true,
    });
    registerRpcWrapper(wrapper);
  },
  reopenSession: async (sessionId, sessionFile) =>
    (await startRpcSession(sessionId, sessionFile, undefined)).session,
  resolveSessionPath,
  invalidateSessionList: invalidateSessionListCache,
  subagentMode: (parentId) => getRegistry().get(parentId)?.effectiveSubagentMode() ?? "off",
  subagentTask: (parentId) => getRegistry().get(parentId)?.subagentTask,
  publishStatus: (run) => getRegistry().get(run.parentSessionId)?.publishSubagentStatus(run),
});

export function getSubagentRun(sessionId: string) {
  return SUBAGENT_CONTROLLER.get(sessionId);
}

export function steerSubagent(sessionId: string, message: string) {
  return SUBAGENT_CONTROLLER.steer(sessionId, message);
}

export function abortSubagent(sessionId: string) {
  return SUBAGENT_CONTROLLER.abort(sessionId);
}

function getLocks(): Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> {
  if (!globalThis.__piStartLocks) globalThis.__piStartLocks = new Map();
  return globalThis.__piStartLocks;
}

function normalizeRpcCwd(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  try {
    return realpathSync(resolvedCwd);
  } catch {
    return resolvedCwd;
  }
}

function getStartingSessionCwds(): Map<string, number> {
  if (!globalThis.__piStartingSessionCwds) globalThis.__piStartingSessionCwds = new Map();
  return globalThis.__piStartingSessionCwds;
}

function trackStartingSession(cwd: string): () => void {
  const startingCwds = getStartingSessionCwds();
  const key = normalizeRpcCwd(cwd);
  startingCwds.set(key, (startingCwds.get(key) ?? 0) + 1);
  return () => {
    const remaining = (startingCwds.get(key) ?? 1) - 1;
    if (remaining > 0) startingCwds.set(key, remaining);
    else startingCwds.delete(key);
  };
}

export function getRpcSession(sessionId: string): AgentSessionWrapper | undefined {
  return getRegistry().get(sessionId);
}

export interface SetRpcSessionToolsResult {
  session: AgentSessionWrapper;
  sessionId: string;
  recreated: boolean;
}

/** Persist a normal session's tool selection and rebuild when resource policy changes. */
export async function setRpcSessionTools(
  sessionId: string,
  sessionFile: string | undefined,
  requestedToolNames: unknown,
): Promise<SetRpcSessionToolsResult> {
  const toolNames = validateSessionToolSelection(requestedToolNames);
  const existing = getRpcSession(sessionId);

  if (!existing?.isAlive()) {
    if (!sessionFile) throw new Error("Session not found");
    const manager = SessionManager.open(sessionFile, undefined);
    if (readSubagentSessionResources(manager.getEntries() as unknown as SessionEntry[])) {
      throw new Error("Subagent tool selection is fixed by its profile");
    }
    appendSessionToolSelection(manager, toolNames);
    invalidateSessionListCache();
    const started = await startRpcSession(sessionId, sessionFile, undefined);
    return { session: started.session, sessionId: started.realSessionId, recreated: false };
  }

  if (existing.isRunning()) throw new Error("Cannot change tools while the session is running");
  if (readSubagentSessionResources(existing.inner.sessionManager.getEntries() as unknown as SessionEntry[])) {
    throw new Error("Subagent tool selection is fixed by its profile");
  }

  const hasCurrentResourcePolicy = typeof existing.isChatOnly === "function"
    && typeof existing.setActiveToolSelection === "function";
  const crossesChatOnlyBoundary = !hasCurrentResourcePolicy
    || existing.isChatOnly() !== (toolNames.length === 0);
  appendSessionToolSelection(existing.inner.sessionManager, toolNames);
  invalidateSessionListCache();

  if (!crossesChatOnlyBoundary) {
    existing.setActiveToolSelection(toolNames);
    return { session: existing, sessionId, recreated: false };
  }

  const persistedFile = existing.sessionFile && existsSync(existing.sessionFile)
    ? existing.sessionFile
    : undefined;
  const sessionCwd = existing.cwd;
  const model = existing.inner.model;
  const currentThinkingLevel = existing.getThinkingSelection?.() ?? existing.inner.agent.state?.thinkingLevel;
  await existing.shutdown();

  if (persistedFile) {
    const started = await startRpcSession(sessionId, persistedFile, undefined);
    return { session: started.session, sessionId: started.realSessionId, recreated: true };
  }

  const started = await startRpcSession(`__recreate__${randomUUID()}`, "", sessionCwd, {
    toolNames,
    ...(model ? { initialModel: { provider: model.provider, modelId: model.id } } : {}),
    allowInitialModelFallback: true,
    ...(currentThinkingLevel === "auto" || isModelThinkingLevel(currentThinkingLevel)
      ? { thinkingLevel: currentThinkingLevel }
      : {}),
  });
  return { session: started.session, sessionId: started.realSessionId, recreated: true };
}

function runtimeMessageText(entry: SessionMessageEntry): string {
  if (entry.message.role === "bashExecution") return "";
  const content = entry.message.content;
  if (typeof content === "string") return content;
  return content
    .map((block) => block.type === "text" ? block.text : "")
    .filter(Boolean)
    .join(" ");
}

function runtimeMessageActivityMs(entry: SessionMessageEntry): number | undefined {
  if (entry.message.role !== "user" && entry.message.role !== "assistant") return undefined;
  if (typeof entry.message.timestamp === "number") return entry.message.timestamp;
  const timestamp = new Date(entry.timestamp).getTime();
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

/**
 * Return live sessions that should be visible in the session list. Pi delays
 * the first JSONL flush until an assistant message exists, so an accepted new
 * prompt must temporarily be described from its in-memory SessionManager.
 */
export function getRpcSessionInfos(options: { includeTransient?: boolean } = {}): SessionInfo[] {
  const sessions: SessionInfo[] = [];
  for (const session of getRegistry().values()) {
    if (typeof session.isAlive !== "function" || !session.isAlive()) continue;

    const manager = session.inner?.sessionManager;
    if (!manager) continue;
    const header = manager.getHeader();
    const entries = manager.getEntries() as unknown as Array<
      { type: string; timestamp: string } | SessionMessageEntry
    >;
    const messages = entries.filter((entry): entry is SessionMessageEntry => entry.type === "message");
    const firstUserMessage = messages.find((entry) => entry.message.role === "user");
    const sessionFile = manager.getSessionFile() ?? session.sessionFile;
    const persisted = Boolean(sessionFile && existsSync(sessionFile));
    const subagent = readSubagentRun(entries as unknown as SessionEntry[], header?.id ?? session.sessionId, sessionFile ?? "");

    // An ensure_session call creates an idle, empty runtime while the composer
    // loads commands. Do not leak it into history before a prompt is accepted.
    if (!persisted && !options.includeTransient && (!session.isRunning() || !firstUserMessage)) continue;

    const created = header?.timestamp
      ?? entries[0]?.timestamp
      ?? new Date().toISOString();
    const headerTimestamp = new Date(created).getTime();
    let lastActivityMs = Number.isNaN(headerTimestamp) ? Date.now() : headerTimestamp;
    for (const message of messages) {
      const activityMs = runtimeMessageActivityMs(message);
      if (activityMs !== undefined) lastActivityMs = Math.max(lastActivityMs, activityMs);
    }

    sessions.push({
      path: sessionFile ?? "",
      id: header?.id ?? session.sessionId,
      cwd: header?.cwd ?? session.cwd,
      name: manager.getSessionName(),
      created,
      modified: new Date(lastActivityMs).toISOString(),
      messageCount: messages.length,
      firstMessage: firstUserMessage ? runtimeMessageText(firstUserMessage) || "(no messages)" : "(no messages)",
      ...(subagent ? {
        parentSessionId: subagent.parentSessionId,
        relation: {
          kind: "subagent" as const,
          parentSessionId: subagent.parentSessionId,
          profile: subagent.profile,
          description: subagent.description,
          status: session.isRunning() ? "running" as const : subagent.status,
        },
      } : {}),
      transient: !persisted,
    });
  }
  return sessions;
}

export function hasBusyRpcSessionForCwd(cwd: string): boolean {
  const targetCwd = normalizeRpcCwd(cwd);
  if (getStartingSessionCwds().has(targetCwd)) return true;
  return Array.from(getRegistry().values()).some(
    (session) => normalizeRpcCwd(session.cwd) === targetCwd && session.isRunning(),
  );
}

export async function destroyRpcSessionsForCwd(cwd: string): Promise<number> {
  const targetCwd = normalizeRpcCwd(cwd);
  const sessions = Array.from(getRegistry().values()).filter(
    (session) => normalizeRpcCwd(session.cwd) === targetCwd,
  );
  await Promise.all(sessions.map((session) => session.shutdown()));
  return sessions.length;
}

export function getRunningRpcSessionIds(): string[] {
  const ids = new Set<string>();
  for (const [sessionId, session] of getRegistry()) {
    if (session.isRunning()) ids.add(session.sessionId || sessionId);
  }
  return [...ids];
}

export function getCompletionNotificationSuppressedRpcSessionIds(): string[] {
  const ids = new Set<string>();
  for (const [sessionId, session] of getRegistry()) {
    if (session.isRunning() && session.hasSuppressedCompletionNotifications()) {
      ids.add(session.sessionId || sessionId);
    }
  }
  return [...ids];
}

/**
 * Get or create an AgentSession for the given session.
 * For new sessions (sessionFile === ""), pi generates its own id.
 * New sessions resolve enabledModels before construction so the initial model,
 * thinking pin, and SDK scopedModels share one settings snapshot.
 * Pass options.toolNames to pre-configure active tools (empty = all disabled).
 */
export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string | undefined,
  options: RpcSessionStartOptions = {},
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  const { initialModel, allowInitialModelFallback, thinkingLevel } = options;
  const requestedToolNames = options.toolNames === undefined
    ? undefined
    : validateSessionToolSelection(options.toolNames);
  const registry = getRegistry();
  const locks = getLocks();

  const existing = registry.get(sessionId);
  if (existing?.isAlive()) return { session: existing, realSessionId: sessionId };

  const inflight = locks.get(sessionId);
  if (inflight) return inflight;

  let sessionManager: SessionManager;
  if (sessionFile) {
    sessionManager = SessionManager.open(sessionFile, undefined);
  } else {
    if (!cwd) throw new Error("cwd is required for a new session");
    sessionManager = SessionManager.create(cwd, undefined);
  }
  const sessionCwd = sessionManager.getCwd();
  const subagentResources = sessionFile
    ? readSubagentSessionResources(
        sessionManager.getEntries() as unknown as SessionEntry[],
      )
    : null;
  const promptSelection = subagentResources ? undefined : sessionFile
    ? readSessionPromptSelection(sessionManager.getEntries() as unknown as SessionEntry[])
    : promptSelectionFromSettings(readPromptPresetSettings());
  if (!sessionFile && promptSelection) appendSessionPromptSelection(sessionManager, promptSelection);
  const persistedToolNames = subagentResources
    ? undefined
    : readSessionToolSelection(sessionManager.getEntries() as unknown as SessionEntry[]);
  const selectedToolNames = subagentResources?.tools ?? persistedToolNames ?? requestedToolNames;
  if (!subagentResources && persistedToolNames === undefined && requestedToolNames !== undefined) {
    appendSessionToolSelection(sessionManager, requestedToolNames);
  }
  const subagentLoadsResources = Boolean(
    subagentResources?.loadExtensions || subagentResources?.loadSkills,
  );
  const chatOnly = selectedToolNames?.length === 0 && !subagentLoadsResources;
  const finishStartingSession = trackStartingSession(sessionCwd);
  const starting = withRelayImageGenerationSession(sessionManager, async () => {
    // Some extensions access the SDK's global theme even outside the terminal UI.
    if (!chatOnly) initTheme();
    const agentDir = getAgentDir();

    // Determine which tools to pass based on requested toolNames.
    // Since v0.68.0, session creation expects string[] tool names instead of Tool[] instances.
    let toolsOption: string[] | undefined = subagentResources?.tools;
    if (!subagentResources && selectedToolNames !== undefined) {
      // toolNames === [] -> "all off" (an empty allow-list disables every tool).
      // Otherwise DO NOT pass a builtin-only allow-list: passing CODING_TOOL_NAMES
      // set allowedToolNames to coding builtins only, which filtered every
      // extension/package-provided tool (e.g. subagents, web access) out of the
      // tool registry — so they were unavailable in Pi Web sessions even though the
      // `pi` CLI keeps them. Leaving the allow-list unset lets the SDK register all
      // tools (and activate extension tools); we narrow the ACTIVE set below.
      toolsOption = selectedToolNames.length === 0 ? [] : undefined;
    }

    // Build services first so extension-registered providers are available
    // before the SDK restores the saved model from the session file.
    // Gate untrusted project extensions so opening a repository does not run
    // its .pi/extensions code automatically (see lib/project-trust.ts, #236).
    const trustReloadOptions = subagentResources
      ? subagentLoadsResources
        ? projectTrustReloadOptions(sessionCwd, agentDir)
        : undefined
      : chatOnly
        ? undefined
        : projectTrustReloadOptions(sessionCwd, agentDir);
    const baseSettingsManager = SettingsManager.create(sessionCwd, agentDir);
    // Session-mode packages must be excluded before the SDK evaluates any
    // extension module. A dynamic settings view lets a normal reload observe
    // the latest session snapshot without hot-unloading the live runner.
    const settingsManager = createSessionScopedSettingsManager(baseSettingsManager, sessionManager, {
      useStarterDefaults: !subagentResources,
    });
    const services = await createAgentSessionServices({
      cwd: sessionCwd,
      agentDir,
      settingsManager,
      resourceLoaderOptions: subagentResources
        ? {
            noExtensions: !subagentResources.loadExtensions,
            noSkills: !subagentResources.loadSkills,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            extensionFactories: [createRelaySummaryPolicyExtension()],
            ...(chatOnly
              ? {
                  systemPrompt: " ",
                  systemPromptOverride: () => undefined,
                }
              : {}),
            appendSystemPrompt: subagentResources.appendSystemPrompt,
          }
        : chatOnly
          ? { ...CHAT_ONLY_RESOURCE_LOADER_OPTIONS, extensionFactories: [createRelaySummaryPolicyExtension()] }
        : {
            systemPromptOverride: (basePrompt) => basePrompt
              ? rebrandMeteorAgentSystemPrompt(basePrompt)
              : basePrompt,
            extensionFactories: [
              createProjectCommandBashExtension({
                cwd: sessionCwd,
                settings: settingsManager,
              }),
              createSubagentExtension(
                SUBAGENT_CONTROLLER.extensionRuntime,
                () => listSubagentProfiles(sessionCwd),
              ),
              createMeteorAgentBrandExtension(),
              AgentSessionWrapper.goalExtension(() => registry.get(sessionManager.getSessionId())),
              createRelaySummaryPolicyExtension(),
            ],
            extensionsOverride: (base) => preferUserBashExtension(preferPiWebSubagentExtension(base)),
          },
      ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
    });
    installRelayResponseRepair(services.modelRuntime);
    const resolvedScope = await resolveVisibleModels(
      services.modelRuntime,
      services.settingsManager.getEnabledModels(),
    );
    const productProviderIds = process.env.NEXT_PUBLIC_AUTH_GATE === "1"
      ? new Set(readRelayGroups().map((group) => group.providerId))
      : null;
    const scope = filterModelScopeByRelayAuthorization(
      filterModelScopeByProviders(resolvedScope, productProviderIds),
      relayAuthorizedModelIdsByProvider(),
    );
    const effectiveInitialModel = initialModel && (
      !allowInitialModelFallback
      || scope.visible.some((model) => model.provider === initialModel.provider && model.id === initialModel.modelId)
    )
      ? initialModel
      : undefined;
    const defaultProvider = services.settingsManager.getDefaultProvider();
    const defaultModelId = services.settingsManager.getDefaultModel();
    const branch = sessionManager.getBranch();
    const hasExistingMessages = branch.some((entry) => entry.type === "message");
    const savedModel = hasExistingMessages
      ? getLatestModelChange(branch as unknown as SessionEntry[])
      : null;
    const restoredCandidate = savedModel
      ? services.modelRuntime.getModel(savedModel.provider, savedModel.modelId)
      : undefined;
    const restoredModel = restoredCandidate && scope.visible.some(
      (model) => model.provider === restoredCandidate.provider && model.id === restoredCandidate.id,
    )
      ? restoredCandidate
      : undefined;
    const initial = hasExistingMessages ? null : selectInitialModelScope(scope, {
        ...(effectiveInitialModel ? { requestedModel: effectiveInitialModel } : {}),
        ...(defaultProvider && defaultModelId
          ? { defaultModel: { provider: defaultProvider, modelId: defaultModelId } }
          : {}),
        ...(isModelThinkingLevel(thinkingLevel) ? { thinkingLevel } : {}),
      });
    const fallbackForRestoredSession = hasExistingMessages && !restoredModel
      ? selectInitialModelScope(scope, {
          ...(defaultProvider && defaultModelId
            ? { defaultModel: { provider: defaultProvider, modelId: defaultModelId } }
            : {}),
        }).model
      : undefined;
    const startupModel = restoredModel && services.modelRuntime.hasConfiguredAuth(restoredModel.provider)
      ? restoredModel
      : initial?.model ?? fallbackForRestoredSession;
    const requestedThinking = !hasExistingMessages ? thinkingLevel : undefined;
    const startupThinking = requestedThinking && startupModel
      ? resolveThinkingLevelOption(requestedThinking, getSupportedThinkingLevels(startupModel))
      : requestedThinking;
    const sdkThinking = startupThinking ?? initial?.thinkingLevel;
    const { session: inner } = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...(startupModel ? { model: startupModel } : {}),
      ...(sdkThinking !== undefined && sdkThinking !== "auto" ? { thinkingLevel: sdkThinking } : {}),
      ...(scope.scopedModels.length > 0 ? { scopedModels: [...scope.scopedModels] } : {}),
      ...(toolsOption !== undefined ? { tools: toolsOption } : {}),
      ...(!chatOnly && !subagentResources ? {
        customTools: [AgentSessionWrapper.userQuestionTool(() => registry.get(sessionManager.getSessionId()))],
      } : {}),
      ...(subagentResources ? { excludeTools: [...SUBAGENT_CONTROL_TOOL_NAMES] } : {}),
    });
    const effectiveThinking = startupThinking && inner.model
      ? resolveThinkingLevelOption(startupThinking, getSupportedThinkingLevels(inner.model))
      : startupThinking;
    if (effectiveThinking) sessionManager.appendCustomEntry(THINKING_SELECTION_TYPE, effectiveThinking);

    const persistedPreferences = await persistExplicitStartupPreferences(
      services.settingsManager,
      {
        ...(effectiveInitialModel ? { model: effectiveInitialModel } : {}),
        ...(isModelThinkingLevel(effectiveThinking) ? { thinkingLevel: effectiveThinking } : {}),
      },
      {
        ...(inner.model
          ? { model: { provider: inner.model.provider, modelId: inner.model.id } }
          : {}),
        thinkingLevel: inner.thinkingLevel,
        supportsThinking: inner.supportsThinking(),
      },
    );
    if (persistedPreferences.modelDefaultChanged) invalidateModelsCache();

    const exactSystemPrompt = subagentResources?.exactSystemPrompt !== undefined
      ? () => subagentResources.exactSystemPrompt!
      : chatOnly
        ? subagentResources
          ? () => subagentResources.appendSystemPrompt[0] ?? ""
          : () => contextFilesSystemPrompt(inner.resourceLoader.getAgentsFiles().agentsFiles)
        : undefined;
    const wrapper = new AgentSessionWrapper(inner, {
      exactSystemPrompt,
      promptSelection,
      chatOnly,
      onAgentRunComplete: (completedSessionId) => {
        void notifySessionComplete(completedSessionId).catch((error) => {
          console.error("[meteoragent] failed to send completion push:", error instanceof Error ? error.message : error);
        });
      },
      suppressCompletionNotifications: Boolean(subagentResources),
    });
    if (!subagentResources && !chatOnly) {
      wrapper.setActiveToolSelection(selectedToolNames ?? inner.getActiveToolNames(), selectedToolNames === undefined);
    }
    const realSessionId = inner.sessionId as string;
    registerRpcWrapper(wrapper);

    return { session: wrapper, realSessionId };
  }).finally(() => {
    locks.delete(sessionId);
    finishStartingSession();
  });

  locks.set(sessionId, starting);
  return starting;
}
