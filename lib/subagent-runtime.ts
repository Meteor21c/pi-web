import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  initTheme,
  SessionManager,
  SettingsManager,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike } from "./pi-types";
import { createRelaySummaryPolicyExtension } from "./relay-responses";
import { persistPreparedSession } from "./session-reader";
import {
  isActiveSubagentStatus,
  subagentFinalText,
  subagentToolDetails,
  type ResumeSubagentRequest,
  type StartSubagentRequest,
  type SubagentExecution,
  type SubagentExtensionRuntime,
} from "./subagent-extension";
import {
  readSubagentRun,
  defaultSubagentProfile,
  resolveSubagentProfile,
  SUBAGENT_CONTROL_TOOL_NAMES,
  SUBAGENT_META_TYPE,
  SUBAGENT_STATUS_TYPE,
  SUBAGENT_RESULT_TYPE,
  selectSubagentExtensionTools,
  withSubagentExtensionTools,
  type SubagentMetadata,
  type SubagentResultMetadata,
  type SubagentRunInfo,
  type SubagentStatusMetadata,
} from "./subagents";
import type { SessionEntry } from "./types";
import { buildSubagentPromptPlan } from "./subagent-prompt";
import { appendSubagentInputFiles, loadSubagentInputFiles } from "./subagent-input";
import { projectTrustReloadOptions } from "./project-trust";
import { getActiveProjectRoots, getNamedProject, isProjectDirectory, sessionProjectId, setSessionProject } from "./project-store";
import { createSessionScopedSettingsManager } from "./plugin-activation";
import { resolveShellTools } from "./powershell-settings";
import { isBuiltInSubagentsEnabled, readSubagentSettings } from "./subagent-settings";
import { MAX_SUBAGENT_MAX_CONCURRENT, type SubagentMode } from "./subagent-mode";
import { waitForSubagent, type SubagentTask } from "./subagent-task";
import { SubagentQueue } from "./subagent-queue";
import { registerSessionLivenessProvider } from "./session-liveness";
import { addWorktree, removeWorktree } from "./worktree";
import { randomUUID } from "node:crypto";

interface HostSession {
  readonly inner: AgentSessionLike;
  readonly sessionFile: string;
  readonly cwd: string;
  isAlive(): boolean;
  isRunning(): boolean;
  waitUntilReady(): Promise<void>;
}

export interface SubagentRuntimeDependencies {
  getSession(sessionId: string): HostSession | undefined;
  registerSession(
    inner: AgentSessionLike,
    options?: { exactSystemPrompt?: string; chatOnly?: boolean },
  ): void;
  reopenSession(sessionId: string, sessionFile: string): Promise<HostSession>;
  resolveSessionPath(sessionId: string): Promise<string | null>;
  invalidateSessionList(): void;
  isBuiltInSubagentsEnabled?(): boolean;
  subagentMode?(parentId: string): SubagentMode;
  subagentTask?(parentId: string): SubagentTask | undefined;
  publishStatus?(run: SubagentRunInfo): void;
}

export interface SubagentController {
  readonly extensionRuntime: SubagentExtensionRuntime;
  get(sessionId: string): Promise<SubagentRunInfo | null>;
  listActive(parentSessionId: string): SubagentRunInfo[];
  steer(sessionId: string, message: string): Promise<void>;
  abort(sessionId: string): Promise<void>;
}

type StoredSubagentExecution = {
  run: SubagentRunInfo;
  completion: Promise<SubagentRunInfo>;
  abortRequested: boolean;
  cancelQueued?: () => boolean;
};

declare global {
  var __piSubagentRuns: Map<string, StoredSubagentExecution> | undefined;
  var __piSubagentQueue: SubagentQueue<SubagentRunInfo> | undefined;
}
const SUBAGENT_CONTEXT_LIMIT = 50_000;
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function getSubagentRuns(): Map<string, StoredSubagentExecution> {
  if (!globalThis.__piSubagentRuns) globalThis.__piSubagentRuns = new Map();
  return globalThis.__piSubagentRuns;
}

function getSubagentQueue(): SubagentQueue<SubagentRunInfo> {
  if (!globalThis.__piSubagentQueue) {
    globalThis.__piSubagentQueue = new SubagentQueue(MAX_SUBAGENT_MAX_CONCURRENT, () => {
      try { return readSubagentSettings().maxConcurrent; }
      catch { return undefined; }
    });
  }
  return globalThis.__piSubagentQueue;
}

function persistNewChild(sessionManager: SessionManager): void {
  if (!persistPreparedSession(sessionManager)) throw new Error("Subagent session cannot be saved");
}

function subagentPromptWasAborted(sessionManager: SessionManager, fromEntryIndex: number): boolean {
  const entry = sessionManager.getEntries().slice(fromEntryIndex)
    .findLast((item) => item.type === "message" && item.message.role === "assistant");
  if (entry?.type !== "message" || entry.message.role !== "assistant") return false;
  if (entry.message.stopReason === "error") {
    throw new Error(entry.message.errorMessage || "The subagent model failed to respond.");
  }
  return entry.message.stopReason === "aborted";
}

function parseSubagentModel(runtime: ModelRuntime, value: string | undefined) {
  if (!value?.trim()) return undefined;
  const requested = value.trim();
  const slash = requested.indexOf("/");
  if (slash > 0) {
    const provider = requested.slice(0, slash);
    const modelId = requested.slice(slash + 1);
    const model = runtime.getModel(provider, modelId);
    if (!model) throw new Error(`Subagent model not found: ${requested}`);
    return model;
  }
  const matches = runtime.getModels().filter((model) => model.id === requested);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`Subagent model not found: ${requested}`);
  throw new Error(`Subagent model is ambiguous; use provider/modelId: ${requested}`);
}

function parentContextText(parent: HostSession): string {
  const messages = parent.inner.sessionManager.buildSessionContext().messages;
  const serialized = JSON.stringify(messages);
  if (serialized.length <= SUBAGENT_CONTEXT_LIMIT) return serialized;
  return `${serialized.slice(0, SUBAGENT_CONTEXT_LIMIT)}\n[Parent context truncated]`;
}

async function cleanupWorktree(
  parentCwd: string,
  worktree: { path: string; branch: string } | undefined,
): Promise<string | undefined> {
  if (!worktree) return undefined;
  try {
    await removeWorktree(parentCwd, worktree.path);
    return undefined;
  } catch (error) {
    return `Worktree retained at ${worktree.path}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function childSetupSignal(task: SubagentTask | undefined, signal?: AbortSignal): AbortSignal | undefined {
  if (!task) return signal;
  return signal ? AbortSignal.any([task.signal, signal]) : task.signal;
}

function bindChildCancellation(stored: StoredSubagentExecution, inner: AgentSessionLike, signal?: AbortSignal): () => void {
  const stop = () => {
    stored.abortRequested = true;
    if (stored.run.status === "queued") stored.cancelQueued?.();
    else if (stored.run.status === "running") {
      void inner.abort().catch((error) => console.error("[meteoragent] failed to stop subagent:", error));
    }
  };
  if (signal?.aborted) stop();
  else signal?.addEventListener("abort", stop, { once: true });
  return () => signal?.removeEventListener("abort", stop);
}

export function createSubagentController(
  dependencies: SubagentRuntimeDependencies,
): SubagentController {
  function assertAllowed(parentId: string): void {
    const mode = dependencies.subagentMode?.(parentId)
      ?? ((dependencies.isBuiltInSubagentsEnabled ?? isBuiltInSubagentsEnabled)() ? "auto" : "off");
    if (mode === "off") throw new Error("MeteorAgent built-in sub-agents are disabled for this task");
  }

  function trackExecution(stored: StoredSubagentExecution): void {
    const { sessionId } = stored.run;
    getSubagentRuns().set(sessionId, stored);
    const release = registerSessionLivenessProvider({
      name: "meteoragent-subagent-job",
      sessionId,
      isActive: () => getSubagentRuns().get(sessionId) === stored,
    });
    void stored.completion.then(release, release);
  }

  async function start(request: StartSubagentRequest): Promise<SubagentExecution> {
    const parentSessionId = request.parentContext.sessionManager.getSessionId();
    assertAllowed(parentSessionId);
    const parentTask = dependencies.subagentTask?.(parentSessionId);
    const setupSignal = childSetupSignal(parentTask, request.signal);
    const maxConcurrent = readSubagentSettings().maxConcurrent;
    const parent = dependencies.getSession(parentSessionId);
    if (!parent?.isAlive()) throw new Error("Parent session is no longer available");
    if (!parent.sessionFile) throw new Error("Parent session must be persisted before starting a subagent");

    const projectId = sessionProjectId(parentSessionId);
    let projectRoots: Set<string> | undefined;
    if (projectId !== undefined) {
      const project = projectId === null ? undefined : getNamedProject(projectId);
      if (!project || !isProjectDirectory(parent.cwd, project)) {
        throw new Error("子智能体需要项目中可用的工作文件夹。");
      }
      projectRoots = getActiveProjectRoots(project);
    }

    let isolatedWorktree: { path: string; branch: string } | undefined;
    try {
      setupSignal?.throwIfAborted();
      const profile = request.profile ? resolveSubagentProfile(parent.cwd, request.profile) : defaultSubagentProfile();
      if (!profile) throw new Error(`Unknown or disabled subagent profile: ${request.profile}`);

      const parentTools = new Set(parent.inner.getActiveToolNames());
      const parentAllowsTool = (tool: string) => parentTools.has(tool)
        || (tool === "bash" && parentTools.has("powershell"));
      const profileTools = profile.tools.filter(parentAllowsTool);
      const parentReadOnly = !["bash", "powershell", "edit", "write"].some((tool) => parentTools.has(tool));
      const loadExtensions = profile.loadExtensions && !parentReadOnly;
      const loadSkills = profile.loadSkills && !parentReadOnly;
      const runInBackground = request.runInBackground ?? profile.runInBackground;
      const runSignal = runInBackground ? parentTask?.signal : setupSignal;
      const isolation = profile.isolation === "off" ? undefined : request.isolation ?? profile.isolation;
      if (isolation === "worktree") {
        if (projectRoots) throw new Error("命名项目暂不支持为子智能体创建独立工作树，可直接使用项目文件夹。");
        if (parentReadOnly) throw new Error("Read-only tasks cannot create a subagent worktree");
        isolatedWorktree = await addWorktree(parent.cwd, `pi-web-agent-${randomUUID()}`);
      }
      const childCwd = isolatedWorktree?.path ?? parent.cwd;
      const inheritContext = request.inheritContext ?? profile.inheritContext;
      const maxTurns = request.maxTurns ?? profile.maxTurns;
      if (maxTurns !== undefined && (!Number.isFinite(maxTurns) || maxTurns < 0)) {
        throw new Error("max_turns must be a non-negative number");
      }
      const turnLimit = maxTurns && maxTurns > 0 ? Math.floor(maxTurns) : undefined;
      const thinking = request.thinking ?? profile.thinking ?? parent.inner.agent.state?.thinkingLevel;
      if (thinking && !THINKING_LEVELS.has(thinking as ThinkingLevel)) {
        throw new Error(`Invalid subagent thinking level: ${thinking}`);
      }

      const agentDir = getAgentDir();
      const parentModelRuntime = (parent.inner as unknown as { modelRuntime: ModelRuntime }).modelRuntime;
      const settingsManager = createSessionScopedSettingsManager(
        SettingsManager.create(childCwd, agentDir),
        parent.inner.sessionManager,
        { useStarterDefaults: false, onlyStarterDefaults: true },
      );
      const inheritedParentContext = inheritContext
        ? `The following is the active conversation context from the parent session. Use it only as background for the delegated task:\n${parentContextText(parent)}`
        : undefined;
      const inputFiles = loadSubagentInputFiles(parent.cwd, request.inputFiles ?? [], projectRoots);
      const promptPlan = buildSubagentPromptPlan({
        profileSystemPrompt: profile.systemPrompt,
        tools: profileTools,
        loadSkills,
        loadExtensions,
        promptMode: profile.promptMode,
        task: appendSubagentInputFiles(request.task, inputFiles),
        inheritedParentContext,
      });
      const { chatOnly, appendSystemPrompt, delegatedTask } = promptPlan;
      if (!chatOnly) initTheme();
      const services = await createAgentSessionServices({
        cwd: childCwd,
        agentDir,
        modelRuntime: parentModelRuntime,
        settingsManager,
        resourceLoaderOptions: {
          noExtensions: !loadExtensions,
          noSkills: !loadSkills,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          extensionFactories: [createRelaySummaryPolicyExtension()],
          ...(chatOnly || promptPlan.exactSystemPrompt !== undefined
            ? {
                systemPrompt: " ",
                systemPromptOverride: () => undefined,
              }
            : {}),
          appendSystemPrompt,
        },
        ...((loadExtensions || loadSkills)
          ? { resourceLoaderReloadOptions: projectTrustReloadOptions(childCwd, agentDir) }
          : {}),
      });

      const extensionToolNames = loadExtensions
        ? profile.extensionTools?.length
          ? selectSubagentExtensionTools(services.resourceLoader.getExtensions().extensions, profile.extensionTools)
          : services.resourceLoader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()])
        : [];
      const activeTools = resolveShellTools(
        withSubagentExtensionTools(profileTools, extensionToolNames.filter(parentAllowsTool)),
        settingsManager.getDefaultTools(),
      );

      const sessionManager = isolatedWorktree
        ? SessionManager.create(childCwd, undefined, { parentSession: parent.sessionFile })
        : SessionManager.create(parent.cwd, undefined, { parentSession: parent.sessionFile });
      const createdAt = new Date().toISOString();
      const metadata: SubagentMetadata = {
        version: 1,
        parentSessionId,
        parentSessionPath: parent.sessionFile,
        parentToolCallId: request.parentToolCallId,
        profile: profile.name,
        description: request.description.trim() || profile.displayName,
        task: request.task,
        runInBackground,
        createdAt,
        resourceSnapshot: {
          version: 1,
          appendSystemPrompt: [...appendSystemPrompt],
          tools: [...activeTools],
          loadSkills,
          loadExtensions,
        ...(promptPlan.exactSystemPrompt !== undefined ? { exactSystemPrompt: promptPlan.exactSystemPrompt } : {}),
        },
        ...(isolatedWorktree ? { worktreePath: isolatedWorktree.path, worktreeBranch: isolatedWorktree.branch } : {}),
      };
      setupSignal?.throwIfAborted();
      assertAllowed(parentSessionId);
      sessionManager.appendCustomEntry(SUBAGENT_META_TYPE, metadata);
      sessionManager.appendSessionInfo(metadata.description);

      const requestedModel = parseSubagentModel(parentModelRuntime, request.model ?? profile.model);
      const parentModel = parent.inner.model as ReturnType<ModelRuntime["getModel"]>;
      const { session: inner } = await createAgentSessionFromServices({
        services,
        sessionManager,
        model: requestedModel ?? parentModel,
        ...(thinking ? { thinkingLevel: thinking as ThinkingLevel } : {}),
        tools: activeTools,
        excludeTools: [...SUBAGENT_CONTROL_TOOL_NAMES],
      });
      try {
        setupSignal?.throwIfAborted();
        assertAllowed(parentSessionId);
        persistNewChild(sessionManager);
        if (projectId !== undefined) await setSessionProject(inner.sessionId, projectId);
      } catch (error) {
        inner.dispose();
        throw error;
      }
      dependencies.registerSession(inner, {
        ...(promptPlan.exactSystemPrompt !== undefined
          ? { exactSystemPrompt: promptPlan.exactSystemPrompt }
          : {}),
        chatOnly,
      });

      const initialRun: SubagentRunInfo = {
        sessionId: inner.sessionId,
        sessionPath: inner.sessionFile ?? sessionManager.getSessionFile() ?? "",
        parentSessionId,
        parentToolCallId: request.parentToolCallId,
        profile: profile.name,
        description: metadata.description,
        task: request.task,
        runInBackground,
        status: "queued",
        createdAt,
        ...(isolatedWorktree ? { worktreePath: isolatedWorktree.path, worktreeBranch: isolatedWorktree.branch } : {}),
      };

      let turnCount = 0;
      let maxTurnsReached = false;
      let softLimitReached = false;
      const unsubscribeTurns = turnLimit
        ? inner.subscribe((event) => {
            if (event.type !== "turn_end") return;
            turnCount += 1;
            if (!softLimitReached && turnCount >= turnLimit) {
              softLimitReached = true;
              void inner.steer("You have reached your turn limit. Wrap up immediately and provide your final answer now.");
            } else if (softLimitReached && turnCount >= turnLimit + 1) {
              maxTurnsReached = true;
              void inner.abort();
            }
          })
        : () => {};
      let resolveCompletion!: (run: SubagentRunInfo) => void;
      const completion = new Promise<SubagentRunInfo>((resolve) => { resolveCompletion = resolve; });
      const stored: StoredSubagentExecution = {
        run: initialRun,
        completion,
        abortRequested: false,
      };
      trackExecution(stored);
      parentTask?.track(initialRun, completion);
      const publish = (run: SubagentRunInfo) => {
        stored.run = run;
        dependencies.publishStatus?.(run);
        if (!runInBackground && !runSignal?.aborted) request.onUpdate?.(run);
        dependencies.invalidateSessionList();
      };
      const unbindCancellation = bindChildCancellation(stored, inner, runSignal);

      const execute = async (): Promise<SubagentRunInfo> => {
        if (stored.abortRequested) {
          unsubscribeTurns();
          unbindCancellation();
          const result: SubagentRunInfo = { ...initialRun, status: "aborted", completedAt: new Date().toISOString() };
          sessionManager.appendCustomEntry(SUBAGENT_RESULT_TYPE, { version: 1, status: "aborted", completedAt: result.completedAt });
          await cleanupWorktree(parent.cwd, isolatedWorktree);
          publish(result);
          getSubagentRuns().delete(initialRun.sessionId);
          return result;
        }
        sessionManager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "running" });
        let result: SubagentRunInfo;
        try {
          await dependencies.getSession(inner.sessionId)?.waitUntilReady();
          if (stored.abortRequested) throw new Error("Subagent was stopped");
          const firstNewEntry = sessionManager.getEntries().length;
          await inner.prompt(delegatedTask, { source: "rpc" });
          const text = inner.getLastAssistantText()?.trim();
          const modelAborted = subagentPromptWasAborted(sessionManager, firstNewEntry);
          const aborted = stored.abortRequested || (modelAborted && !maxTurnsReached);
          result = {
            ...initialRun,
            status: aborted ? "aborted" : "completed",
            completedAt: new Date().toISOString(),
            ...(text ? { result: text } : {}),
          };
        } catch (error) {
          const text = inner.getLastAssistantText()?.trim();
          const aborted = stored.abortRequested;
          result = {
            ...initialRun,
            status: aborted ? "aborted" : maxTurnsReached ? "completed" : "failed",
            completedAt: new Date().toISOString(),
            ...(text ? { result: text } : {}),
            ...(!aborted && !maxTurnsReached
              ? { error: error instanceof Error ? error.message : String(error) }
              : {}),
          };
        } finally {
          unsubscribeTurns();
          unbindCancellation();
        }

        const cleanupError = await cleanupWorktree(parent.cwd, isolatedWorktree);
        if (cleanupError) result = { ...result, worktreeCleanupError: cleanupError };
        const persisted: SubagentResultMetadata = {
          version: 1,
          status: result.status as SubagentResultMetadata["status"],
          completedAt: result.completedAt!,
          ...(result.result ? { result: result.result } : {}),
          ...(result.error ? { error: result.error } : {}),
          ...(result.worktreeCleanupError ? { worktreeCleanupError: result.worktreeCleanupError } : {}),
        };
        sessionManager.appendCustomEntry(SUBAGENT_RESULT_TYPE, persisted);
        publish(result);
        getSubagentRuns().delete(initialRun.sessionId);
        return result;
      };

      const finishQueuedAbort = async () => {
        if (stored.run.status !== "queued") return;
        unsubscribeTurns();
        unbindCancellation();
        const result: SubagentRunInfo = { ...initialRun, status: "aborted", completedAt: new Date().toISOString() };
        const cleanupError = await cleanupWorktree(parent.cwd, isolatedWorktree);
        const finalResult = cleanupError ? { ...result, worktreeCleanupError: cleanupError } : result;
        sessionManager.appendCustomEntry(SUBAGENT_RESULT_TYPE, { version: 1, status: "aborted", completedAt: finalResult.completedAt, ...(cleanupError ? { worktreeCleanupError: cleanupError } : {}) });
        publish(finalResult);
        getSubagentRuns().delete(initialRun.sessionId);
        resolveCompletion(finalResult);
      };
      const queued = getSubagentQueue().enqueue(
        parentSessionId,
        maxConcurrent,
        execute,
        (state) => {
          if (state === "queued") {
            sessionManager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "queued" });
          }
          publish({ ...stored.run, status: state });
        },
        finishQueuedAbort,
      );
      stored.cancelQueued = queued.cancel;
      if (stored.abortRequested) queued.cancel();
      void queued.promise.then(resolveCompletion, (error) => {
        unsubscribeTurns();
        unbindCancellation();
        const result: SubagentRunInfo = { ...initialRun, status: "failed", completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) };
        publish(result);
        getSubagentRuns().delete(initialRun.sessionId);
        resolveCompletion(result);
      });

      return { run: stored.run, completion, ownedByTask: Boolean(parentTask) };
    } catch (error) {
      if (isolatedWorktree) {
        try { await removeWorktree(parent.cwd, isolatedWorktree.path); } catch { /* preserve setup failure and avoid force deletion */ }
      }
      throw error;
    }
  }

  async function resume(request: ResumeSubagentRequest): Promise<SubagentExecution> {
    const parentSessionId = request.parentContext.sessionManager.getSessionId();
    assertAllowed(parentSessionId);
    const parentTask = dependencies.subagentTask?.(parentSessionId);
    const setupSignal = childSetupSignal(parentTask, request.signal);
    setupSignal?.throwIfAborted();
    const maxConcurrent = readSubagentSettings().maxConcurrent;
    const existing = await get(request.sessionId);
    if (!existing) throw new Error(`Subagent not found: ${request.sessionId}`);
    if (existing.parentSessionId !== parentSessionId) throw new Error("Subagent does not belong to this parent session");
    if (isActiveSubagentStatus(existing.status)) throw new Error("Subagent is already running");
    const parent = dependencies.getSession(parentSessionId);
    if (!parent?.isAlive()) throw new Error("Parent session is no longer available");
    const sessionPath = existing.sessionPath || await dependencies.resolveSessionPath(request.sessionId);
    if (!sessionPath) throw new Error(`Subagent session file not found: ${request.sessionId}`);
    let wrapper = dependencies.getSession(request.sessionId);
    if (!wrapper?.isAlive()) wrapper = await dependencies.reopenSession(request.sessionId, sessionPath);
    if (!wrapper.isAlive()) throw new Error("Subagent session is no longer available");
    if (wrapper.isRunning()) throw new Error("Subagent is already running");

    const runInBackground = request.runInBackground ?? existing.runInBackground;
    const runSignal = runInBackground ? parentTask?.signal : setupSignal;
    const invocation = {
      parentToolCallId: request.parentToolCallId,
      task: request.task,
      description: request.description.trim() || existing.description,
      runInBackground,
    };
    const initialRun: SubagentRunInfo = {
      ...existing,
      ...invocation,
      status: "queued",
      completedAt: undefined,
      result: undefined,
      error: undefined,
    };
    const manager = wrapper.inner.sessionManager;
    const parentTools = parent.inner.getActiveToolNames?.();
    const childTools = wrapper.inner.getActiveToolNames?.();
    if (parentTools && childTools?.some((tool) => !parentTools.includes(tool))) {
      throw new Error("The current task's tools do not allow resuming this subagent");
    }
    setupSignal?.throwIfAborted();
    assertAllowed(parentSessionId);
    if (getSubagentRuns().has(request.sessionId)) throw new Error("Subagent is already running");
    let resolveCompletion!: (run: SubagentRunInfo) => void;
    const completion = new Promise<SubagentRunInfo>((resolve) => { resolveCompletion = resolve; });
    const stored: StoredSubagentExecution = { run: initialRun, completion, abortRequested: false };
    trackExecution(stored);
    parentTask?.track(initialRun, completion);
    const publish = (run: SubagentRunInfo) => {
      stored.run = run;
      dependencies.publishStatus?.(run);
      if (!runInBackground && !runSignal?.aborted) request.onUpdate?.(run);
      dependencies.invalidateSessionList();
    };
    const unbindCancellation = bindChildCancellation(stored, wrapper.inner, runSignal);

    const execute = async (): Promise<SubagentRunInfo> => {
      if (stored.abortRequested) {
        unbindCancellation();
        const result: SubagentRunInfo = { ...initialRun, status: "aborted", completedAt: new Date().toISOString() };
        manager.appendCustomEntry(SUBAGENT_RESULT_TYPE, { version: 1, status: "aborted", ...invocation, completedAt: result.completedAt });
        publish(result);
        getSubagentRuns().delete(request.sessionId);
        resolveCompletion(result);
        return result;
      }
      manager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "running", ...invocation } satisfies SubagentStatusMetadata);
      let result: SubagentRunInfo;
      try {
        await wrapper!.waitUntilReady();
        if (stored.abortRequested) throw new Error("Subagent was stopped");
        const firstNewEntry = manager.getEntries().length;
        await wrapper!.inner.prompt(request.task, { source: "rpc" });
        const text = wrapper!.inner.getLastAssistantText()?.trim();
        const modelAborted = subagentPromptWasAborted(manager, firstNewEntry);
        result = { ...initialRun, status: stored.abortRequested || modelAborted ? "aborted" : "completed", completedAt: new Date().toISOString(), ...(text ? { result: text } : {}) };
      } catch (error) {
        result = {
          ...initialRun,
          status: stored.abortRequested ? "aborted" : "failed",
          completedAt: new Date().toISOString(),
          ...(!stored.abortRequested ? { error: error instanceof Error ? error.message : String(error) } : {}),
        };
      } finally {
        unbindCancellation();
      }
      manager.appendCustomEntry(SUBAGENT_RESULT_TYPE, {
        version: 1,
        ...invocation,
        status: result.status as "completed" | "failed" | "aborted",
        completedAt: result.completedAt!,
        ...(result.result ? { result: result.result } : {}),
        ...(result.error ? { error: result.error } : {}),
      });
      publish(result);
      getSubagentRuns().delete(request.sessionId);
      return result;
    };
    const finishQueuedAbort = () => {
      if (stored.run.status !== "queued") return;
      unbindCancellation();
      const result: SubagentRunInfo = { ...initialRun, status: "aborted", completedAt: new Date().toISOString() };
      manager.appendCustomEntry(SUBAGENT_RESULT_TYPE, { version: 1, status: "aborted", ...invocation, completedAt: result.completedAt });
      publish(result);
      getSubagentRuns().delete(request.sessionId);
      resolveCompletion(result);
    };
    const queued = getSubagentQueue().enqueue(parentSessionId, maxConcurrent, execute, (state) => {
      if (state === "queued") {
        manager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "queued", ...invocation } satisfies SubagentStatusMetadata);
      }
      publish({ ...stored.run, status: state });
    }, finishQueuedAbort);
    stored.cancelQueued = queued.cancel;
    if (stored.abortRequested) queued.cancel();
    void queued.promise.then(resolveCompletion, (error) => {
      unbindCancellation();
      const result: SubagentRunInfo = { ...initialRun, status: "failed", completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) };
      publish(result);
      getSubagentRuns().delete(request.sessionId);
      resolveCompletion(result);
    });
    return { run: stored.run, completion, ownedByTask: Boolean(parentTask) };
  }

  async function get(sessionId: string): Promise<SubagentRunInfo | null> {
    const stored = getSubagentRuns().get(sessionId);
    if (stored) return stored.run;
    const wrapper = dependencies.getSession(sessionId);
    if (wrapper?.isAlive()) {
      const run = readSubagentRun(
        wrapper.inner.sessionManager.getEntries() as unknown as SessionEntry[],
        sessionId,
        wrapper.sessionFile,
      );
      if (run && wrapper.isRunning()) return { ...run, status: "running" };
      if (run) return run;
    }
    const sessionPath = await dependencies.resolveSessionPath(sessionId);
    if (!sessionPath) return null;
    const manager = SessionManager.open(sessionPath);
    return readSubagentRun(manager.getEntries() as unknown as SessionEntry[], sessionId, sessionPath);
  }

  async function getForParent(sessionId: string, parentSessionId?: string, wait?: { signal?: AbortSignal }): Promise<SubagentRunInfo | null> {
    const stored = getSubagentRuns().get(sessionId);
    const run = stored?.run ?? await get(sessionId);
    if (parentSessionId !== undefined && run?.parentSessionId !== parentSessionId) return null;
    if (wait && stored) return waitForSubagent(stored.completion, wait.signal);
    return run;
  }

  async function steer(sessionId: string, message: string, parentSessionId?: string): Promise<void> {
    if (parentSessionId !== undefined && !await getForParent(sessionId, parentSessionId)) {
      throw new Error(`Subagent not found: ${sessionId}`);
    }
    const wrapper = dependencies.getSession(sessionId);
    if (!wrapper?.isAlive() || !wrapper.isRunning()) throw new Error("Subagent is not running");
    if (!message.trim()) throw new Error("Steering message is required");
    await wrapper.inner.steer(message.trim());
  }

  async function notifyParent(run: SubagentRunInfo): Promise<void> {
    let parent = dependencies.getSession(run.parentSessionId);
    if (!parent?.isAlive()) {
      const sessionFile = await dependencies.resolveSessionPath(run.parentSessionId);
      if (!sessionFile) throw new Error(`Parent session not found: ${run.parentSessionId}`);
      parent = await dependencies.reopenSession(run.parentSessionId, sessionFile);
    }
    await parent.waitUntilReady();
    if (!parent.isAlive()) throw new Error(`Parent session is no longer available: ${run.parentSessionId}`);
    await parent.inner.sendCustomMessage({
      customType: "pi-web:subagent-notification",
      content: subagentFinalText(run),
      display: true,
      details: subagentToolDetails(run),
    }, { deliverAs: "followUp", triggerTurn: true });
  }

  async function abort(sessionId: string): Promise<void> {
    const wrapper = dependencies.getSession(sessionId);
    const stored = getSubagentRuns().get(sessionId);
    if (stored?.run.status === "queued") {
      stored.abortRequested = true;
      if (!stored.cancelQueued?.()) throw new Error("Subagent is no longer queued");
      return;
    }
    if (!wrapper?.isAlive() || !wrapper.isRunning()) throw new Error("Subagent is not running");
    if (stored) stored.abortRequested = true;
    await wrapper.inner.abort();
  }

  return {
    extensionRuntime: { start, resume, get: getForParent, steer, notifyParent },
    get,
    listActive: (parentSessionId) => Array.from(getSubagentRuns().values())
      .map(({ run }) => run)
      .filter((run) => run.parentSessionId === parentSessionId),
    steer,
    abort,
  };
}
