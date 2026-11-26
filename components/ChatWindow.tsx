"use client";
import { registerAbortHandler } from "@/hooks/useKeyboardShortcuts";
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AgentMessage, AgentUsage, AssistantContentBlock, AssistantMessage, BashExecutionMessage, BlockingExtensionUiRequest, CustomMessage, ExtensionUiAnswer, ExtensionUiRequest, SessionInfo, SessionTreeNode, SubagentSessionStatus, ToolResultMessage, UserMessage } from "@/lib/types";
import { normalizeCustomPanelLines } from "@/lib/ansi";
import { asBracketedPaste, toTerminalKeyData } from "@/lib/terminal-input";
import { getAssistantErrorMessage, getAssistantTimelineSegments, getUserMessageText, hasFinalAssistantStop, isMessageGroupAnchor, readGoalOutcomeStatus, shouldShowSettledGoalFinal, startsUserTurn, stoppedWithoutFinalAnswer } from "@/lib/message-display";
import { extractTurnWrittenFiles, type WrittenFile } from "@/lib/turn-written-files";
import { buildQuotedSelection } from "@/lib/quoted-selection";
import { getDeliveredToolImages, getModelDisplayName, isSubagentToolDetails, MessageView, type ImageBillingSummary } from "./MessageView";
import type { WorkMode } from "@/lib/prompt-presets";
import { USER_QUESTION_TOOL } from "@/lib/user-questions";
import { readPreferredApprovalPolicy, savePreferredApprovalPolicy, type ComputerUseApprovalPolicy } from "@/lib/computer-use-approval-policy";
import { GOAL_CONTINUATION_TYPE, GOAL_OUTCOME_TYPE } from "@/lib/session-goal-types";
import { isSessionForkDivider } from "@/lib/session-fork-origin";
import { AUTOMATIC_SUBAGENT_RETRY_TYPE, DEFAULT_SUBAGENT_MODE, SUBAGENT_RESULTS_TYPE, type SubagentMode } from "@/lib/subagent-mode";
import { readTurnDurationMs, TURN_TIMING_TYPE } from "@/lib/session-timing";
import { SUBAGENT_NOTIFICATION_TYPE } from "@/lib/subagent-display";
import { NewSessionWelcome } from "./NewSessionWelcome";
import { divideByUiScale } from "@/lib/ui-scale";
import { MarkdownBody } from "./MarkdownBody";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { ApprovalPolicySelector } from "./ApprovalPolicySelector";
import approvalStyles from "./ApprovalPolicySelector.module.css";
import { SessionGoalTracker } from "./SessionGoalTracker";
import { UserQuestionDialog } from "./UserQuestionDialog";
import { CHAT_MINIMAP_WIDTH, ChatMinimap, useMessageRefs } from "./ChatMinimap";
import { ExtensionStatusBar } from "./ExtensionStatusBar";
import { AnsiText } from "./AnsiText";
import { useI18n } from "@/hooks/useI18n";
import { useAgentSession, type AgentPhase, type NoticeItem } from "@/hooks/useAgentSession";
import { useDragDrop } from "@/hooks/useDragDrop";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useRelayActualCosts } from "@/hooks/useRelayActualCosts";
import { isRelayProviderId } from "@/lib/relay-config";
import { summarizeTurnRelayBilling, type TurnRelayBilling } from "@/lib/turn-relay-billing";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { ToolEntry } from "@/lib/tool-presets";
import type { ToolPresetControl } from "./ToolDefinitionsPanel";
import { findChatScrollAnchor, type ChatScrollPosition } from "@/lib/chat-scroll-position";
import { sendAgentCommand } from "@/lib/agent-client";
import { getPromptAnchorSpacerHeight, isScrollAtTail } from "@/lib/chat-lazy-load";

interface Props {
  session: SessionInfo | null;
  searchTarget?: { sessionId: string; entryId: string; blockIndex?: number } | null;
  onSearchTargetHandled?: (target: { sessionId: string; entryId: string }) => void;
  initialScrollPosition?: ChatScrollPosition | null;
  onScrollPositionChange?: (sessionId: string, position: ChatScrollPosition) => void;
  sessionRunning?: boolean;
  newSessionCwd: string | null;
  projectId?: string | null;
  savedCwdOutsideProject?: boolean;
  uploadCwd?: string | null;
  newSessionDraftKey: string | null;
  onAgentEnd?: () => void;
  onAttentionNeeded?: (request: BlockingExtensionUiRequest) => void;
  onSessionCreated?: (session: SessionInfo, sourceDraftKey: string) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSystemToolsChange?: (tools: ToolEntry[] | null) => void;
  onToolPresetControlChange?: (control: ToolPresetControl | null) => void;
  onSessionReloadControlChange?: (control: SessionReloadControl | null) => void;
  onSystemInfoLoaderChange?: (loader: (() => Promise<void>) | null) => void;
  onSessionStatsChange?: (stats: SessionStatsInfo | null) => void;
  onSessionStatsPanelOpen?: () => void;
  onContextUsageChange?: (usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => void;
  onOpenFile?: (filePath: string) => void;
  onOpenSession?: (sessionId: string) => void;
  subagentStatuses?: ReadonlyMap<string, SubagentSessionStatus>;
  previewOnly?: boolean;
  onAskInNewChat?: (prompt: string, sourceSessionId: string, sourceEntryId: string) => Promise<void>;
  quoteSelectionEnabled?: boolean;
  initialPrompt?: string;
  onInitialPromptConsumed?: () => void;
  /** Completion sound state + controls, owned by AppShell so tasks finishing in
   *  a non-active workspace can still ring. */
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  playDoneSound?: () => void;
  unlockAudio?: () => void;
}

export interface SessionReloadControl {
  sessionId: string;
  busy: boolean;
  disabled: boolean;
  reload: () => Promise<void>;
}

function phaseLabel(phase: AgentPhase, t: (key: string, params?: Record<string, string | number>) => string): string | null {
  if (phase?.kind === "running_tools") {
    const latest = phase.tools[phase.tools.length - 1];
    if (latest && phase.tools.length === 1) {
      const name = latest.name.toLowerCase();
      const key = /^(read|grep|find|ls)$/.test(name) ? "chat.activityReading"
        : /^(edit|write)$/.test(name) ? "chat.activityEditing"
        : /^(bash|powershell)$/.test(name) ? "chat.runningCommand"
        : /^(web_search|get_search_content)$/.test(name) ? "chat.activitySearching"
        : name === "get_subagent_result" ? "chat.waitingSubagents"
        : name === USER_QUESTION_TOOL ? "chat.userQuestion.waiting"
        : name === "image_generate" ? "chat.activityGeneratingImage"
        : name.startsWith("computer_use_") ? "chat.activityUsingComputer"
        : name.startsWith("document_") ? "chat.activityProcessingDocument"
        : null;
      if (key) return latest.progress ? `${t(key)} · ${latest.progress}` : t(key);
    }
    if (latest?.progress) {
      return `${t("chat.runningNamedTool", { name: latest.name })} ${latest.progress}`;
    }
    const names = phase.tools.map((t) => t.name);
    if (names.length === 0) return t("chat.runningTool");
    if (names.length === 1) return t("chat.runningNamedTool", { name: names[0] });
    if (names.length <= 3) return t("chat.runningTools", { names: names.join(", ") });
    return t("chat.runningToolsMore", { names: names.slice(0, 2).join(", "), count: names.length - 2 });
  }
  if (phase?.kind === "waiting_model") return t("chat.waitingModel");
  if (phase?.kind === "waiting_subagents") return t("chat.waitingSubagents");
  if (phase?.kind === "running_command") return t("chat.runningCommand");
  return null;
}

const RUN_QUIET_THRESHOLD_MS = 45_000;

function formatRunDuration(ms: number, t: (key: string, params?: Record<string, string | number>) => string): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) return t("chat.runDurationHours", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
  if (minutes > 0) return t("chat.runDurationMinutes", { minutes, seconds });
  return t("chat.runDurationSeconds", { seconds });
}

function AgentActivityCard({ phase, streamingStage, startedAt, lastActivityAt, waitingForInput, compacting, t }: {
  phase: AgentPhase;
  streamingStage?: AssistantContentBlock["type"];
  startedAt: number | null;
  lastActivityAt: number | null;
  waitingForInput: boolean;
  compacting: boolean;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  let step = phaseLabel(phase, t) ?? t("chat.activityTitle");
  if (waitingForInput) step = t("chat.activityWaitingForInput");
  else if (compacting) step = t("chat.compacting");
  else if (phase?.kind !== "running_tools" && phase?.kind !== "running_command" && phase?.kind !== "waiting_subagents") {
    if (streamingStage === "thinking") step = t("chat.activityModelThinking");
    else if (streamingStage === "toolCall") step = t("chat.generatingToolInput");
    else if (streamingStage === "text") step = t("chat.activityWriting");
  }

  const activityAt = lastActivityAt ?? startedAt;
  const quiet = !waitingForInput && !compacting && activityAt !== null && now - activityAt >= RUN_QUIET_THRESHOLD_MS;
  return (
    <div className="chat-reading-column ui-agent-activity mb-2 flex min-w-0 items-center gap-2.5 px-1 text-xs text-text-muted">
      <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-accent motion-safe:animate-[pulse_1.5s_ease-in-out_infinite]" />
      <span role="status" className="min-w-0">
        <span className="block truncate" title={step}>{step}</span>
        {quiet && <span className="mt-0.5 block text-text-dim">{t("chat.activityQuiet")}</span>}
      </span>
      {startedAt !== null && (
        <span className="ml-auto shrink-0 tabular-nums text-text-dim">
          {t("chat.runningElapsed", { duration: formatRunDuration(now - startedAt, t) })}
        </span>
      )}
    </div>
  );
}

function isGoalOutcomeMessage(message: AgentMessage): message is CustomMessage & { customType: typeof GOAL_OUTCOME_TYPE } {
  return message.role === "custom" && message.customType === GOAL_OUTCOME_TYPE;
}

function getUserInputText(message: AgentMessage): string | null {
  return message.role === "user" ? getUserMessageText(message).trim() || null : null;
}

function aggregateTurnUsage(messages: AgentMessage[], start: number, end: number): AgentUsage | undefined {
  const usages = messages.slice(start, end + 1)
    .filter((message): message is AssistantMessage => message.role === "assistant" && Boolean(message.usage))
    .map((message) => message.usage!);
  if (usages.length === 0) return undefined;
  return {
    input: usages.reduce((sum, usage) => sum + usage.input, 0),
    output: usages.reduce((sum, usage) => sum + usage.output, 0),
    cacheRead: usages.reduce((sum, usage) => sum + usage.cacheRead, 0),
    cacheWrite: usages.reduce((sum, usage) => sum + usage.cacheWrite, 0),
    cost: {
      input: usages.reduce((sum, usage) => sum + (usage.cost?.input ?? 0), 0),
      output: usages.reduce((sum, usage) => sum + (usage.cost?.output ?? 0), 0),
      cacheRead: usages.reduce((sum, usage) => sum + (usage.cost?.cacheRead ?? 0), 0),
      cacheWrite: usages.reduce((sum, usage) => sum + (usage.cost?.cacheWrite ?? 0), 0),
      total: usages.reduce((sum, usage) => sum + (usage.cost?.total ?? 0), 0),
    },
  };
}

function activitySummary(blocks: AssistantContentBlock[], commandCount: number, t: (key: string, params?: Record<string, string | number>) => string): string {
  const counts = new Map<string, number>();
  for (const block of blocks) {
    if (block.type !== "toolCall") continue;
    const name = block.toolName.toLowerCase();
    const key = /^(read|grep|find|ls)$/.test(name) ? "chat.activityReadSummary"
      : /^(write|edit)$/.test(name) ? "chat.activityEditSummary"
      : /^(bash|powershell)$/.test(name) ? "chat.activityCommandSummary"
      : /^(web_search|get_search_content)$/.test(name) ? "chat.activitySearchSummary"
      : name.startsWith("computer_use_") ? "chat.activityComputerSummary"
      : "chat.activityToolSummary";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (commandCount > 0) counts.set("chat.activityCommandSummary", (counts.get("chat.activityCommandSummary") ?? 0) + commandCount);
  return [...counts].map(([key, count]) => t(key, { count })).join(" · ")
    || t(blocks.some((block) => block.type === "text") ? "chat.activityGoalDetails" : "chat.activityThoughtSummary");
}

function ProcessDetailsButton({ summary, activeLabel, hasFailure = false, open, onToggle, t }: {
  summary: string;
  activeLabel?: string | null;
  hasFailure?: boolean;
  open: boolean;
  onToggle: () => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const showFailure = hasFailure && !open;
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={(open ? t("chat.collapseProcess") : t("chat.expandProcess")) + ": " + summary}
      onClick={onToggle}
      title={open ? t("chat.collapseProcess") : t("chat.expandProcess")}
      style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", minWidth: 0, minHeight: 28, padding: "3px 0", border: "none", background: "transparent", color: showFailure ? "var(--error, #ef4444)" : "var(--text-muted)", cursor: "pointer", fontSize: 12, textAlign: "left" }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, color: activeLabel && !showFailure ? "var(--accent)" : undefined, animation: activeLabel ? "pulse 1.5s ease-in-out infinite" : undefined }}>
        <rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 9 3 3-3 3m6 0h4" />
      </svg>
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{activeLabel ? activeLabel + " · " + summary : summary}</span>
      <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}><path d="m4 2.5 3.5 3.5L4 9.5" /></svg>
    </button>
  );
}

function ProcessDetailsGroup({ children, ...button }: Omit<React.ComponentProps<typeof ProcessDetailsButton>, "open" | "onToggle"> & { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-process-group style={{ minWidth: 0, margin: "4px 0 14px" }}>
      <ProcessDetailsButton {...button} open={open} onToggle={() => setOpen((value) => !value)} />
      {open && <div style={{ minWidth: 0, margin: "6px 0 0 6px", paddingLeft: 14, borderLeft: "1px solid var(--border)" }}>{children}</div>}
    </div>
  );
}

type TurnSection = { key: string; process: boolean; entryId?: string; refIndices: Set<number>; views: ReactNode[] };

function TurnProcessSection({ open, entryId, sectionRef, children }: {
  open: boolean;
  entryId?: string;
  sectionRef?: (element: HTMLDivElement | null) => void;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (!mounted) return;
    const delay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 240;
    const timer = window.setTimeout(() => setMounted(false), delay);
    return () => window.clearTimeout(timer);
  }, [mounted, open]);
  return (
    <div ref={sectionRef} className="ui-turn-process" data-open={open} data-entry-id={open ? entryId : undefined} inert={!open} aria-hidden={!open}>
      <div className="ui-turn-process-content">{(open || mounted) && children}</div>
    </div>
  );
}

function TurnActivity({ sections, live, processEntryIds, attachProcessRefs, t }: {
  sections: TurnSection[];
  live: boolean;
  processEntryIds: string[];
  attachProcessRefs: (element: HTMLDivElement | null, indices?: Set<number>) => void;
  t: React.ComponentProps<typeof ProcessDetailsButton>["t"];
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (live) setOpen(false);
  }, [live]);
  return (
    <>
      {!live && sections.some(({ process }) => process) && (
        <div className="ui-turn-process-summary" data-entry-id={processEntryIds[0]} data-process-entry-ids={processEntryIds.join(" ")} ref={attachProcessRefs}>
          <ProcessDetailsButton summary={t("chat.processDetails")} open={open} onToggle={() => setOpen((value) => !value)} t={t} />
        </div>
      )}
      {sections.map((section) => section.process ? (
        <TurnProcessSection key={section.key} entryId={section.entryId} open={live || open}
          sectionRef={live ? (element) => attachProcessRefs(element, section.refIndices) : undefined}>
          {section.views}
        </TurnProcessSection>
      ) : <Fragment key={section.key}>{section.views}</Fragment>)}
    </>
  );
}

function TurnLabels({ message, modelNames, modeLabel }: {
  message?: AssistantMessage;
  modelNames?: Record<string, string>;
  modeLabel?: string;
}) {
  const model = message?.provider ? getModelDisplayName(message.provider, message.model, modelNames) : null;
  return (
    <div className="ui-turn-labels">
      {modeLabel && <span className="ui-turn-mode-label">{modeLabel}</span>}
      {model && (
        <span className="ui-stat-chip" title={model}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3l1.9 5.4L19 10l-5.1 1.6L12 17l-1.9-5.4L5 10l5.1-1.6L12 3z" />
          </svg>
          {model}
        </span>
      )}
    </div>
  );
}

export function ChatWindow({ session, searchTarget, onSearchTargetHandled, initialScrollPosition, onScrollPositionChange, sessionRunning, newSessionCwd, projectId, savedCwdOutsideProject, uploadCwd, newSessionDraftKey, onAgentEnd, onAttentionNeeded, onSessionCreated, onSessionForked, modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSystemToolsChange, onToolPresetControlChange, onSessionReloadControlChange, onSystemInfoLoaderChange, onSessionStatsChange, onSessionStatsPanelOpen, onContextUsageChange, onOpenFile, onOpenSession, subagentStatuses, previewOnly = false, onAskInNewChat, quoteSelectionEnabled = false, initialPrompt, onInitialPromptConsumed, soundEnabled = true, onSoundToggle, playDoneSound = () => {}, unlockAudio }: Props) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const showMinimapRail = !previewOnly && !isMobile;
  const completionNotificationsEnabled = !previewOnly && session?.relation?.kind !== "subagent";
  const [subagentMode, setSubagentMode] = useState<SubagentMode>(DEFAULT_SUBAGENT_MODE);
  const subagentToolsDialog = useRef<HTMLDialogElement>(null);
  const subagentToolsMessageId = useId();
  const [subagentModeToEnable, setSubagentModeToEnable] = useState<SubagentMode>("auto");
  const [composerWorkMode, setComposerWorkMode] = useState<WorkMode>("auto");
  const [computerUseApprovalPolicy, setComputerUseApprovalPolicy] = useState<ComputerUseApprovalPolicy | null>(null);
  const [sessionReloading, setSessionReloading] = useState(false);
  const reloadInProgressRef = useRef(false);
  useEffect(() => {
    setComputerUseApprovalPolicy(readPreferredApprovalPolicy());
  }, []);

  // Wrap onAgentEnd to play the completion sound. This is more reliable than
  // wrapping handleAgentEventRef because useAgentSession overwrites that ref
  // on every render (it syncs the latest callback), which would blow away an
  // externally-installed wrapper after the first re-render.
  const playDoneSoundRef = useRef(playDoneSound);
  playDoneSoundRef.current = playDoneSound;
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const soundedExtensionDialogIdRef = useRef<string | null>(null);
  const wrappedOnAgentEnd = useCallback(() => {
    if (completionNotificationsEnabled && soundEnabledRef.current) {
      playDoneSoundRef.current();
    }
    onAgentEnd?.();
  }, [completionNotificationsEnabled, onAgentEnd]);

  // 稳定化 onEditContent 引用，配合 React.memo 防止历史消息重渲染
  const handleEditContent = useCallback((message: UserMessage) => {
    chatInputRef?.current?.replaceMessage(message);
  }, [chatInputRef]);

  const initialScrollPositionRef = useRef(searchTarget ? null : initialScrollPosition ?? null);
  const [pendingScrollRestore, setPendingScrollRestore] = useState<Extract<ChatScrollPosition, { atBottom: false }> | null>(() => {
    const position = initialScrollPositionRef.current;
    return position && !position.atBottom ? position : null;
  });
  const [restoreAnchorReady, setRestoreAnchorReady] = useState(false);

  const {
    data, loading, error, messages, activeToolResults, liveSubagents, entryIds, historyCursor, hasEarlierMessages, streamState,
    agentRunning, bashRunning, pendingBash, modelNames, modelList, modelError, modelScopeWarnings, modelThinkingLevels, modelThinkingLevelMaps, toolPreset, toolPresetChanging, thinkingLevel,
    retryInfo, contextUsage, forkingEntryId,
    isCompacting, compactError, compactResult, displayModel: displayModelValue, modelSwitching, sessionStats,
    slashCommands, slashCommandsLoading, availableTools, queuedMessages,
    notices, extensionDialog, extensionCustomUi, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput, setNoticePaused,
    isAutoModelSelection,
    agentPhase, activeRunStartedAt, runLastActivityAt,
    isNew,
    sessionGoal, goalsEnabled, goalLoading, goalLoadError, loadGoal,
    activeComputerUseApprovalPolicy,
    sessionIdRef, scrollContainerRef,
    lastUserMsgRef, promptAnchorActive,
    handleSend, handleAbort, handleFork, handleNavigate, handleModelChange,
    handleFollowUp, handleAbortCompaction,
    handleQueueAction,
    handleBuiltinSlashCommand,
    handleToolPresetChange, handleThinkingLevelChange, handleWorkModeChange, handleGoalChange, loadTools, loadSlashCommands, scrollUserMsgToTop,
    loadContext, activeLeafId, scrollToBottom, scrollToMessage,
  } = useAgentSession({
    session, sessionRunning, newSessionCwd, projectId, savedCwdOutsideProject, newSessionDraftKey, onAgentEnd: wrappedOnAgentEnd, onAttentionNeeded, onSessionCreated, onSessionForked,
    modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSystemToolsChange, onSystemInfoLoaderChange, onSessionStatsPanelOpen,
    deferInitialScroll: Boolean(pendingScrollRestore),
    subagentMode: previewOnly || session?.relation?.kind === "subagent" ? undefined : subagentMode,
    previewOnly,
    composerWorkMode,
    computerUseApprovalPolicy: completionNotificationsEnabled ? computerUseApprovalPolicy ?? "ask" : "ask",
  });
  const persistedSessionId = session?.id ?? sessionIdRef.current ?? undefined;
  const goalCardStorageKey = persistedSessionId && `meteoragent:closed-goal:${persistedSessionId}`;
  const [closedGoalCard, setClosedGoalCard] = useState<{ key: string; revision: string | null } | null>(null);
  const endedGoal = sessionGoal?.status === "completed" || sessionGoal?.status === "cancelled" ? sessionGoal : null;
  const goalCardClosed = endedGoal && closedGoalCard?.key === goalCardStorageKey
    && closedGoalCard?.revision === String(endedGoal.revision);
  const goalFollowUp = composerWorkMode === "goal" && (sessionGoal?.status === "active"
    || (sessionGoal?.status === "blocked" && sessionGoal.reason === "blocked" && Boolean(sessionGoal.userAction)));

  useEffect(() => {
    if (!goalCardStorageKey) return;
    try {
      setClosedGoalCard({ key: goalCardStorageKey, revision: localStorage.getItem(goalCardStorageKey) });
    } catch {
      // The card still works when browser storage is unavailable.
    }
  }, [goalCardStorageKey]);

  const dismissGoalCard = () => {
    if (!goalCardStorageKey || !endedGoal) return;
    const revision = String(endedGoal.revision);
    setClosedGoalCard({ key: goalCardStorageKey, revision });
    try {
      localStorage.setItem(goalCardStorageKey, revision);
    } catch {
      // Keep the current browser state even if persistence fails.
    }
  };

  const [imageGeneration, setImageGeneration] = useState<{
    models: Array<{ providerId: string; groupName: string; modelId: string; alias: string; isDefault: boolean }>;
  }>({ models: [] });
  const [imageModelSwitching, setImageModelSwitching] = useState(false);
  const loadImageGeneration = useCallback(async () => {
    try {
      const sessionQuery = persistedSessionId ? `?sessionId=${encodeURIComponent(persistedSessionId)}` : "";
      const response = await fetch(`/api/relay-image-generation${sessionQuery}`, { cache: "no-store" });
      const data = await response.json() as {
        ok?: boolean;
        models?: Array<{ providerId: string; groupName: string; modelId: string; alias: string; isDefault: boolean }>;
      };
      if (response.ok && data.ok) setImageGeneration({ models: data.models ?? [] });
    } catch {
      // Image generation is optional; keep the chat controls usable offline.
    }
  }, [persistedSessionId]);
  useEffect(() => {
    if (previewOnly) return;
    void loadImageGeneration();
    const refresh = () => void loadImageGeneration();
    window.addEventListener("relay-config-updated", refresh);
    return () => window.removeEventListener("relay-config-updated", refresh);
  }, [loadImageGeneration, modelsRefreshKey, previewOnly]);
  const hasRelayMessages = messages.some((message) => (
    message.role === "assistant" && isRelayProviderId((message as AssistantMessage).provider)
  ));
  const hasSuccessfulImageGeneration = messages.some((message) => {
    if (message.role !== "toolResult" || message.toolName !== "image_generate" || message.isError) return false;
    const details = message.details as { images?: unknown } | undefined;
    return (Array.isArray(details?.images) && details.images.length > 0)
      || (Array.isArray(message.content) && message.content.some((block) => block.type === "image"));
  });
  const relayCostRevision = agentRunning || streamState.isStreaming
    ? "running"
    : `${entryIds.at(-1) ?? ""}:${entryIds.length}:${messages.length}:${hasSuccessfulImageGeneration ? "image" : ""}`;
  const relayActualCosts = useRelayActualCosts(
    persistedSessionId,
    relayCostRevision,
    hasRelayMessages || hasSuccessfulImageGeneration,
  );
  const authoritativeSessionStats = useMemo(() => {
    if (!sessionStats || !relayActualCosts.textChargesComplete || relayActualCosts.relayTurnCount === 0) return sessionStats;
    return {
      ...sessionStats,
      cost: Math.max(0, sessionStats.cost - relayActualCosts.estimatedRelayCost + relayActualCosts.actualRelayCost),
    };
  }, [sessionStats, relayActualCosts]);
  const imageBillingByAnchor = useMemo(() => {
    const byAnchor = new Map<string, ImageBillingSummary>();
    for (const charge of relayActualCosts.imageCharges) {
      const current = byAnchor.get(charge.anchorEntryId) ?? {
        imageCount: 0,
        chargeCount: 0,
        matchedChargeCount: 0,
        actualCost: 0,
      };
      current.imageCount += charge.imageCount;
      current.chargeCount += 1;
      if (charge.actualCost !== undefined) {
        current.matchedChargeCount += 1;
        current.actualCost += charge.actualCost;
      }
      byAnchor.set(charge.anchorEntryId, current);
    }
    return byAnchor;
  }, [relayActualCosts.imageCharges]);
  const sessionBusy = agentRunning || bashRunning;
  const composerBusy = sessionBusy || isCompacting;
  const stoppingCompaction = isCompacting && !sessionBusy;
  const stopRun = stoppingCompaction ? handleAbortCompaction : handleAbort;
  const hasToolPresetControl = projectId !== null && !savedCwdOutsideProject && completionNotificationsEnabled && (isNew || Boolean(session));
  const limitedTools = projectId === null || Boolean(savedCwdOutsideProject) || toolPreset === "none" || toolPreset === "read-only";
  const planMode = (data?.pendingWorkMode ?? data?.workMode ?? composerWorkMode) === "plan";
  const toolPresetDisabled = loading || Boolean(error) || composerBusy || toolPresetChanging || sessionReloading;
  const reloadDisabled = toolPresetDisabled || Boolean(queuedMessages?.steering.length || queuedMessages?.followUp.length);
  const handleSubagentModeChange = (mode: SubagentMode) => {
    if (toolPresetDisabled || planMode) return;
    if (limitedTools && mode !== "off") {
      setSubagentModeToEnable(mode);
      subagentToolsDialog.current?.showModal();
      return;
    }
    setSubagentMode(mode);
  };

  const enableSubagentTools = async () => {
    subagentToolsDialog.current?.close();
    if (toolPresetDisabled || planMode) return;
    if (await handleToolPresetChange("full", { remember: false })) setSubagentMode(subagentModeToEnable);
  };

  const reload = useCallback(async () => {
    if (!persistedSessionId || reloadDisabled || reloadInProgressRef.current) return;
    reloadInProgressRef.current = true;
    setSessionReloading(true);
    try {
      await handleBuiltinSlashCommand("/reload");
    } finally {
      reloadInProgressRef.current = false;
      setSessionReloading(false);
    }
  }, [handleBuiltinSlashCommand, persistedSessionId, reloadDisabled]);

  useEffect(() => {
    onSessionReloadControlChange?.(completionNotificationsEnabled && persistedSessionId
      ? { sessionId: persistedSessionId, busy: sessionReloading, disabled: reloadDisabled, reload }
      : null);
  }, [completionNotificationsEnabled, onSessionReloadControlChange, persistedSessionId, reload, reloadDisabled, sessionReloading]);
  useEffect(() => () => onSessionReloadControlChange?.(null), [onSessionReloadControlChange]);

  useEffect(() => {
    onToolPresetControlChange?.(hasToolPresetControl
      ? { value: toolPreset, disabled: toolPresetDisabled, onChange: handleToolPresetChange }
      : null);
  }, [handleToolPresetChange, hasToolPresetControl, onToolPresetControlChange, toolPreset, toolPresetDisabled]);
  useEffect(() => () => onToolPresetControlChange?.(null), [onToolPresetControlChange]);
  const selectedImageModel = imageGeneration.models.find((model) => model.isDefault);
  const handleImageModelChange = useCallback(async (providerId: string, modelId: string) => {
    if (imageModelSwitching || sessionBusy) return;
    setImageModelSwitching(true);
    try {
      const response = await fetch("/api/relay-image-generation", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId, modelId, ...(persistedSessionId ? { sessionId: persistedSessionId } : {}) }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok || result.error) throw new Error(result.error ?? `HTTP ${response.status}`);
      await loadImageGeneration();
      // pi-image-gen fixes its model-aware tool schema at registration. Reload
      // the existing session so the same conversation immediately sees the
      // new image model without replacing its primary chat model.
      if (persistedSessionId) {
        await sendAgentCommand(persistedSessionId, { type: "reload" });
        await loadSlashCommands();
      }
    } catch {
      // The settings panel remains the recovery path; never interrupt chat.
    } finally {
      setImageModelSwitching(false);
    }
  }, [imageModelSwitching, loadImageGeneration, loadSlashCommands, persistedSessionId, sessionBusy]);
  const [quotedSelection, setQuotedSelection] = useState<{
    text: string;
    top: number;
    left: number;
    sourceEntryId?: string;
  } | null>(null);
  const [quoteInputOpen, setQuoteInputOpen] = useState(false);
  const [quoteSubmitting, setQuoteSubmitting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const quotePopoverRef = useRef<HTMLDivElement | null>(null);
  const quoteChatInputRef = useRef<ChatInputHandle | null>(null);
  const closeQuotedSelection = useCallback(() => {
    setQuotedSelection(null);
    setQuoteInputOpen(false);
    setQuoteError(null);
  }, []);

  useEffect(() => {
    if (!quoteSelectionEnabled) closeQuotedSelection();
  }, [quoteSelectionEnabled, closeQuotedSelection]);

  const captureQuotedSelection = useCallback(() => {
    if (!quoteSelectionEnabled || quoteInputOpen) return;
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const root = messageContentRef.current;
    if (!selection || selection.isCollapsed || !range || !root || !root.contains(range.commonAncestorContainer)) {
      setQuotedSelection(null);
      return;
    }
    const text = selection.toString().trim();
    if (!text) {
      setQuotedSelection(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    const ancestor = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer as Element
      : range.commonAncestorContainer.parentElement;
    const start = range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer as Element
      : range.startContainer.parentElement;
    const end = range.endContainer.nodeType === Node.ELEMENT_NODE
      ? range.endContainer as Element
      : range.endContainer.parentElement;
    const sourceEntryId = [ancestor, start, end]
      .map((element) => element?.closest<HTMLElement>("[data-message-role=\"assistant\"]")?.dataset.entryId)
      .find((entryId): entryId is string => Boolean(entryId));
    setQuotedSelection({
      text,
      // rect 是视觉像素；引用弹层按 fixed CSS px 定位（会被根 zoom 放大），先换算。
      top: divideByUiScale(Math.min(window.innerHeight - 44, rect.bottom + 8)),
      left: divideByUiScale(Math.max(64, Math.min(window.innerWidth - 64, rect.left + rect.width / 2))),
      sourceEntryId,
    });
  }, [quoteSelectionEnabled, quoteInputOpen]);

  useEffect(() => {
    if (!quoteInputOpen || !quotedSelection) return;
    quoteChatInputRef.current?.insertIfEmpty(buildQuotedSelection(
      quotedSelection.text,
      t("chat.quoteIntro"),
      t("chat.quoteQuestion"),
    ));
  }, [quoteInputOpen, quotedSelection, t]);

  useLayoutEffect(() => {
    const popover = quotePopoverRef.current;
    if (!popover || !quotedSelection) return;
    const viewport = window.visualViewport;
    const position = () => {
      const rect = popover.getBoundingClientRect();
      // 视口偏移/尺寸与 rect.height 都是视觉像素，统一换算为 CSS 像素再定位。
      const top = divideByUiScale(viewport?.offsetTop ?? 0);
      const left = divideByUiScale(viewport?.offsetLeft ?? 0);
      const viewportHeight = divideByUiScale(viewport?.height ?? window.innerHeight);
      const viewportWidth = divideByUiScale(viewport?.width ?? window.innerWidth);
      const popoverHeight = divideByUiScale(rect.height);
      const popoverWidth = divideByUiScale(rect.width);
      popover.style.top = `${Math.max(top + 8, Math.min(quotedSelection.top, top + viewportHeight - popoverHeight - 8))}px`;
      popover.style.left = `${Math.max(left + 8, Math.min(quotedSelection.left - popoverWidth / 2, left + viewportWidth - popoverWidth - 8))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(popover);
    window.addEventListener("resize", position);
    viewport?.addEventListener("resize", position);
    viewport?.addEventListener("scroll", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      viewport?.removeEventListener("resize", position);
      viewport?.removeEventListener("scroll", position);
    };
  }, [quotedSelection, quoteInputOpen, quoteError]);

  useEffect(() => {
    if (!quotedSelection) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!quoteInputOpen && !quotePopoverRef.current?.contains(event.target as Node)) closeQuotedSelection();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      if (!quoteSubmitting) closeQuotedSelection();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [quotedSelection, quoteInputOpen, quoteSubmitting, closeQuotedSelection]);

  const askSelectionHere = useCallback(() => {
    if (!quotedSelection) return;
    chatInputRef?.current?.insertText(buildQuotedSelection(
      quotedSelection.text,
      t("chat.quoteIntro"),
      t("chat.quoteQuestion"),
    ));
    window.getSelection()?.removeAllRanges();
    closeQuotedSelection();
  }, [chatInputRef, quotedSelection, closeQuotedSelection, t]);

  const askSelectionInNewChat = useCallback(async (prompt: string) => {
    const sourceSessionId = sessionIdRef.current ?? session?.id;
    if (quoteSubmitting || !prompt.trim() || !quotedSelection?.sourceEntryId || !sourceSessionId || !onAskInNewChat) return;
    setQuoteSubmitting(true);
    setQuoteError(null);
    unlockAudio?.();
    try {
      await onAskInNewChat(
        prompt,
        sourceSessionId,
        quotedSelection.sourceEntryId,
      );
      closeQuotedSelection();
    } catch (error) {
      quoteChatInputRef.current?.restoreSubmission(prompt);
      setQuoteError(error instanceof Error ? error.message : String(error));
    } finally {
      setQuoteSubmitting(false);
    }
  }, [onAskInNewChat, quotedSelection, quoteSubmitting, session?.id, sessionIdRef, closeQuotedSelection, unlockAudio]);

  const initialPromptSentRef = useRef(false);
  useEffect(() => {
    if (loading || error || computerUseApprovalPolicy === null || !initialPrompt || initialPromptSentRef.current) return;
    initialPromptSentRef.current = true;
    onInitialPromptConsumed?.();
    void handleSend(initialPrompt);
  }, [initialPrompt, loading, error, computerUseApprovalPolicy, handleSend, onInitialPromptConsumed]);

  useEffect(() => {
    if (
      !completionNotificationsEnabled
      || !extensionDialog
      || soundedExtensionDialogIdRef.current === extensionDialog.id
    ) return;
    soundedExtensionDialogIdRef.current = extensionDialog.id;
    playDoneSoundRef.current();
  }, [completionNotificationsEnabled, extensionDialog]);

  // Register the abort handler for the global Esc shortcut
  useEffect(() => {
    if (previewOnly) return;
    registerAbortHandler(composerBusy ? stopRun : null);
    return () => registerAbortHandler(null);
  }, [composerBusy, previewOnly, stopRun]);

  // The server bounds history to the pages requested so far.
  const sentinelRef = useRef<HTMLDivElement>(null);
  const messageContentRef = useRef<HTMLDivElement | null>(null);
  const prependAnchorRef = useRef<{ element: HTMLElement; entryId: string; offset: number } | null>(null);
  const loadingOlderRef = useRef(false);
  const restoreStartedRef = useRef(false);
  const pendingScrollRestoreRef = useRef(pendingScrollRestore);
  pendingScrollRestoreRef.current = pendingScrollRestore;
  const [pendingSearchScroll, setPendingSearchScroll] = useState<Props["searchTarget"]>(null);
  const searchMessage = messages[entryIds.indexOf(pendingSearchScroll?.entryId ?? "")];
  const searchBlock = searchMessage?.role === "assistant"
    ? (pendingSearchScroll?.blockIndex === undefined
      ? searchMessage.content.find((block) => block.type === "text")
      : searchMessage.content[pendingSearchScroll.blockIndex])
    : undefined;
  const searchHistoryRef = useRef({ entryIds, historyCursor, hasEarlierMessages });
  searchHistoryRef.current = { entryIds, historyCursor, hasEarlierMessages };

  const capturePrependAnchor = useCallback(() => {
    const container = scrollContainerRef.current;
    const content = messageContentRef.current;
    prependAnchorRef.current = null;
    if (!container || !content) return;
    const viewportTop = container.getBoundingClientRect().top;
    for (const element of content.children) {
      if (!(element instanceof HTMLElement) || !element.dataset.entryId) continue;
      const rect = element.getBoundingClientRect();
      if (rect.height === 0 || rect.bottom <= viewportTop) continue;
      prependAnchorRef.current = { element, entryId: element.dataset.entryId, offset: rect.top - viewportTop };
      break;
    }
  }, [scrollContainerRef]);

  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current;
    const container = scrollContainerRef.current;
    const content = messageContentRef.current;
    prependAnchorRef.current = null;
    if (!anchor || !container || !content) return;
    const element = anchor.element.parentElement === content
      ? anchor.element
      : Array.from(content.children).find((candidate) => candidate instanceof HTMLElement && (
        candidate.dataset.entryId === anchor.entryId || candidate.dataset.processEntryIds?.split(" ").includes(anchor.entryId)
      ));
    if (!element) return;
    const offset = element.getBoundingClientRect().top - container.getBoundingClientRect().top;
    container.scrollTo({ top: container.scrollTop + divideByUiScale(offset - anchor.offset), behavior: "instant" });
  }, [entryIds, historyCursor, scrollContainerRef]);

  useLayoutEffect(() => {
    const sessionId = session?.id;
    const container = scrollContainerRef.current;
    const content = messageContentRef.current;
    if (!sessionId || !onScrollPositionChange || !container || !content) return;
    return () => {
      if (pendingScrollRestoreRef.current) return;
      if (isScrollAtTail(container.scrollTop, container.clientHeight, container.scrollHeight)) {
        onScrollPositionChange(sessionId, { atBottom: true });
        return;
      }
      const viewportTop = container.getBoundingClientRect().top;
      const candidates = Array.from(content.children).flatMap((element) => {
        if (!(element instanceof HTMLElement) || !element.dataset.entryId) return [];
        const rect = element.getBoundingClientRect();
        return [{ entryId: element.dataset.entryId, top: rect.top, bottom: rect.bottom }];
      });
      const anchor = findChatScrollAnchor(candidates, viewportTop);
      if (!anchor) return;
      onScrollPositionChange(sessionId, {
        atBottom: false,
        ...anchor,
        oldestEntryId: searchHistoryRef.current.historyCursor,
      });
    };
  }, [loading, onScrollPositionChange, scrollContainerRef, session?.id]);

  useEffect(() => {
    if (searchTarget) setPendingScrollRestore(null);
  }, [searchTarget]);

  useEffect(() => {
    const position = pendingScrollRestore;
    const sessionId = session?.id;
    if (!position || !sessionId || loading || searchTarget || restoreStartedRef.current) return;
    restoreStartedRef.current = true;
    const controller = new AbortController();

    const locate = async () => {
      const initialHistory = searchHistoryRef.current;
      if (initialHistory.entryIds.includes(position.anchorEntryId)) {
        setRestoreAnchorReady(true);
        return;
      }

      loadingOlderRef.current = true;
      let before = initialHistory.historyCursor;
      let hasMore = initialHistory.hasEarlierMessages;
      try {
        while (hasMore && before && !controller.signal.aborted) {
          const context = await loadContext(sessionId, activeLeafId, before, { signal: controller.signal });
          if (controller.signal.aborted) return;
          if (!context) {
            scrollToBottom("instant");
            setPendingScrollRestore(null);
            return;
          }
          if (context.entryIds.includes(position.anchorEntryId)) {
            setRestoreAnchorReady(true);
            return;
          }
          if (context.oldestEntryId === position.oldestEntryId) break;
          before = context.oldestEntryId;
          hasMore = context.hasMore;
        }
        if (!controller.signal.aborted) {
          scrollToBottom("instant");
          setPendingScrollRestore(null);
        }
      } finally {
        loadingOlderRef.current = false;
      }
    };

    void locate();
    return () => {
      controller.abort();
      // A branch change cancels restoration and must reveal the new context.
      setPendingScrollRestore(null);
    };
  }, [activeLeafId, loadContext, loading, pendingScrollRestore, scrollToBottom, searchTarget, session?.id]);

  useLayoutEffect(() => {
    const position = pendingScrollRestore;
    const content = messageContentRef.current;
    if (!position || !content || searchTarget) return;
    const element = Array.from(content.children).find((candidate) => (
      candidate instanceof HTMLElement && (candidate.dataset.entryId === position.anchorEntryId
        || candidate.dataset.processEntryIds?.split(" ").includes(position.anchorEntryId))
    ));
    if (element instanceof HTMLElement) {
      scrollToMessage(element, position.anchorOffset);
      setPendingScrollRestore(null);
      return;
    }
    if (restoreAnchorReady) {
      scrollToBottom("instant");
      setPendingScrollRestore(null);
    }
  }, [entryIds, pendingScrollRestore, restoreAnchorReady, scrollToBottom, scrollToMessage, searchTarget]);

  useEffect(() => {
    if (!searchTarget || loading) return;
    const controller = new AbortController();
    const locate = async () => {
      const history = searchHistoryRef.current;
      let found = history.entryIds.includes(searchTarget.entryId);
      if (!found && !sessionBusy && history.hasEarlierMessages && history.historyCursor && !loadingOlderRef.current) {
        loadingOlderRef.current = true;
        // ponytail: one extra page of 200 entries; deeper or other-branch hits just open the session.
        const context = await loadContext(searchTarget.sessionId, activeLeafId, history.historyCursor, {
          tail: 200, signal: controller.signal, onBeforePrepend: capturePrependAnchor,
        });
        loadingOlderRef.current = false;
        found = Boolean(context?.entryIds.includes(searchTarget.entryId));
      }
      if (controller.signal.aborted) return;
      if (found) {
        setPendingSearchScroll(searchTarget);
      } else {
        onSearchTargetHandled?.(searchTarget);
      }
    };
    void locate();
    return () => controller.abort();
  }, [searchTarget, loading, activeLeafId, sessionBusy, loadContext, onSearchTargetHandled, capturePrependAnchor]);

  useLayoutEffect(() => {
    if (!pendingSearchScroll || pendingSearchScroll !== searchTarget) return;
    const selector = `[data-entry-id="${CSS.escape(pendingSearchScroll.entryId)}"]`;
    const container = scrollContainerRef.current;
    const processSelector = `[data-process-entry-ids~="${CSS.escape(pendingSearchScroll.entryId)}"]`;
    const element = container?.querySelector<HTMLElement>(`${selector} [data-search-target]`)
      ?? container?.querySelector<HTMLElement>(selector)
      ?? container?.querySelector<HTMLElement>(processSelector);
    if (element) {
      scrollToMessage(element);
      element.animate([
        { backgroundColor: "var(--bg-selected)" },
        { backgroundColor: "transparent" },
      ], { duration: 2500 });
    }
    setPendingSearchScroll(null);
    onSearchTargetHandled?.(pendingSearchScroll);
  }, [pendingSearchScroll, searchTarget, scrollContainerRef, scrollToMessage, onSearchTargetHandled]);

  // IntersectionObserver on the sentinel div at the top of the message list.
  // When it becomes visible, load the next page of older messages.
  useEffect(() => {
    if (loading || pendingScrollRestore || searchTarget || !hasEarlierMessages) return;
    const sentinel = sentinelRef.current;
    const container = scrollContainerRef.current;
    if (!sentinel || !container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        if (loadingOlderRef.current) return;
        const oldestId = historyCursor;
        if (!oldestId) return;
        const sid = session?.id ?? sessionIdRef.current;
        if (!sid) return;
        loadingOlderRef.current = true;
        void loadContext(sid, null, oldestId, { onBeforePrepend: capturePrependAnchor }).finally(() => {
          loadingOlderRef.current = false;
        });
      },
      { root: container, threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loading, historyCursor, hasEarlierMessages, pendingScrollRestore, searchTarget, session?.id, loadContext, sessionIdRef, scrollContainerRef, capturePrependAnchor]);
  // Push session stats up to AppShell for the top bar.
  // Compare scalar fields to avoid loops from new object identity each render.
  const statsKey = authoritativeSessionStats
    ? [
      authoritativeSessionStats.sessionId,
      authoritativeSessionStats.sessionFile ?? "",
      authoritativeSessionStats.sessionName ?? "",
      authoritativeSessionStats.userMessages,
      authoritativeSessionStats.assistantMessages,
      authoritativeSessionStats.toolCalls,
      authoritativeSessionStats.toolResults,
      authoritativeSessionStats.totalMessages,
      authoritativeSessionStats.tokens.input,
      authoritativeSessionStats.tokens.output,
      authoritativeSessionStats.tokens.cacheRead,
      authoritativeSessionStats.tokens.cacheWrite,
      authoritativeSessionStats.tokens.total,
      authoritativeSessionStats.cost ?? 0,
      authoritativeSessionStats.totalActiveMs ?? 0,
    ].join("|")
    : null;
  const sessionStatsRef = useRef(authoritativeSessionStats);
  sessionStatsRef.current = authoritativeSessionStats;
  useEffect(() => {
    onSessionStatsChange?.(sessionStatsRef.current);
  }, [statsKey, onSessionStatsChange]);
  useEffect(() => () => { onSessionStatsChange?.(null); }, [onSessionStatsChange]);

  // Push context usage up to AppShell as well.
  const ctxKey = contextUsage
    ? `${contextUsage.percent ?? "null"}|${contextUsage.contextWindow}|${contextUsage.tokens ?? "null"}`
    : null;
  const contextUsageRef = useRef(contextUsage);
  contextUsageRef.current = contextUsage;
  useEffect(() => {
    onContextUsageChange?.(contextUsageRef.current);
  }, [ctxKey, onContextUsageChange]);
  useEffect(() => () => { onContextUsageChange?.(null); }, [onContextUsageChange]);

  const onDrop = useCallback((files: File[]) => {
    chatInputRef?.current?.addImages(files);
  }, [chatInputRef]);

  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(onDrop);

  const visibleMessages = messages.filter((m) => isMessageGroupAnchor(m) || m.role === "assistant");
  // Stable Map identity: `messages` doesn't change during streaming updates
  // (the streaming message lives in streamState), so memoized MessageViews
  // skip re-rendering on every message_update event. An inline `new Map()`
  // here used to defeat MessageView's memo() on each streamed chunk.
  const { toolResultsMap, pairedSubagentNotifications } = useMemo(() => {
    const map = new Map(activeToolResults);
    for (const msg of messages) {
      if (msg.role === "toolResult") {
        map.set((msg as ToolResultMessage).toolCallId, msg as ToolResultMessage);
      }
    }
    for (const [toolCallId, details] of liveSubagents) {
      const previous = map.get(toolCallId);
      map.set(toolCallId, {
        role: "toolResult",
        toolCallId,
        toolName: "Agent",
        content: [],
        ...previous,
        details,
      });
    }
    const pairedNotifications = new Set<CustomMessage>();
    const latestLaunchBySession = new Map<string, string>();
    for (const message of messages) {
      if (message.role === "assistant") {
        for (const block of message.content) {
          if (block.type !== "toolCall" || block.toolName !== "Agent") continue;
          const details = map.get(block.toolCallId)?.details;
          if (isSubagentToolDetails(details)) latestLaunchBySession.set(details.sessionId, block.toolCallId);
        }
      } else if (message.role === "custom" && message.customType === SUBAGENT_NOTIFICATION_TYPE
        && isSubagentToolDetails(message.details)) {
        const toolCallId = latestLaunchBySession.get(message.details.sessionId);
        const launch = toolCallId ? map.get(toolCallId) : undefined;
        if (launch && toolCallId) {
          map.set(toolCallId, { ...launch, details: message.details });
          pairedNotifications.add(message);
        }
      }
    }
    for (const [id, result] of map) {
      if (result.toolName !== "Agent" || !isSubagentToolDetails(result.details)) continue;
      const { sessionId, status } = result.details;
      const catalogStatus = subagentStatuses?.get(sessionId);
      if (!catalogStatus || catalogStatus === status || status === "completed" || status === "failed" || status === "aborted") continue;
      if (catalogStatus === "starting" || (catalogStatus === "queued" && status === "running")) continue;
      map.set(id, { ...result, details: { ...result.details, status: catalogStatus } });
    }
    return { toolResultsMap: map, pairedSubagentNotifications: pairedNotifications };
  }, [activeToolResults, liveSubagents, messages, subagentStatuses]);
  const inputHistory = useMemo(() => {
    const seen = new Set<string>();
    const history: string[] = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const text = getUserInputText(messages[i]);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      history.push(text);
      if (history.length >= 50) break;
    }
    return history.reverse();
  }, [messages]);
  const messageRefs = useMessageRefs(visibleMessages.length);

  const isEmptyNew = isNew && messages.length === 0 && !streamState.isStreaming && !sessionBusy;
  const hasStreamingContent = Boolean(streamState.streamingMessage?.content.length);
  const messageCwd = projectId === null ? undefined : session?.cwd ?? newSessionCwd ?? undefined;
  const promptAnchorSpacerRef = useRef<HTMLDivElement | null>(null);
  const promptAnchorSpacerHeightRef = useRef(0);
  const promptAnchorMeasureFrameRef = useRef<number | null>(null);
  const promptAnchorAdjustmentDoneRef = useRef(false);
  const promptAnchorUpdateRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const spacer = promptAnchorSpacerRef.current;
    if (!agentRunning || !promptAnchorActive) {
      promptAnchorUpdateRef.current = null;
      promptAnchorSpacerHeightRef.current = 0;
      promptAnchorAdjustmentDoneRef.current = false;
      if (spacer) spacer.style.height = "";
      return;
    }

    const container = scrollContainerRef.current;
    const messageContent = messageContentRef.current;
    const userMessage = lastUserMsgRef.current;
    if (!container || !messageContent || !userMessage || !spacer) return;

    let disposed = false;
    const updatePromptAnchorSpacer = () => {
      if (
        disposed
        || scrollContainerRef.current !== container
        || messageContentRef.current !== messageContent
        || lastUserMsgRef.current !== userMessage
        || promptAnchorSpacerRef.current !== spacer
      ) return;

      const containerTop = container.getBoundingClientRect().top;
      const userMessageTop = userMessage.getBoundingClientRect().top
        - containerTop
        + container.scrollTop;
      const targetTop = Math.max(0, userMessageTop - 16);
      const contentEnd = spacer.getBoundingClientRect().top
        - containerTop
        + container.scrollTop;
      const nextPromptAnchorSpacerHeight = getPromptAnchorSpacerHeight(
        targetTop,
        contentEnd,
        container.clientHeight,
      );

      const isInitialMeasurement = !promptAnchorAdjustmentDoneRef.current;
      const needsInitialAdjustment = isInitialMeasurement
        && nextPromptAnchorSpacerHeight > 0;
      if (isInitialMeasurement) promptAnchorAdjustmentDoneRef.current = true;
      if (nextPromptAnchorSpacerHeight === promptAnchorSpacerHeightRef.current) return;

      promptAnchorSpacerHeightRef.current = nextPromptAnchorSpacerHeight;
      spacer.style.height = nextPromptAnchorSpacerHeight > 0
        ? `${nextPromptAnchorSpacerHeight}px`
        : "";
      if (needsInitialAdjustment) scrollUserMsgToTop();
    };

    promptAnchorUpdateRef.current = updatePromptAnchorSpacer;
    const schedulePromptAnchorMeasure = () => {
      if (disposed || promptAnchorMeasureFrameRef.current !== null) return;
      promptAnchorMeasureFrameRef.current = requestAnimationFrame(() => {
        promptAnchorMeasureFrameRef.current = null;
        updatePromptAnchorSpacer();
      });
    };

    updatePromptAnchorSpacer();
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(schedulePromptAnchorMeasure);
    observer?.observe(container);
    observer?.observe(messageContent);
    observer?.observe(userMessage);
    return () => {
      disposed = true;
      if (promptAnchorUpdateRef.current === updatePromptAnchorSpacer) {
        promptAnchorUpdateRef.current = null;
      }
      observer?.disconnect();
      if (promptAnchorMeasureFrameRef.current !== null) {
        cancelAnimationFrame(promptAnchorMeasureFrameRef.current);
        promptAnchorMeasureFrameRef.current = null;
      }
    };
  }, [
    agentRunning,
    lastUserMsgRef,
    messages.length,
    promptAnchorActive,
    scrollContainerRef,
    scrollUserMsgToTop,
  ]);

  useLayoutEffect(() => {
    promptAnchorUpdateRef.current?.();
  }, [streamState.streamingMessage]);

  const availableThinkingLevels = displayModelValue
    ? (modelThinkingLevels[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const currentThinkingLevelMap = displayModelValue
    ? (modelThinkingLevelMaps[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const chatInputElement = (
    <ChatInput
      projectId={projectId ?? undefined}
      uploadCwd={uploadCwd}
      ref={chatInputRef}
      onSend={handleSend}
      onAbort={stopRun}
      stopLabel={stoppingCompaction ? t("chat.stopCompaction") : undefined}
      onFollowUp={agentRunning ? handleFollowUp : undefined}
      isStreaming={composerBusy}
      submissionDisabled={toolPresetChanging || sessionReloading}
      model={displayModelValue}
      isAutoModelSelection={isAutoModelSelection}
      modelNames={modelNames}
      modelList={modelList}
      modelError={modelError}
      modelScopeWarnings={modelScopeWarnings}
      onModelChange={handleModelChange}
      modelSwitching={modelSwitching}
      imageModel={selectedImageModel ? { provider: selectedImageModel.providerId, modelId: selectedImageModel.modelId } : null}
      imageModelList={imageGeneration.models.map((imageModel) => ({
        provider: imageModel.providerId,
        providerDisplayName: imageModel.groupName,
        id: imageModel.modelId,
        name: imageModel.modelId,
      }))}
      onImageModelChange={handleImageModelChange}
      imageModelSwitching={imageModelSwitching}
      compactError={compactError}
      compactResult={compactResult}
      workMode={data?.workMode ?? "auto"}
      pendingWorkMode={data?.pendingWorkMode}
      onResolvedWorkMode={setComposerWorkMode}
      showWorkMode={isNew || Boolean(data)}
      workModeDisabled={previewOnly || session?.relation?.kind === "subagent"}
      messagePlaceholder={goalFollowUp ? t("chat.goal.followUpPlaceholder") : undefined}
      approvalPolicyControl={completionNotificationsEnabled && <ApprovalPolicySelector
        policy={computerUseApprovalPolicy ?? "ask"}
        currentRunPolicy={sessionBusy ? activeComputerUseApprovalPolicy ?? "ask" : undefined}
        onChange={(policy) => {
          savePreferredApprovalPolicy(policy);
          setComputerUseApprovalPolicy(policy);
        }}
        disabled={computerUseApprovalPolicy === null}
        limited={limitedTools || planMode}
      />}
      subagentMode={limitedTools || planMode ? "off" : subagentMode}
      onSubagentModeChange={projectId !== null && !savedCwdOutsideProject && completionNotificationsEnabled ? handleSubagentModeChange : undefined}
      subagentModeDisabled={planMode || toolPresetDisabled}
      subagentModeDialog={completionNotificationsEnabled && limitedTools && (
        <dialog
          ref={subagentToolsDialog}
          className={approvalStyles.warning}
          aria-label={t("chat.subagentMode")}
          aria-describedby={subagentToolsMessageId}
          onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}
        >
          <p id={subagentToolsMessageId} className={approvalStyles.warningText}>{t("chat.subagentEnableTools")}</p>
          <div className={approvalStyles.actions}>
            <button type="button" autoFocus onClick={() => subagentToolsDialog.current?.close()}>{t("chat.cancel")}</button>
            <button type="button" disabled={toolPresetDisabled || planMode} onClick={() => void enableSubagentTools()}>{t("chat.confirm")}</button>
          </div>
        </dialog>
      )}
      onSessionWorkModeChange={!isNew ? handleWorkModeChange : undefined}
      onNewWorkModeChanged={isNew ? async () => {
        const sid = sessionIdRef.current;
        if (sid) await loadTools(sid);
      } : undefined}
      thinkingLevel={thinkingLevel}
      onThinkingLevelChange={session || isNew ? handleThinkingLevelChange : undefined}
      availableThinkingLevels={availableThinkingLevels}
      thinkingLevelMap={currentThinkingLevelMap}
      retryInfo={retryInfo}
      queuedMessages={queuedMessages}
      inputHistory={inputHistory}
      onQueueAction={handleQueueAction}
      slashCommands={slashCommands}
      slashCommandsLoading={slashCommandsLoading}
      availableTools={availableTools}
      onLoadSlashCommands={loadSlashCommands}
      onBuiltinCommand={handleBuiltinSlashCommand}
      soundEnabled={soundEnabled}
      onSoundToggle={onSoundToggle}
      onAudioUnlock={unlockAudio}
      draftKey={session?.id ?? newSessionDraftKey ?? undefined}
      cwd={messageCwd ?? null}
    />
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-text-muted">
         {t("chat.loadingSession")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-red-400">
        {error}
      </div>
    );
  }

  return (
    <div
      className="chat-content relative flex h-full min-w-0 flex-col overflow-hidden"
      data-chat-preview={previewOnly || undefined}
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex animate-[drop-zone-in_0.15s_ease_both] items-center justify-center bg-[rgba(37,99,235,0.06)] backdrop-blur-[1px]">
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {[0, 0.8, 1.6].map((delay) => (
              <div
                key={delay}
                className="absolute h-[720px] w-[720px] rounded-full border-[1.5px] border-solid border-[rgba(37,99,235,0.5)] animate-[drop-ripple_2.4s_ease-out_infinite_backwards]"
                style={{ transformOrigin: "center", animationDelay: `${delay}s` }}
              />
            ))}
          </div>
          <svg
            width="280" height="280" viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg"
            className="drop-shadow-[0_6px_18px_rgba(37,99,235,0.18)]"
          >
            <rect x="28" y="44" width="84" height="60" rx="8" fill="rgba(37,99,235,0.08)" stroke="rgba(37,99,235,0.50)" strokeWidth="1.8"/>
            <path d="M36 100 L54 72 L68 88 L80 74 L104 100Z" fill="rgba(37,99,235,0.16)" stroke="rgba(37,99,235,0.40)" strokeWidth="1.4" strokeLinejoin="round"/>
            <circle cx="96" cy="58" r="8" fill="rgba(37,99,235,0.22)" stroke="rgba(37,99,235,0.55)" strokeWidth="1.6"/>
            <g stroke="rgba(37,99,235,0.45)" strokeWidth="1.4" strokeLinecap="round">
              <line x1="96" y1="46" x2="96" y2="43"/>
              <line x1="96" y1="70" x2="96" y2="73"/>
              <line x1="84" y1="58" x2="81" y2="58"/>
              <line x1="108" y1="58" x2="111" y2="58"/>
              <line x1="87.5" y1="49.5" x2="85.4" y2="47.4"/>
              <line x1="104.5" y1="66.5" x2="106.6" y2="68.6"/>
              <line x1="104.5" y1="49.5" x2="106.6" y2="47.4"/>
              <line x1="87.5" y1="66.5" x2="85.4" y2="68.6"/>
            </g>
          </svg>
        </div>
      )}

      <div
        className="chat-column-inset"
        style={{
          position: "absolute",
          top: 12,
          left: 0,
          right: showMinimapRail ? CHAT_MINIMAP_WIDTH : 0,
          zIndex: 40,
          display: "flex",
          // Toasts live in the top-right corner
          justifyContent: "flex-end",
          pointerEvents: "none",
        }}
      >
        <NoticeShelf notices={notices} floating onPauseChange={setNoticePaused} />
      </div>

      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {extensionDialog ? (
          <ExtensionDialog key={extensionDialog.id} request={extensionDialog} onRespond={respondToExtensionUi} />
        ) : extensionCustomUi && (
          <ExtensionCustomPanel key={extensionCustomUi.id} request={extensionCustomUi} onInput={sendExtensionCustomInput} />
        )}
        {!isEmptyNew && <>
        <div
          ref={scrollContainerRef}
          className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto pt-4 [scrollbar-width:none]"
          style={{ visibility: pendingScrollRestore ? "hidden" : undefined }}
        >
          <div className="chat-column-inset">
            <div ref={messageContentRef} onPointerUp={captureQuotedSelection} className="chat-reading-column">
            {(() => {
              const timelineMessages: AgentMessage[] = streamState.isStreaming && hasStreamingContent && streamState.streamingMessage
                ? [...messages, streamState.streamingMessage as AgentMessage]
                : messages;
              const lastUserIdx = timelineMessages.findLastIndex((message) => message.role === "user");
              const lastTurnStartIdx = timelineMessages.findLastIndex(startsUserTurn);
              const getMessageKey = (index: number) => entryIds[index] ?? `live-${index - entryIds.length}`;
              const visibleRefIndexByMessage = new Map<number, number>();
              const goalOutcomeByAssistant = new Map<number, ReturnType<typeof readGoalOutcomeStatus>>();
              let refIdx = 0;
              let lastAssistantIdx = -1;
              timelineMessages.forEach((msg, idx) => {
                if (isMessageGroupAnchor(msg) || msg.role === "assistant") {
                  visibleRefIndexByMessage.set(idx, refIdx++);
                }
                // A compaction can separate the outcome entry from its final reply.
                if (msg.role === "user") {
                  lastAssistantIdx = -1;
                } else if (msg.role === "assistant") {
                  lastAssistantIdx = idx;
                } else if (lastAssistantIdx !== -1 && isGoalOutcomeMessage(msg)) {
                  goalOutcomeByAssistant.set(lastAssistantIdx, readGoalOutcomeStatus(msg.details));
                }
              });

              const attachVisibleRef = (idx: number, refIndex: number) => (el: HTMLDivElement | null) => {
                messageRefs.current[refIndex] = el;
                if (idx === lastUserIdx) { (lastUserMsgRef as { current: HTMLDivElement | null }).current = el; }
              };

              const renderMessage = (idx: number, options: {
                attachRef?: boolean;
                blockIndices?: number[];
                hideMetadata?: boolean;
                keyPrefix?: string;
                messageOverride?: AgentMessage;
                showTimestamp?: boolean;
                showModel?: boolean;
                compactUsage?: boolean;
                usageOverride?: AgentUsage;
                actualCost?: number;
                relayBilling?: TurnRelayBilling;
                imageBilling?: ImageBillingSummary;
                writtenFiles?: WrittenFile[];
                canForkReply?: boolean;
              } = {}): ReactNode => {
                const msg = options.messageOverride ?? timelineMessages[idx];
                const isVisible = isMessageGroupAnchor(msg) || msg.role === "assistant";
                const currentRefIdx = visibleRefIndexByMessage.get(idx);
                const keyPrefix = options.keyPrefix ?? "message";
                const messageKey = getMessageKey(idx);
                let showTimestamp = false;
                if (msg.role === "assistant") {
                  showTimestamp = true;
                  for (let j = idx + 1; j < timelineMessages.length; j++) {
                    const r = timelineMessages[j].role;
                    if (r === "user") break;
                    if (r === "assistant") { showTimestamp = false; break; }
                  }
                  // Hide on the currently-streaming tail (the streaming bubble owns the live timestamp)
                  if (showTimestamp && streamState.isStreaming && idx === timelineMessages.length - 1) {
                    showTimestamp = false;
                  }
                }
                if (options.showTimestamp !== undefined) showTimestamp = options.showTimestamp;
                const onFork = options.canForkReply && !previewOnly && !sessionBusy && !isNew ? handleFork : undefined;
                const view = (
                  <MessageView
                    key={`${keyPrefix}-view-${messageKey}`}
                    message={msg}
                    animateIn={!entryIds[idx]}
                    isStreaming={streamState.isStreaming && idx === messages.length}
                    blockIndices={options.blockIndices}
                    hideMetadata={options.hideMetadata}
                    toolResults={toolResultsMap}
                    modelNames={modelNames}
                    cwd={messageCwd}
                    onOpenFile={onOpenFile}
                    onOpenSession={onOpenSession}
                    entryId={entryIds[idx]}
                    searchBlock={entryIds[idx] === pendingSearchScroll?.entryId ? searchBlock : undefined}
                    onFork={onFork}
                    forkingEntryId={onFork ? forkingEntryId : undefined}
                    onNavigate={previewOnly || sessionBusy ? undefined : handleNavigate}
                    onEditContent={previewOnly ? undefined : handleEditContent}
                    showTimestamp={showTimestamp}
                    prevTimestamp={idx > 0 ? (timelineMessages[idx - 1] as AgentMessage & { timestamp?: number }).timestamp : undefined}
                    sessionId={session?.id ?? sessionIdRef.current ?? undefined}
                    actualCost={"actualCost" in options ? options.actualCost : (entryIds[idx] ? relayActualCosts.costs[entryIds[idx]]?.actualCost : undefined)}
                    usageOverride={options.usageOverride}
                    relayBilling={options.relayBilling}
                    showModel={options.showModel}
                    compactUsage={options.compactUsage}
                    imageBilling={"imageBilling" in options ? options.imageBilling : (entryIds[idx] ? imageBillingByAnchor.get(entryIds[idx]) : undefined)}
                    writtenFiles={options.writtenFiles}
                  />
                );
                if (!isVisible || currentRefIdx === undefined) return view;
                return (
                  <div key={`${keyPrefix}-${messageKey}`} data-entry-id={entryIds[idx]} ref={options.attachRef === false ? undefined : attachVisibleRef(idx, currentRefIdx)}>
                    {view}
                  </div>
                );
              };

              const rendered: ReactNode[] = [];
              const goalUnavailable = goalsEnabled && (goalLoading || goalLoadError);
              for (let idx = 0; idx < timelineMessages.length;) {
                if (isSessionForkDivider(timelineMessages[idx])) {
                  const label = t("chat.forkOriginDivider");
                  rendered.push(
                    <div key={getMessageKey(idx)} role="separator" aria-label={label} className="my-6 flex items-center gap-3 text-xs text-text-muted">
                      <span aria-hidden="true" className="h-px flex-1 bg-border" />
                      {label}
                      <span aria-hidden="true" className="h-px flex-1 bg-border" />
                    </div>,
                  );
                  idx += 1;
                  continue;
                }
                // A lazily loaded history page may start halfway through a turn.
                const hasTurnStart = startsUserTurn(timelineMessages[idx]);
                const userIdx = hasTurnStart ? idx : idx - 1;
                let endIdx = userIdx + 1;
                while (endIdx < timelineMessages.length
                  && !startsUserTurn(timelineMessages[endIdx]) && !isSessionForkDivider(timelineMessages[endIdx])) endIdx += 1;
                const endsAtFork = endIdx < timelineMessages.length && isSessionForkDivider(timelineMessages[endIdx]);
                const isLatestTurn = userIdx === lastTurnStartIdx;
                const isLiveTurn = !endsAtFork && (agentRunning || streamState.isStreaming) && isLatestTurn;
                const hasCompleteHistory = hasTurnStart || !hasEarlierMessages;
                const turnKey = getMessageKey(hasTurnStart ? userIdx : idx);
                if (hasTurnStart) rendered.push(renderMessage(userIdx));

                const turnMessages = timelineMessages.slice(userIdx + 1, endIdx);
                const retryOffset = turnMessages.findIndex((message) =>
                  message.role === "custom" && message.customType === AUTOMATIC_SUBAGENT_RETRY_TYPE);
                const retryIndex = retryOffset < 0 ? -1 : userIdx + 1 + retryOffset;
                const turnModel = turnMessages.find((message): message is AssistantMessage => message.role === "assistant" && Boolean(message.provider));
                const anchor = timelineMessages[userIdx];
                const turnWorkMode = anchor?.role === "user" ? anchor.turnWorkMode : undefined;
                const lastAssistantOffset = turnMessages.findLastIndex((message) => message.role === "assistant");
                const finalAssistantIdx = lastAssistantOffset === -1 ? -1 : userIdx + 1 + lastAssistantOffset;
                const repliedToLastInput = lastAssistantOffset > turnMessages.findLastIndex((message) => message.role === "user");
                const goalOutcome = goalOutcomeByAssistant.get(finalAssistantIdx);
                const isGoalTurn = turnWorkMode === "goal" || turnMessages.some(isGoalOutcomeMessage)
                  || (!hasTurnStart && isLatestTurn && data?.workMode === "goal" && (sessionGoal !== null || goalUnavailable));
                const canShowFinal = repliedToLastInput && (endsAtFork || !isGoalTurn || shouldShowSettledGoalFinal({
                  outcome: goalOutcome,
                  latest: isLatestTurn,
                  goalUnavailable,
                  goalStatus: sessionGoal?.status,
                }));
                if (turnModel || turnWorkMode) {
                  rendered.push(<TurnLabels
                    key={"turn-labels-" + turnKey}
                    message={turnModel}
                    modelNames={modelNames}
                    modeLabel={turnWorkMode ? t(`chat.turnMode.${turnWorkMode}`) : undefined}
                  />);
                }
                let processViews: ReactNode[] = [];
                let processBlocks: AssistantContentBlock[] = [];
                let processCommands = 0;
                let processFailed = false;
                let commandIndices = new Set<number>();
                let commandKey = "";
                const processEntryIds = new Set<string>();
                const processRefIndices = new Set<number>();
                const outputRefIndices = new Set<number>();
                const sections: TurnSection[] = [];
                const finalText: AssistantContentBlock[] = [];
                let turnDurationMs: number | undefined;
                const addSectionView = (process: boolean, key: string, view: ReactNode, indices: Iterable<number>) => {
                  const current = sections.at(-1);
                  const section = current?.process === process ? current
                    : { key, process, entryId: undefined, refIndices: new Set<number>(), views: [] };
                  if (section !== current) sections.push(section);
                  section.views.push(view);
                  for (const index of indices) {
                    const entryId = entryIds[index];
                    const refIndex = visibleRefIndexByMessage.get(index);
                    if (entryId && process) {
                      section.entryId ??= entryId;
                      processEntryIds.add(entryId);
                    }
                    if (refIndex === undefined) continue;
                    if (process) {
                      section.refIndices.add(refIndex);
                      processRefIndices.add(refIndex);
                    } else {
                      outputRefIndices.add(refIndex);
                    }
                  }
                };
                const flushProcess = (active = false) => {
                  if (processViews.length === 0) return;
                  addSectionView(true, commandKey,
                    <ProcessDetailsGroup
                      key={commandKey}
                      summary={activitySummary(processBlocks, processCommands, t)}
                      activeLabel={active ? phaseLabel(agentPhase, t) ?? t("chat.thinking") : undefined}
                      hasFailure={processFailed}
                      t={t}
                    >{processViews}</ProcessDetailsGroup>,
                    commandIndices,
                  );
                  processViews = [];
                  processBlocks = [];
                  processCommands = 0;
                  processFailed = false;
                  commandIndices = new Set();
                };
                for (let messageIdx = userIdx + 1; messageIdx < endIdx; messageIdx++) {
                  const message = timelineMessages[messageIdx];
                  if (message.role === "custom" && message.customType === TURN_TIMING_TYPE) {
                    turnDurationMs = readTurnDurationMs(message.details);
                    continue;
                  }
                  if (message.role === "toolResult" || isGoalOutcomeMessage(message)
                    || (message.role === "custom" && (message.customType === GOAL_CONTINUATION_TYPE
                      || message.customType === SUBAGENT_RESULTS_TYPE
                      || message.customType === AUTOMATIC_SUBAGENT_RETRY_TYPE))) continue;
                  const messageKey = getMessageKey(messageIdx);
                  if (message.role === "user") {
                    flushProcess();
                    addSectionView(false, "steering-" + messageKey, renderMessage(messageIdx), [messageIdx]);
                    continue;
                  }
                  if (message.role === "bashExecution") {
                    if (processViews.length === 0) commandKey = "commands-" + messageKey;
                    commandIndices.add(messageIdx);
                    processCommands++;
                    processFailed ||= message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0);
                    processViews.push(renderMessage(messageIdx, { attachRef: false, keyPrefix: "process-command" }));
                    continue;
                  }
                  if (message.role === "custom" && pairedSubagentNotifications.has(message)) continue;
                  if (message.role !== "assistant") {
                    if (message.role === "custom") {
                      flushProcess();
                      const deliveredImage = message.display !== false && Array.isArray(message.content)
                        && message.content.some((block) => block.type === "image");
                      addSectionView(!deliveredImage, "custom-" + messageKey, renderMessage(messageIdx, { attachRef: deliveredImage }), [messageIdx]);
                    }
                    continue;
                  }
                  const isStreamingMessage = streamState.isStreaming && messageIdx === messages.length;
                  const segments = getAssistantTimelineSegments(message, {
                    isStreaming: isStreamingMessage,
                    textMode: messageIdx === finalAssistantIdx && (canShowFinal || (isLiveTurn && repliedToLastInput)) ? "final" : "activity",
                    allowStreamingFinal: isLiveTurn,
                    showProgress: messageIdx >= retryIndex,
                    isVisibleToolResult: (block) => getDeliveredToolImages(toolResultsMap.get(block.toolCallId),
                      block.toolName, messageCwd, persistedSessionId ?? undefined).length > 0,
                    isProgressToolResult: (block) => block.toolName === "Agent"
                      && isSubagentToolDetails(toolResultsMap.get(block.toolCallId)?.details),
                  });
                  for (const segment of segments) {
                    const keyPrefix = segment.kind + "-" + segment.blockIndices[0];
                    const blocks = segment.blockIndices.map((index) => message.content[index]);
                    if (segment.kind !== "activity") {
                      const process = segment.kind === "progress";
                      if (!process && messageIdx === finalAssistantIdx) {
                        for (const index of segment.blockIndices) {
                          const block = message.content[index];
                          if (block.type === "text") finalText.push(block);
                        }
                      }
                      flushProcess();
                      addSectionView(process, keyPrefix + "-" + messageKey, renderMessage(messageIdx, {
                        attachRef: !process, keyPrefix, blockIndices: segment.blockIndices,
                        hideMetadata: true, showModel: false, showTimestamp: false,
                      }), [messageIdx]);
                      continue;
                    }
                    if (processViews.length === 0) commandKey = "commands-" + messageKey + "-" + segment.blockIndices[0];
                    processBlocks.push(...blocks);
                    processFailed ||= blocks.some((block) => block.type === "toolCall" && toolResultsMap.get(block.toolCallId)?.isError);
                    commandIndices.add(messageIdx);
                    processViews.push(renderMessage(messageIdx, { attachRef: false, keyPrefix, blockIndices: segment.blockIndices, hideMetadata: true, showModel: false, showTimestamp: false }));
                  }
                  if (getAssistantErrorMessage(message)) {
                    const terminal = messageIdx === finalAssistantIdx;
                    // An active attempt can show its error in place. Keep a final
                    // failure visible via the summary footer once the run ends.
                    if (terminal && !isLiveTurn) continue;
                    flushProcess();
                    addSectionView(true, "error-" + messageKey, renderMessage(messageIdx, {
                      attachRef: false, keyPrefix: "error", blockIndices: [], showModel: false, compactUsage: true,
                    }), [messageIdx]);
                  }
                }
                flushProcess(isLiveTurn);
                if (sections.length) {
                  rendered.push(<TurnActivity
                    key={"turn-activity-" + turnKey}
                    sections={sections}
                    live={isLiveTurn}
                    processEntryIds={[...processEntryIds]}
                    attachProcessRefs={(element, indices = processRefIndices) => {
                      for (const refIndex of indices) {
                        if (!outputRefIndices.has(refIndex)) messageRefs.current[refIndex] = element;
                      }
                    }}
                    t={t}
                  />);
                }
                const finalAssistant = timelineMessages[finalAssistantIdx];
                if (!isLiveTurn && finalAssistant?.role === "assistant") {
                  const stoppedWithoutAnswer = hasCompleteHistory && canShowFinal && stoppedWithoutFinalAnswer(finalAssistant);
                  const deliveredImage = stoppedWithoutAnswer && turnMessages.some((message) =>
                    message.role === "assistant" && message.content.some((block) =>
                      block.type === "toolCall" && getDeliveredToolImages(
                        toolResultsMap.get(block.toolCallId), block.toolName, messageCwd, persistedSessionId ?? undefined,
                      ).length > 0,
                    ),
                  );
                  if (stoppedWithoutAnswer && !deliveredImage) {
                    rendered.push(
                      <p key={`no-final-answer-${entryIds[finalAssistantIdx] ?? finalAssistantIdx}`} role="status" className="my-3 border-l-2 border-border pl-3 text-[13px] text-text-muted">
                        {t("chat.stoppedWithoutFinalAnswer")}
                      </p>,
                    );
                  }
                  const canForkReply = canShowFinal && hasFinalAssistantStop(finalAssistant)
                    && (finalText.length > 0 || deliveredImage || finalAssistant.content.some((block) => block.type === "image"));
                  const turnContent = turnMessages.flatMap((message) => message.role === "assistant" ? message.content : []);
                  const imageCharges = hasCompleteHistory
                    ? entryIds.slice(userIdx + 1, endIdx).flatMap((entryId) => imageBillingByAnchor.get(entryId) ?? []) : [];
                  const turnImageBilling = imageCharges.length === 0 ? undefined : imageCharges.reduce((total, charge) => ({
                    imageCount: total.imageCount + charge.imageCount,
                    chargeCount: total.chargeCount + charge.chargeCount,
                    matchedChargeCount: total.matchedChargeCount + charge.matchedChargeCount,
                    actualCost: total.actualCost + charge.actualCost,
                  }), { imageCount: 0, chargeCount: 0, matchedChargeCount: 0, actualCost: 0 });
                  rendered.push(renderMessage(finalAssistantIdx, {
                    keyPrefix: "turn-summary",
                    canForkReply,
                    attachRef: false,
                    blockIndices: [],
                    // Copy only the report visible outside the operation record.
                    messageOverride: { ...finalAssistant, content: finalText, usage: hasCompleteHistory ? finalAssistant.usage : undefined },
                    showModel: false,
                    usageOverride: hasCompleteHistory ? aggregateTurnUsage(timelineMessages, userIdx + 1, finalAssistantIdx) : undefined,
                    actualCost: undefined,
                    relayBilling: hasCompleteHistory
                      ? summarizeTurnRelayBilling(timelineMessages, entryIds, userIdx + 1, finalAssistantIdx, relayActualCosts.costs)
                      : undefined,
                    imageBilling: turnImageBilling,
                    writtenFiles: hasCompleteHistory ? extractTurnWrittenFiles(turnContent, toolResultsMap, messageCwd) : undefined,
                  }));
                }
                if (!isLiveTurn && hasCompleteHistory && turnDurationMs !== undefined) {
                  rendered.push(
                    <div key={`turn-duration-${entryIds[userIdx] ?? userIdx}`} className="mb-3 mt-1 text-xs tabular-nums text-text-dim">
                      {t("chat.turnElapsed", { duration: formatRunDuration(turnDurationMs, t) })}
                    </div>,
                  );
                }
                idx = endIdx;
              }
              return (
                <>
                  {hasEarlierMessages && (
                     <div ref={sentinelRef} className="py-3 text-center text-xs text-text-muted">
                       {t("chat.loadEarlier")}
                    </div>
                  )}
                  {rendered}
                </>
              );
            })()}
            {bashRunning && !pendingBash && (
              <div className="py-2 text-[13px] text-text-muted">
                 <span className="animate-[pulse_1.5s_infinite]">{t("chat.runningCommand")}</span>
              </div>
            )}

            {pendingBash && (
              <ProcessDetailsGroup
                summary={t("chat.activityCommandSummary", { count: 1 })}
                activeLabel={t("chat.runningCommand")}
                t={t}
              >
                <MessageView
                  message={{
                    role: "bashExecution",
                    command: pendingBash.command,
                    output: "",
                    excludeFromContext: pendingBash.excludeFromContext,
                  } as BashExecutionMessage}
                  sessionId={session?.id ?? sessionIdRef.current ?? undefined}
                />
              </ProcessDetailsGroup>
            )}

            <div ref={promptAnchorSpacerRef} aria-hidden="true" />
            </div>
          </div>
        </div>
        {showMinimapRail && (pendingScrollRestore ? (
          <div aria-hidden="true" style={{ flex: `0 0 ${CHAT_MINIMAP_WIDTH}px` }} />
        ) : (
          <ChatMinimap
            messages={messages}
            entryIds={entryIds}
            streamingMessage={streamState.streamingMessage}
            scrollContainer={scrollContainerRef}
            messageRefs={messageRefs}
          />
        ))}
        </>}
      </div>

      {quoteSelectionEnabled && quotedSelection && createPortal(
        <div
          ref={quotePopoverRef}
          role={quoteInputOpen ? "dialog" : "toolbar"}
          aria-label={t(quoteInputOpen ? "chat.newQuoteChat" : "chat.askSelection")}
          style={{
            position: "fixed",
            top: quotedSelection.top,
            left: quotedSelection.left,
            zIndex: 130,
            display: "flex",
            flexWrap: "wrap",
            gap: 3,
            width: quoteInputOpen ? "min(420px, calc(100vw - 16px))" : undefined,
            maxWidth: "calc(100vw - 16px)",
            maxHeight: "calc(var(--app-viewport-height, 100dvh) - 16px)",
            overflowY: "auto",
            padding: quoteInputOpen ? 12 : 3,
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg)",
            boxShadow: "0 2px 10px rgba(0,0,0,0.12)",
          }}
        >
          {quoteInputOpen ? (
            <fieldset
              disabled={quoteSubmitting}
              aria-busy={quoteSubmitting}
              style={{ width: "100%", minWidth: 0, margin: 0, padding: 0, border: "none", display: "flex", flexDirection: "column", gap: 10 }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600 }}>{t("chat.askInNewChat")}</span>
                <button type="button" className="file-viewer-icon-button" title={t("i18n.close")} aria-label={t("i18n.close")} disabled={quoteSubmitting} onClick={closeQuotedSelection} style={{ border: "none" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
                </button>
              </div>
              <ChatInput
                ref={quoteChatInputRef}
                compact
                onSend={askSelectionInNewChat}
                onAbort={closeQuotedSelection}
                isStreaming={false}
              />
              {quoteError && <div role="alert" style={{ color: "#dc2626", fontSize: 12, overflowWrap: "anywhere" }}>{quoteError}</div>}
            </fieldset>
          ) : <>
          <button
            type="button"
            className="file-viewer-icon-button"
            title={t("chat.askInCurrent")}
            aria-label={t("chat.askInCurrent")}
            onPointerDown={(event) => event.preventDefault()}
            onClick={askSelectionHere}
            style={{ width: "auto", height: 35, flex: "0 0 auto", gap: 5, padding: "0 10px", border: "none", fontSize: 12, fontWeight: 500 }}
          >
            <span aria-hidden="true" style={{ fontSize: 15 }}>@</span>
            <span>{t("chat.askInCurrent")}</span>
          </button>
          {onAskInNewChat && quotedSelection.sourceEntryId && !sessionBusy && (
            <button
              type="button"
              className="file-viewer-icon-button"
              title={t("chat.askInNewChat")}
              aria-label={t("chat.askInNewChat")}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => { setQuoteInputOpen(true); window.getSelection()?.removeAllRanges(); }}
              style={{ width: "auto", height: 35, flex: "0 0 auto", gap: 5, padding: "0 10px", border: "none", fontSize: 12, fontWeight: 500 }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 3v12M18 9a9 9 0 0 1-9 9" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" />
              </svg>
              <span>{t("chat.askInNewChat")}</span>
            </button>
          )}
          </>}
        </div>,
        document.body,
      )}

      <div className="relative shrink-0">
        {agentRunning && !bashRunning && (
          <div style={{ paddingInlineEnd: showMinimapRail ? CHAT_MINIMAP_WIDTH : 0 }}>
            <div className="chat-column-inset">
              <AgentActivityCard
                phase={agentPhase}
                streamingStage={streamState.streamingMessage?.content.at(-1)?.type}
                startedAt={activeRunStartedAt}
                lastActivityAt={runLastActivityAt}
                waitingForInput={Boolean(extensionDialog || extensionCustomUi)}
                compacting={isCompacting}
                t={t}
              />
            </div>
          </div>
        )}
        {!previewOnly && (
          <div style={{ paddingInlineEnd: showMinimapRail ? CHAT_MINIMAP_WIDTH : 0 }}>
            <div className="chat-column-inset">
              {isEmptyNew && <NewSessionWelcome isMobile={isMobile} chatInputRef={chatInputRef} />}
              {goalsEnabled && (goalLoadError ? (
                <div className="chat-reading-column mb-2 flex flex-wrap items-center gap-2 text-xs text-text-muted" role="alert">
                  {t("chat.goal.loadFailed")}
                  <button type="button" className="underline" onClick={() => void loadGoal()}>{t("chat.goal.retry")}</button>
                </div>
              ) : (
                <SessionGoalTracker
                  goal={goalCardClosed ? null : sessionGoal}
                  showCreate={composerWorkMode === "goal"}
                  disabled={goalLoading}
                  running={sessionBusy}
                  runningInGoalMode={agentRunning && data?.workMode === "goal"}
                  onDismiss={endedGoal && !goalCardClosed ? dismissGoalCard : undefined}
                  onChange={handleGoalChange}
                />
              ))}
              {chatInputElement}
            </div>
          </div>
        )}
        <ExtensionStatusBar statuses={extensionStatuses} widgets={extensionWidgets} />
      </div>
      {isEmptyNew && <div className="min-h-0 flex-1" />}
    </div>
  );
}

// Toast 整体高度上限；文本区高度上限 = 整体上限 - 上下 padding(14*2) - 上下边框(1*2)
const NOTICE_MAX_HEIGHT_PX = 500;
const NOTICE_TEXT_MAX_HEIGHT_PX = NOTICE_MAX_HEIGHT_PX - 30;

function NoticeShelf({ notices, floating = false, onPauseChange }: { notices: NoticeItem[]; floating?: boolean; onPauseChange?: (id: string | null) => void }) {
  if (notices.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        // Right-anchored: every toast's right edge aligns here, widths extend leftward
        alignItems: "flex-end",
        marginBottom: floating ? 0 : 10,
      }}
    >
      {notices.map((notice, index) => {
        const color = notice.type === "error"
          ? "#ef4444"
          : notice.type === "warning"
            ? "#d97706"
            : notice.type === "success"
              ? "#10b981"
              : "var(--accent)";
        return (
          <div
            key={notice.id}
            className="notice-shelf-item"
            onMouseEnter={() => onPauseChange?.(notice.id)}
            onMouseLeave={(event) => {
              if (!event.currentTarget.contains(document.activeElement)) onPauseChange?.(null);
            }}
            onFocus={() => onPauseChange?.(notice.id)}
            onBlur={(event) => {
              if (!event.currentTarget.matches(":hover")) onPauseChange?.(null);
            }}
            style={{
              display: "flex",
              // Top-align children so the type dot sits by the first line on multi-line toasts
              alignItems: "flex-start",
              gap: 10,
              minHeight: 60,
              height: "auto",
              // 整体高度上限：超出后由文本区内部滚动承担（见下方 span 的 overflowY），
              // 容器自身保持 hidden，小圆点固定在顶部不随文本滚动
              maxHeight: NOTICE_MAX_HEIGHT_PX,
              // The floating wrapper is pointerEvents:"none" (click-through by design),
              // so the toast itself must opt back into interactivity or hover events never reach it
              pointerEvents: "auto",
              marginBottom: index === notices.length - 1 ? 0 : 6,
              overflow: "hidden",
              borderRadius: 14,
              border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              width: "fit-content",
              maxWidth: "min(100%, 620px)",
              boxShadow: floating
                ? "0 1px 2px rgba(15,23,42,0.05), 0 10px 28px -14px rgba(15,23,42,0.24)"
                : "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10)",
              fontSize: 14,
              lineHeight: 1.5,
              transformOrigin: "top right",
              // Use backwards fill for the entrance animation so height styles return to
              // inline styles once it finishes; otherwise the keyframe's fixed 60px would
              // stick around in fill mode and permanently clamp the expanded toast
              animation: notice.exiting
                ? "notice-shelf-out 0.18s ease-in forwards"
                : "notice-shelf-in 0.18s ease-out backwards",
              padding: "0 12px",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: color,
                flexShrink: 0,
                // Align with the optical center of the first text line: 14px vertical
                // padding + (21px line box - 7px dot) / 2
                marginTop: 21,
              }}
            />
            {/* Full text by default: pre-line preserves \n (nowrap/normal collapse
                newlines into spaces) and long lines wrap instead of truncating;
                content taller than the cap scrolls inside the text area */}
            <span
              tabIndex={0}
              style={{ padding: "14px 0", minWidth: 0, maxWidth: "100%", maxHeight: NOTICE_TEXT_MAX_HEIGHT_PX, overflowY: "auto", scrollbarWidth: "thin", whiteSpace: "pre-line", wordBreak: "break-word" }}
            >
              {notice.message}
            </span>
          </div>
        );
      })}
    </div>
  );
}

type ExtensionDialogRequest = Exclude<BlockingExtensionUiRequest, { method: "custom" }>;
type PluginDialogRequest = Exclude<ExtensionDialogRequest, { method: "question" }>;

function getExtensionDialogSummary(request: PluginDialogRequest): string | undefined {
  if (request.method === "select" && request.options.length > 0) return request.options[0];
  if (request.method === "confirm") {
    const firstLine = request.message.split("\n").find((line) => line.trim());
    return firstLine?.trim();
  }
  return undefined;
}

function ExtensionDialog({
  request,
  onRespond,
}: {
  request: ExtensionDialogRequest;
  onRespond: (request: ExtensionDialogRequest, response: ExtensionUiAnswer) => Promise<boolean>;
}) {
  return request.method === "question"
    ? <UserQuestionDialog request={request} onRespond={(response) => onRespond(request, response)} />
    : <PluginExtensionDialog request={request} onRespond={onRespond} />;
}

function PluginExtensionDialog({
  request,
  onRespond,
}: {
  request: PluginDialogRequest;
  onRespond: (request: PluginDialogRequest, response: ExtensionUiAnswer) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(request.method === "editor" ? request.prefill ?? "" : "");
  const [collapsed, setCollapsed] = useState(false);
  const [rememberForRun, setRememberForRun] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const canRemember = request.method === "confirm" && request.approvalScope === "computer-use-exact";
  const focusFirstOption = useCallback((element: HTMLDivElement | null) => element?.focus(), []);
  const summary = getExtensionDialogSummary(request);
  const remainingSeconds = request.expiresAt === undefined
    ? null
    : Math.max(0, Math.ceil((request.expiresAt - now) / 1000));

  useEffect(() => {
    if (request.expiresAt === undefined) return;
    // The server closes expired requests via extension_ui_closed.
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [request.expiresAt]);

  const countdown = remainingSeconds !== null && (
    <span style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap", flexShrink: 0 }}>
      {t("chat.extensionExpiresIn", { seconds: remainingSeconds })}
    </span>
  );

  const submitValue = () => {
    if (request.method === "confirm") {
      onRespond(request, { confirmed: true, ...(canRemember && rememberForRun ? { rememberForRun: true } : {}) });
    } else {
      onRespond(request, { value });
    }
  };

  return (
    <div
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        onRespond(request, { cancelled: true });
      }}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 90,
        display: "flex",
        alignItems: collapsed ? "flex-start" : "center",
        justifyContent: "center",
        padding: 20,
        pointerEvents: "none",
      }}
    >
      {collapsed ? (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-expanded={false}
          style={{
            pointerEvents: "auto",
            display: "flex",
            alignItems: "center",
            gap: 10,
            maxWidth: "min(560px, 100%)",
            width: "100%",
            padding: "10px 12px",
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg)",
            boxShadow: "0 12px 32px rgba(0,0,0,0.18)",
            color: "var(--text)",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 650, color: "var(--accent)", flexShrink: 0 }}>
            {t("chat.extensionPending")}
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
            {request.title}
          </span>
          {summary && (
            <span style={{ fontSize: 12, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "34%", flexShrink: 1 }}>
              {summary}
            </span>
          )}
          {countdown}
          <span style={{ fontSize: 12, color: "var(--text-muted)", flexShrink: 0 }}>
            {t("chat.extensionExpand")}
          </span>
        </button>
      ) : (
      <div
        role="dialog"
        aria-label={request.title}
        style={{
          pointerEvents: "auto",
          width: "min(560px, 100%)",
          maxHeight: "min(760px, 100%)",
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
        }}
      >
        <div style={{ flexShrink: 0, display: "flex", alignItems: "flex-start", gap: 8, padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 650 }}>{request.title}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 3, color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
              <span>{t("chat.extensionRequest")}</span>
              {countdown}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            aria-expanded={true}
            title={t("chat.extensionCollapse")}
            aria-label={t("chat.extensionCollapse")}
            style={{
              display: "grid",
              placeItems: "center",
              width: 28,
              height: 28,
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="2 3.5 5 6.5 8 3.5" />
            </svg>
          </button>
        </div>

        <div
          style={{
            padding: 14,
            flex: "1 1 auto", minHeight: 0, overflowY: "auto",
          }}
        >
          {request.method === "confirm" && (
            canRemember
              ? <pre style={{ margin: 0, fontSize: 12, lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{request.message}</pre>
              : <MarkdownBody>{request.message}</MarkdownBody>
          )}
          {request.method === "select" && (
            <div
              onKeyDown={(event) => {
                if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(event.key)) return;
                const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-extension-option]"));
                const index = buttons.indexOf(event.target as HTMLElement);
                if (index < 0) return;
                event.preventDefault();
                const next = event.key === "Home" ? 0
                  : event.key === "End" ? buttons.length - 1
                  : (index + (event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
                buttons[next].focus({ preventScroll: true });
                buttons[next].scrollIntoView({ block: "nearest" });
              }}
              style={{ display: "grid", gap: 8 }}
            >
              {request.options.map((option, index) => (
                <div
                  key={option}
                  role="button"
                  tabIndex={0}
                  data-extension-option
                  aria-label={option}
                  ref={index === 0 ? focusFirstOption : undefined}
                  onClick={() => onRespond(request, { value: option })}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    onRespond(request, { value: option });
                  }}
                  style={{
                    width: "100%",
                    padding: "9px 10px",
                    borderRadius: 7,
                    border: "1px solid var(--border)",
                    background: "var(--bg-panel)",
                    color: "var(--text)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 13,
                    overflowWrap: "anywhere",
                  }}
                >
                  <div inert>
                    <MarkdownBody>{option}</MarkdownBody>
                  </div>
                </div>
              ))}
            </div>
          )}
          {request.method === "input" && (
            <input
              autoFocus
              value={value}
              placeholder={request.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) submitValue();
              }}
              style={{
                width: "100%",
                padding: "9px 10px",
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                fontSize: 13,
              }}
            />
          )}
          {request.method === "editor" && (
            <textarea
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !e.nativeEvent.isComposing) submitValue();
              }}
              style={{
                width: "100%",
                minHeight: 220,
                padding: 10,
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                resize: "vertical",
                fontSize: 13,
                lineHeight: 1.55,
                fontFamily: "var(--font-mono)",
              }}
            />
          )}
        </div>

        {canRemember && (
          <label style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 14px",
            borderTop: "1px solid var(--border)",
            color: "var(--text-muted)",
            fontSize: 12,
            cursor: "pointer",
          }}>
            <input
              type="checkbox"
              checked={rememberForRun}
              onChange={(event) => setRememberForRun(event.target.checked)}
              style={{ flexShrink: 0, accentColor: "var(--accent)" }}
            />
            {t("chat.extensionRememberExactForRun")}
          </label>
        )}
        <div style={{ flexShrink: 0, display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          <button
            autoFocus={request.method === "confirm" || (request.method === "select" && request.options.length === 0)}
            onClick={() => onRespond(request, { cancelled: true })}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
             {t("chat.cancel")}
          </button>
          {request.method === "confirm" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "var(--accent-contrast)",
                cursor: "pointer",
              }}
            >
               {t("chat.confirm")}
            </button>
          ) : request.method !== "select" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "var(--accent-contrast)",
                cursor: "pointer",
              }}
            >
               {t("chat.submit")}
            </button>
          ) : null}
        </div>
      </div>
      )}
    </div>
  );
}

type ExtensionCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;

function ExtensionCustomPanel({
  request,
  onInput,
}: {
  request: ExtensionCustomRequest;
  onInput: (request: ExtensionCustomRequest, data: string) => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const [collapsed, setCollapsed] = useState(false);
  const displayLines = normalizeCustomPanelLines(request.lines);
  const summary = displayLines.find((line) => line.trim())?.trim();

  useEffect(() => {
    if (!collapsed) inputRef.current?.focus();
  }, [collapsed]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 95,
        display: "flex",
        alignItems: collapsed ? "flex-start" : "center",
        justifyContent: "center",
        padding: 20,
        pointerEvents: "none",
      }}
    >
      {collapsed ? (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-expanded={false}
          style={{
            pointerEvents: "auto",
            display: "flex",
            alignItems: "center",
            gap: 10,
            maxWidth: "min(920px, 100%)",
            width: "100%",
            padding: "10px 12px",
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg)",
            boxShadow: "0 12px 32px rgba(0,0,0,0.18)",
            color: "var(--text)",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 650, color: "var(--accent)", flexShrink: 0 }}>
            {t("chat.extensionPending")}
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
            {t("chat.extensionPanel")}
          </span>
          {summary && (
            <span style={{ fontSize: 12, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "34%", flexShrink: 1 }}>
              {summary}
            </span>
          )}
          <span style={{ fontSize: 12, color: "var(--text-muted)", flexShrink: 0 }}>
            {t("chat.extensionExpand")}
          </span>
        </button>
      ) : (
      <div
        role="dialog"
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest("button")) inputRef.current?.focus();
        }}
        style={{
          pointerEvents: "auto",
          position: "relative",
          width: "min(920px, 100%)",
          maxHeight: "min(760px, 100%)",
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
          outline: "none",
        }}
      >
        <textarea
          ref={inputRef}
           aria-label={t("chat.extensionInput")}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const data = toTerminalKeyData(event);
            if (!data) return;
            event.preventDefault();
            event.stopPropagation();
            onInput(request, data);
          }}
          onInput={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const text = event.currentTarget.value;
            event.currentTarget.value = "";
            if (text) onInput(request, text);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            const input = event.currentTarget;
            queueMicrotask(() => {
              const text = input.value;
              input.value = "";
              if (text) onInput(request, text);
            });
          }}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text");
            if (text) onInput(request, asBracketedPaste(text));
          }}
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            padding: 0,
            border: 0,
            opacity: 0,
            pointerEvents: "none",
          }}
        />
        <div style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
           <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 650 }}>{t("chat.extensionPanel")}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              aria-expanded={true}
              title={t("chat.extensionCollapse")}
              aria-label={t("chat.extensionCollapse")}
              style={{
                display: "grid",
                placeItems: "center",
                width: 28,
                height: 28,
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text-muted)",
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>
            <button
              onClick={() => onInput(request, "\x03")}
              style={{
                padding: "5px 9px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
               {t("chat.close")}
            </button>
          </div>
        </div>
        <pre
          style={{
            margin: 0,
            padding: 14,
            minHeight: 0,
            overflow: "auto",
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            lineHeight: 1.45,
            whiteSpace: "pre",
          }}
        >
          <AnsiText text={displayLines.join("\n")} />
        </pre>
      </div>
      )}
    </div>
  );
}
