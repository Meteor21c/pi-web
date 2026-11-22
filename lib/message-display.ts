import type { AgentMessage, AssistantContentBlock, AssistantMessage, ThinkingContent, ToolCallContent } from "./types";
import type { SessionGoal } from "./session-goal-types";

interface DisplayOptions {
  isStreaming?: boolean;
}

export function getThinkingPreview(thinking: string): string {
  return thinking.trimStart().match(/^[^\r\n]{0,240}/u)?.[0].trimEnd() ?? "";
}

export function isMessageGroupAnchor(message: { role?: AgentMessage["role"]; customType?: string }): boolean {
  return message.role === "user"
    || (message.role === "custom" && message.customType === "compaction");
}

export function isEmptyThinkingBlock(block: AssistantContentBlock, options: DisplayOptions = {}): block is ThinkingContent {
  return block.type === "thinking" && !block.deferred && !options.isStreaming && block.thinking.trim() === "";
}

export function getDisplayableAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): AssistantContentBlock[] {
  return (message.content ?? []).filter((block) => !isEmptyThinkingBlock(block, options));
}

export function getAssistantErrorMessage(
  message: AssistantMessage,
  options: DisplayOptions = {},
): string | null {
  if (options.isStreaming || message.stopReason !== "error") return null;
  return message.errorMessage?.trim() || "Unknown provider error";
}

export function stoppedWithoutFinalAnswer(message: AssistantMessage): boolean {
  return message.stopReason === "stop" && message.content.every((block) =>
    block.type === "thinking" || (block.type === "text" && !block.text.trim()),
  );
}

/** Errors produced when a Responses SSE connection ends mid-event. */
export function isTruncatedResponseError(message: string | null): boolean {
  if (!message) return false;
  return /Unexpected end of JSON input|Responses stream ended (?:before a terminal response event|without a stop reason)/i.test(message);
}

function isFinalAnswerBlock(block: AssistantContentBlock): boolean {
  return block.type === "text" || block.type === "image";
}

export function splitFinalAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): { answerBlocks: AssistantContentBlock[]; processBlocks: AssistantContentBlock[] } {
  const blocks = getDisplayableAssistantBlocks(message, options);
  const lastProcessIndex = blocks.findLastIndex((block) => !isFinalAnswerBlock(block));
  if (lastProcessIndex === -1) {
    return { answerBlocks: blocks, processBlocks: [] };
  }
  return {
    answerBlocks: blocks.slice(lastProcessIndex + 1),
    processBlocks: blocks.slice(0, lastProcessIndex + 1),
  };
}

export function countToolCallBlocks(blocks: AssistantContentBlock[]): number {
  return blocks.filter((block): block is ToolCallContent => block.type === "toolCall").length;
}

export interface AssistantTimelineSegment {
  kind: "activity" | "output";
  blockIndices: number[];
}

type GoalOutcomeStatus = "completed" | "paused" | "blocked";

export function readGoalOutcomeStatus(details: unknown): GoalOutcomeStatus | undefined {
  if (!details || typeof details !== "object" || !("status" in details)) return;
  const { status } = details;
  if (status === "completed" || status === "paused" || status === "blocked") return status;
}

/** A turn's persisted outcome takes precedence over later changes to the tracker. */
export function shouldShowSettledGoalFinal(options: {
  outcome?: GoalOutcomeStatus;
  latest: boolean;
  goalUnavailable?: boolean;
  goalStatus?: SessionGoal["status"];
}): boolean {
  if (options.outcome) return options.outcome === "completed";
  // Legacy turns may have no outcome entry. Wait for current goal state before
  // treating the latest turn as legacy, including while an active goal settles.
  return !options.latest || (!options.goalUnavailable && (!options.goalStatus || options.goalStatus === "completed"));
}

// A relay can surface malformed DeepSeek tool markup as ordinary text. Keep
// it available in the process details without presenting it as a final reply.
const DSML_TOOL_MARKUP = /<\/?\s*[|｜]\s*DSML\s*[|｜]\s*(?:function_calls?|calls?|invoke|parameter)\b/i;

/** Keep stage text in order and retain stored indices for deferred thinking. */
export function getAssistantTimelineSegments(
  message: AssistantMessage,
  options: DisplayOptions & {
    goalText?: "activity" | "final";
    isVisibleToolResult?: (block: ToolCallContent) => boolean;
  } = {},
): AssistantTimelineSegment[] {
  const finalTextFrom = options.goalText === "final" && !options.isStreaming && message.stopReason === "stop"
    ? message.content.findLastIndex((block) =>
        !isFinalAnswerBlock(block) && !isEmptyThinkingBlock(block, options),
      ) + 1
    : message.content.length;
  const segments: AssistantTimelineSegment[] = [];
  message.content.forEach((block, index) => {
    if (isEmptyThinkingBlock(block, options) || (block.type === "text" && !block.text.trim())) return;
    const isVisibleText = block.type === "text" && (
      options.goalText === undefined || (index >= finalTextFrom && !DSML_TOOL_MARKUP.test(block.text))
    );
    const kind = isVisibleText || block.type === "image"
      || (block.type === "toolCall" && options.isVisibleToolResult?.(block))
      ? "output" : "activity";
    const previous = segments.at(-1);
    if (previous?.kind === kind) previous.blockIndices.push(index);
    else segments.push({ kind, blockIndices: [index] });
  });
  return segments;
}
