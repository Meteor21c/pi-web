import { relayImageModelAlias, relayImageProviderName } from "./relay-image-generation";
import { readRelayGroups, type RelayGroupMetadata } from "./relay-group-store";
import type { SessionEntry, ToolResultMessage } from "./types";

/** A private session entry used to remember successful relay image requests. */
export const RELAY_IMAGE_BILLING_TYPE = "magent:image-billing";

export interface RelayImageBillingData {
  version: 1;
  toolCallId: string;
  /** The final assistant entry for the user request that produced this image. */
  anchorEntryId: string;
  providerId: string;
  /** The remote model id used by the relay (not the local pi-image-gen alias). */
  modelId: string;
  modelAlias: string;
  imageCount: number;
  completedAt: number;
}

export interface RelayImageBillingEntry {
  entryId: string;
  data: RelayImageBillingData;
}

export interface RelayImageBillingCandidate {
  toolCallId: string;
  providerId: string;
  modelId: string;
  modelAlias: string;
  imageCount: number;
  completedAt: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  return undefined;
}

function providerNameWithoutSuffix(value: string): string {
  return value.trim().replace(/\s+\(custom\)$/i, "");
}

function imageModelForResult(
  providerLabel: string,
  requestedModel: string,
  groups: readonly RelayGroupMetadata[],
): { group: RelayGroupMetadata; modelId: string } | undefined {
  const providerName = providerNameWithoutSuffix(providerLabel);
  const group = groups.find((candidate) => relayImageProviderName(candidate.providerId) === providerName);
  if (!group) return undefined;
  const modelIds = group.imageModels ?? [];
  const modelId = modelIds.find((id) => relayImageModelAlias(group.providerId, id) === requestedModel)
    ?? modelIds.find((id) => id === requestedModel);
  return modelId ? { group, modelId } : undefined;
}

/**
 * Read the sanitized result returned by pi-image-gen and turn it into a relay
 * billing candidate. The extension intentionally does not expose credentials,
 * prompts, or image paths here; only the provider/model identity and count are
 * retained for matching the upstream usage ledger.
 */
export function parseRelayImageBillingCandidate(
  entry: SessionEntry,
  groups: readonly RelayGroupMetadata[] = readRelayGroups(),
): RelayImageBillingCandidate | null {
  if (entry.type !== "message" || entry.message.role !== "toolResult") return null;
  const message = entry.message as ToolResultMessage;
  if (message.toolName !== "image_generate" || message.isError) return null;
  const details = asRecord(message.details);
  if (!details || typeof details.model !== "string" || typeof details.provider !== "string") return null;
  const detailImageCount = Array.isArray(details.images) ? details.images.length : 0;
  const contentImageCount = Array.isArray(message.content)
    ? message.content.filter((block) => block.type === "image").length
    : 0;
  const imageCount = Math.max(detailImageCount, contentImageCount);
  if (imageCount === 0) return null;
  const resolved = imageModelForResult(details.provider, details.model, groups);
  if (!resolved) return null;
  const completedAt = Date.parse(entry.timestamp);
  if (!Number.isFinite(completedAt)) return null;
  return {
    toolCallId: message.toolCallId,
    providerId: resolved.group.providerId,
    modelId: resolved.modelId,
    modelAlias: details.model,
    imageCount,
    completedAt,
  };
}

function parseBillingData(value: unknown): RelayImageBillingData | null {
  const record = asRecord(value);
  if (!record || record.version !== 1) return null;
  if (typeof record.toolCallId !== "string" || !record.toolCallId.trim()) return null;
  if (typeof record.anchorEntryId !== "string" || !record.anchorEntryId.trim()) return null;
  if (typeof record.providerId !== "string" || !record.providerId.trim()) return null;
  if (typeof record.modelId !== "string" || !record.modelId.trim()) return null;
  if (typeof record.modelAlias !== "string" || !record.modelAlias.trim()) return null;
  const imageCount = positiveInteger(record.imageCount);
  const completedAt = typeof record.completedAt === "number" && Number.isFinite(record.completedAt)
    ? record.completedAt
    : undefined;
  if (imageCount === undefined || completedAt === undefined) return null;
  return {
    version: 1,
    toolCallId: record.toolCallId.trim(),
    anchorEntryId: record.anchorEntryId.trim(),
    providerId: record.providerId.trim(),
    modelId: record.modelId.trim(),
    modelAlias: record.modelAlias.trim(),
    imageCount,
    completedAt,
  };
}

export function readRelayImageBillingEntries(entries: readonly SessionEntry[]): RelayImageBillingEntry[] {
  return entries.flatMap((entry) => {
    if (entry.type !== "custom" || entry.customType !== RELAY_IMAGE_BILLING_TYPE) return [];
    const data = parseBillingData(entry.data);
    return data ? [{ entryId: entry.id, data }] : [];
  });
}

function nearestAssistantEntryId(entry: SessionEntry, byId: Map<string, SessionEntry>): string | undefined {
  let parentId: string | null = entry.parentId;
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) return undefined;
    if (parent.type === "message" && parent.message.role === "assistant") return parent.id;
    parentId = parent.parentId;
  }
  return undefined;
}

function isTurnBoundary(entry: SessionEntry): boolean {
  return (entry.type === "message" && entry.message.role === "user")
    || (entry.type === "custom" && entry.customType === "compaction");
}

function parentChainIncludes(entry: SessionEntry, ancestorId: string, byId: Map<string, SessionEntry>): boolean {
  let parentId = entry.parentId;
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId)) {
    if (parentId === ancestorId) return true;
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    parentId = parent.parentId;
  }
  return false;
}

function assistantHasFinalContent(entry: SessionEntry): boolean {
  if (entry.type !== "message" || entry.message.role !== "assistant") return false;
  // The SDK type currently declares assistant content as blocks only, while
  // older persisted sessions can still contain a flat string. Keep the
  // compatibility branch without asking TypeScript to narrow an impossible
  // union member.
  const content: unknown = entry.message.content;
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((block: unknown) => {
    if (!block || typeof block !== "object") return false;
    const record = block as Record<string, unknown>;
    if (record.type === "image") return true;
    return record.type === "text" && typeof record.text === "string" && record.text.trim().length > 0;
  });
}

/**
 * An image tool result is normally followed by the assistant's final answer.
 * The nearest assistant *ancestor* is the tool-calling step, which lives in
 * the collapsed process section and would make the image charge disappear
 * from the visible final-answer footer.  Anchor to the last assistant entry
 * in the same user turn instead, falling back to the ancestor for an
 * interrupted/incomplete turn.
 */
function finalAssistantEntryId(
  entry: SessionEntry,
  entries: readonly SessionEntry[],
  byId: Map<string, SessionEntry>,
): string | undefined {
  const index = entries.findIndex((candidate) => candidate.id === entry.id);
  if (index >= 0) {
    let firstAssistant: string | undefined;
    let descendantAnswer: string | undefined;
    for (let next = index + 1; next < entries.length; next += 1) {
      const following = entries[next];
      if (isTurnBoundary(following)) break;
      if (following.type === "message" && following.message.role === "assistant") {
        firstAssistant ??= following.id;
        if (assistantHasFinalContent(following) && parentChainIncludes(following, entry.id, byId)) {
          descendantAnswer = following.id;
          break;
        }
      }
    }
    if (descendantAnswer) return descendantAnswer;
    if (firstAssistant) return firstAssistant;
  }
  return nearestAssistantEntryId(entry, byId);
}

/**
 * Discover billing markers from older sessions created before image billing
 * metadata was added. These synthetic entries are safe to use for a read-only
 * usage query; a live session will persist the same data on its next agent_end.
 */
export function discoverRelayImageBillingEntries(
  entries: readonly SessionEntry[],
  groups: readonly RelayGroupMetadata[] = readRelayGroups(),
): RelayImageBillingEntry[] {
  const existing = readRelayImageBillingEntries(entries);
  const recorded = new Set(existing.map((entry) => entry.data.toolCallId));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const discovered: RelayImageBillingEntry[] = [...existing];
  for (const entry of entries) {
    const candidate = parseRelayImageBillingCandidate(entry, groups);
    if (!candidate || recorded.has(candidate.toolCallId)) continue;
    const anchorEntryId = finalAssistantEntryId(entry, entries, byId);
    if (!anchorEntryId) continue;
    discovered.push({
      entryId: `image:${entry.id}`,
      data: { version: 1, ...candidate, anchorEntryId },
    });
    recorded.add(candidate.toolCallId);
  }
  return discovered;
}

/**
 * Persist billing metadata for successful image tool results exactly once.
 * Custom entries are ignored by the LLM context and by the normal chat
 * renderer, but give the billing route a stable local anchor for the final
 * response in the user-visible turn.
 */
export function appendRelayImageBillingEntries(
  sessionManager: Pick<import("@earendil-works/pi-coding-agent").SessionManager, "getEntries" | "appendCustomEntry">,
  groups: readonly RelayGroupMetadata[] = readRelayGroups(),
): number {
  const getEntries = (sessionManager as { getEntries?: () => unknown }).getEntries;
  if (typeof getEntries !== "function") return 0;
  const entries = getEntries.call(sessionManager) as SessionEntry[];
  const discovered = discoverRelayImageBillingEntries(entries, groups);
  const recorded = new Set(readRelayImageBillingEntries(entries).map((entry) => entry.data.toolCallId));
  let appended = 0;
  for (const marker of discovered) {
    if (recorded.has(marker.data.toolCallId)) continue;
    sessionManager.appendCustomEntry(RELAY_IMAGE_BILLING_TYPE, {
      ...marker.data,
    } satisfies RelayImageBillingData);
    recorded.add(marker.data.toolCallId);
    appended += 1;
  }
  return appended;
}
