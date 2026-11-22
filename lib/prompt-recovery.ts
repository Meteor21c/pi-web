import type { AgentMessage, UserMessage } from "@/lib/types";

export function reconcileDeliveredUserMessage(
  messages: readonly AgentMessage[],
  optimistic: UserMessage | null,
  delivered: UserMessage,
): AgentMessage[] {
  const index = optimistic ? messages.lastIndexOf(optimistic) : -1;
  if (index === -1) return [...messages, delivered];
  return [...messages.slice(0, index), ...messages.slice(index + 1), delivered];
}
