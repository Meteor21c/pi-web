import type { AgentMessage, AssistantContentBlock, AssistantMessage, ThinkingContent, ToolCallContent } from "./types";

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

/** Keep stage text in order and retain stored indices for deferred thinking. */
export function getAssistantTimelineSegments(
  message: AssistantMessage,
  options: DisplayOptions & { isVisibleToolResult?: (block: ToolCallContent) => boolean } = {},
): AssistantTimelineSegment[] {
  const segments: AssistantTimelineSegment[] = [];
  message.content.forEach((block, index) => {
    if (isEmptyThinkingBlock(block, options) || (block.type === "text" && !block.text.trim())) return;
    const kind = block.type === "text" || block.type === "image"
      || (block.type === "toolCall" && options.isVisibleToolResult?.(block))
      ? "output" : "activity";
    const previous = segments.at(-1);
    if (previous?.kind === kind) previous.blockIndices.push(index);
    else segments.push({ kind, blockIndices: [index] });
  });
  return segments;
}
