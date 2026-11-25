"use client";

import React, { useRef, useState, useCallback, useEffect, useLayoutEffect, useImperativeHandle, forwardRef, KeyboardEvent } from "react";
import type { BuiltinSlashCommandResult, CompactResultInfo, SlashCommandInfo } from "@/hooks/useAgentSession";
import type { QueueAction, QueuedInput, QueuedMessages } from "@/lib/agent-input-queue";
import type { SkillsResponse } from "@/lib/api-types";
import { getUserMessageDisplay, getUserMessageText } from "@/lib/message-display";
import type { UserMessage } from "@/lib/types";
import {
  clearDraft,
  getDraft,
  mergeRestoredSubmissionDraft,
  mergeRestoredSubmissionText,
  rekeyDraft as rekeyStoredDraft,
  restoreDraftSubmission,
  setDraft,
  toChatDraftImage,
  type ChatDraftImage,
} from "@/lib/draft-store";
import {
  MAX_ATTACHED_IMAGE_BYTES,
  MAX_ATTACHED_IMAGES,
  isBase64ImageWithinLimits,
  type AttachedImage,
} from "@/lib/image-attachments";
import {
  buildEntriesFromFiles, buildAtInsertText, buildFileAtMentionsText, extractAtQuery, filterFileEntries,
  type AtQueryMatch, type FileIndexEntry,
} from "@/lib/file-fuzzy";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { FolderIcon, getFileIcon } from "./FileIcons";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/hooks/useI18n";
import { useChatAppearance } from "@/hooks/useChatAppearance";
import { PRESET_FULL, type ToolEntry } from "@/lib/tool-presets";
import { ModelSelector, type ModelSelectorOption } from "./ModelSelector";
import { ReasoningControl } from "./ReasoningControl";
import { DEFAULT_SUBAGENT_MODE, SUBAGENT_MODES, type SubagentMode } from "@/lib/subagent-mode";
import { WorkModeSelector } from "./WorkModeSelector";
import type { WorkMode } from "@/lib/prompt-presets";
import type { ThinkingLevelOption } from "@/lib/model-capabilities";

export { filterModelOptions } from "./ModelSelector";

interface ComposerUploadResponse {
  uploaded?: string[];
  errors?: Array<{ name: string; error: string }>;
  error?: string;
}

interface Props {
  onSend: (message: string, images?: AttachedImage[]) => void;
  onAbort: () => void;
  stopLabel?: string;
  onFollowUp?: (message: string, images?: AttachedImage[]) => void;
  isStreaming: boolean;
  submissionDisabled?: boolean;
  /** Text-only composer without the session controls or outer spacing. */
  compact?: boolean;
  model?: { provider: string; modelId: string } | null;
  isAutoModelSelection?: boolean;
  modelNames?: Record<string, string>;
  modelList?: { id: string; name: string; provider: string; providerDisplayName?: string; input?: string[] }[];
  modelError?: string | null;
  /** Diagnostics from resolving `enabledModels`, e.g. a pattern that matched nothing. */
  modelScopeWarnings?: string[];
  onModelChange?: (provider: string, modelId: string) => void;
  modelSwitching?: boolean;
  imageModel?: { provider: string; modelId: string } | null;
  imageModelList?: { id: string; name: string; provider: string; providerDisplayName?: string }[];
  onImageModelChange?: (provider: string, modelId: string) => void;
  imageModelSwitching?: boolean;
  compactError?: string | null;
  compactResult?: CompactResultInfo | null;
  workMode?: WorkMode;
  pendingWorkMode?: WorkMode | null;
  onResolvedWorkMode?: (mode: WorkMode) => void;
  subagentMode?: SubagentMode;
  onSubagentModeChange?: (mode: SubagentMode) => void;
  subagentModeDisabled?: boolean;
  showWorkMode?: boolean;
  workModeDisabled?: boolean;
  messagePlaceholder?: string;
  approvalPolicyControl?: React.ReactNode;
  onNewWorkModeChanged?: () => Promise<void>;
  onSessionWorkModeChange?: (mode: WorkMode) => Promise<void>;
  thinkingLevel?: ThinkingLevelOption;
  onThinkingLevelChange?: (level: ThinkingLevelOption) => Promise<void>;
  availableThinkingLevels?: string[] | null;
  thinkingLevelMap?: Record<string, string | null> | null;
  retryInfo?: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  queuedMessages?: QueuedMessages | null;
  inputHistory?: string[];
  onQueueAction?: (id: string, action: QueueAction) => Promise<void>;
  slashCommands?: SlashCommandInfo[];
  slashCommandsLoading?: boolean;
  availableTools?: ToolEntry[];
  onLoadSlashCommands?: () => Promise<SlashCommandInfo[]> | SlashCommandInfo[];
  onBuiltinCommand?: (message: string) => Promise<BuiltinSlashCommandResult>;
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  onAudioUnlock?: () => void;
  draftKey?: string;
  /** Session working directory — enables the @ file autocomplete menu */
  cwd?: string | null;
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (text: string) => void;
  replaceMessage: (message: UserMessage) => void;
  addImages: (files: File[]) => void;
  rekeyDraft: (previousKey: string, nextKey: string) => void;
  restoreSubmission: (text: string, images?: ChatDraftImage[], targetDraftKey?: string) => void;
}

const COMPOSITION_END_ENTER_GRACE_MS = 100;
const TEXT_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const ANCHORED_MENU_GAP = 8;

export function getUpwardMenuMaxHeight(menuBottom: number, visibleTop: number, gap = ANCHORED_MENU_GAP): number {
  return Math.max(0, Math.floor(menuBottom - visibleTop - gap));
}

export function cycleListIndex(index: number, length: number, delta: number): number {
  if (length <= 0) return 0;
  return ((index + delta) % length + length) % length;
}

export function replaceLinksWithMarkdown(
  text: string,
  links: Iterable<{ label: string; href: string; occurrence: number }>,
): string | null {
  let result = "";
  let searchFrom = 0;
  let replaced = false;

  for (const { label, href, occurrence } of links) {
    if (!label || !href) continue;
    let index = 0;
    for (let match = 0; match <= occurrence; match++) {
      index = text.indexOf(label, match ? index + label.length : 0);
      if (index < 0) break;
    }
    if (index < searchFrom) continue;
    const escapedLabel = label.replace(/([\\[\]])/g, "\\$1");
    const escapedHref = href.replace(/([\\()])/g, "\\$1");
    result += `${text.slice(searchFrom, index)}[${escapedLabel}](${escapedHref})`;
    searchFrom = index + label.length;
    replaced = true;
  }

  return replaced ? result + text.slice(searchFrom) : null;
}

function getVisibleTopBoundary(element: HTMLElement): number {
  let visibleTop = window.visualViewport?.offsetTop ?? 0;

  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflowY = window.getComputedStyle(parent).overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "hidden" || overflowY === "clip") {
      visibleTop = Math.max(visibleTop, parent.getBoundingClientRect().top + parent.clientTop);
    }
  }

  return visibleTop;
}

function subscribeUpwardMenuMaxHeight(
  menu: HTMLElement,
  onChange: (height: number) => void,
): () => void {
  let frameId: number | null = null;
  const update = () => {
    frameId = null;
    onChange(getUpwardMenuMaxHeight(
      menu.getBoundingClientRect().bottom,
      getVisibleTopBoundary(menu),
    ));
  };
  const scheduleUpdate = () => {
    if (frameId !== null) cancelAnimationFrame(frameId);
    frameId = requestAnimationFrame(update);
  };

  update();
  const parent = menu.parentElement;
  const layoutContainer = parent?.parentElement;
  const anchorObserver = typeof ResizeObserver === "undefined" || !parent
    ? null
    : new ResizeObserver(scheduleUpdate);
  if (parent) anchorObserver?.observe(parent);
  if (layoutContainer) anchorObserver?.observe(layoutContainer);
  const viewport = window.visualViewport;
  viewport?.addEventListener("resize", scheduleUpdate);
  viewport?.addEventListener("scroll", scheduleUpdate);
  window.addEventListener("resize", scheduleUpdate);
  window.addEventListener("scroll", scheduleUpdate, true);

  return () => {
    anchorObserver?.disconnect();
    viewport?.removeEventListener("resize", scheduleUpdate);
    viewport?.removeEventListener("scroll", scheduleUpdate);
    window.removeEventListener("resize", scheduleUpdate);
    window.removeEventListener("scroll", scheduleUpdate, true);
    if (frameId !== null) cancelAnimationFrame(frameId);
  };
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return tokens.toLocaleString();
}

type BuiltinSlashCommand = {
  name: string;
  description: string;
  source: "builtin";
  availableWhileStreaming?: boolean;
};

type SlashCommandPaletteItem = SlashCommandInfo | BuiltinSlashCommand;

type SlashCommandMode = "direct" | "assistant";

export interface SlashCommandPresentation {
  /** Text shown in the command card. */
  label: string;
  /** User-facing explanation of what happens after submission. */
  description: string;
  /** Text inserted into the composer when the card is selected. */
  insertText: string;
  /** Whether the command executes itself or is expanded for the assistant. */
  mode: SlashCommandMode;
}

type AtPaletteItem =
  | { kind: "command"; command: SlashCommandPaletteItem }
  | { kind: "tool"; tool: ToolEntry }
  | { kind: "file"; entry: FileIndexEntry };

const BUILTIN_TOOL_NAMES = new Set([...PRESET_FULL, "powershell"]);

type SlashCommandSource = SlashCommandPaletteItem["source"];

const BUILTIN_SLASH_COMMANDS: BuiltinSlashCommand[] = [
  { name: "compact", description: "chat.commandCompact", source: "builtin" },
  { name: "reload", description: "chat.commandReload", source: "builtin" },
  { name: "name", description: "chat.commandName", source: "builtin" },
  { name: "session", description: "chat.commandSession", source: "builtin", availableWhileStreaming: true },
  { name: "copy", description: "chat.commandCopy", source: "builtin", availableWhileStreaming: true },
  { name: "clone", description: "chat.commandClone", source: "builtin" },
];

function getBuiltinSlashCommand(message: string): BuiltinSlashCommand | undefined {
  const match = message.trim().match(/^\/([^\s]+)(?:\s|$)/);
  if (!match) return undefined;
  return BUILTIN_SLASH_COMMANDS.find((command) => command.name === match[1]);
}

export function canRunBuiltinSlashCommandWhileStreaming(message: string): boolean {
  return getBuiltinSlashCommand(message)?.availableWhileStreaming === true;
}

export function isExactSlashCommand(message: string, command: SlashCommandPaletteItem): boolean {
  return command.source === "builtin" && message.trim() === `/${command.name}`;
}

export function canClearBuiltinCommandInput(message: string, imageCount: number, submittedMessage: string): boolean {
  return imageCount === 0 && message.trim() === submittedMessage;
}

const SLASH_SOURCES: SlashCommandSource[] = ["builtin", "extension", "prompt", "skill"];

const SLASH_SOURCE_GROUP_LABEL_KEYS: Record<SlashCommandSource, string> = {
  builtin: "chat.builtInCommands",
  extension: "chat.extensionCommands",
  prompt: "chat.promptTemplates",
  skill: "chat.assistantSkills",
};

const SLASH_SOURCE_ORDER: Record<SlashCommandSource, number> = {
  builtin: 0,
  extension: 1,
  prompt: 2,
  skill: 3,
};

/**
 * The official image package exposes two different user-facing surfaces:
 * `/image-gen` is an extension command whose bare form only reports status,
 * while `skill:image-gen` is a prompt workflow for the assistant. Keep the
 * distinction in one place so the slash palette and @ capability picker cannot
 * accidentally imply that both entries directly generate an image.
 */
export function isImageGenerationExtensionCommand(command: SlashCommandPaletteItem): boolean {
  if (command.source !== "extension" || command.name !== "image-gen") return false;
  const source = [command.sourceInfo?.source, command.sourceInfo?.path]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLocaleLowerCase();
  // The official package carries its npm source in sourceInfo.  Treat a
  // source-less command with the reserved name as the same command too: an
  // older runtime may omit sourceInfo, and exposing two identical image
  // entries is worse than conservatively hiding the low-level one when the
  // user-facing skill is present.
  return !source || source.includes("@amaster.ai/pi-image-gen");
}

export function isImageGenerationSkillCommand(command: SlashCommandPaletteItem): boolean {
  return command.source === "skill" && command.name.toLocaleLowerCase() === "skill:image-gen";
}

export function getSlashCommandInsertText(command: SlashCommandPaletteItem): string {
  if (isImageGenerationExtensionCommand(command)) return "/image-gen generate ";
  return `/${command.name} `;
}

export function getSlashCommandPresentation(
  command: SlashCommandPaletteItem,
  t: (key: string) => string,
): SlashCommandPresentation {
  if (isImageGenerationExtensionCommand(command)) {
    return {
      label: t("chat.imageDirectCommandLabel"),
      description: t("chat.imageDirectCommandDescription"),
      insertText: getSlashCommandInsertText(command),
      mode: "direct",
    };
  }

  if (isImageGenerationSkillCommand(command)) {
    return {
      label: t("chat.imageSkillCommandLabel"),
      description: t("chat.imageSkillCommandDescription"),
      insertText: getSlashCommandInsertText(command),
      mode: "assistant",
    };
  }

  const mode: SlashCommandMode = command.source === "builtin" || command.source === "extension"
    ? "direct"
    : "assistant";
  const description = command.source === "builtin"
    ? t(command.description)
    : command.description ?? "";
  return {
    label: `/${command.name}`,
    description,
    insertText: getSlashCommandInsertText(command),
    mode,
  };
}

/**
 * Build the text that users can search for in either capability palette.
 * Include the friendly label as well as the underlying command name so a
 * Chinese user can type “生成图片” without knowing the internal skill id.
 */
export function getSlashCommandSearchText(
  command: SlashCommandPaletteItem,
  t: (key: string) => string,
): string {
  const presentation = getSlashCommandPresentation(command, t);
  return [command.name, presentation.label, presentation.description]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
}

/**
 * Hide the low-level image extension command whenever its bundled skill is
 * available.  The extension's command is useful for list/reload diagnostics,
 * but its generate subcommand only emits a transient path notification.  The
 * skill invokes the same image tool through the assistant, so the result is
 * rendered in the conversation and remains discoverable to a non-technical
 * user.  Keep the extension as a compatibility fallback for older installs
 * that shipped without the skill.
 */
export function filterUserFacingSlashCommands(
  commands: SlashCommandPaletteItem[],
): SlashCommandPaletteItem[] {
  const hasImageSkill = commands.some(isImageGenerationSkillCommand);
  if (!hasImageSkill) return commands;
  return commands.filter((command) => !isImageGenerationExtensionCommand(command));
}

function slashMatchRank(command: SlashCommandPaletteItem, query: string, t: (key: string) => string): number {
  const name = command.name.toLowerCase();
  const label = getSlashCommandPresentation(command, t).label.toLowerCase();
  const description = getSlashDescription(command, t).toLowerCase();
  if (name === query || label === query) return 0;
  if (name.startsWith(query) || label.startsWith(query)) return 1;
  if (name.includes(query) || label.includes(query)) return 2;
  if (description.includes(query)) return 3;
  return 4;
}

function getSlashDescription(command: SlashCommandPaletteItem, t: (key: string) => string): string {
  return getSlashCommandPresentation(command, t).description;
}

// Skill slash commands are named "skill:<skillName>"; look the skill up in the
// dormancy map fetched from /api/skills. Unknown skills are treated as active.
function isDormantSkillCommand(command: SlashCommandPaletteItem, dormancy: Record<string, boolean>): boolean {
  if (command.source !== "skill" || !command.name.startsWith("skill:")) return false;
  return dormancy[command.name.slice("skill:".length)] === true;
}

export function buildSlashCommandLayout(
  commands: SlashCommandPaletteItem[],
  dormancy: Record<string, boolean>,
) {
  let index = 0;
  const groups = SLASH_SOURCES
    .map((source) => {
      const sourceCommands = commands.filter((command) => command.source === source);
      const orderedCommands = source === "skill"
        ? [
            ...sourceCommands.filter((command) => !isDormantSkillCommand(command, dormancy)),
            ...sourceCommands.filter((command) => isDormantSkillCommand(command, dormancy)),
          ]
        : sourceCommands;
      return {
        source,
        items: orderedCommands.map((command) => ({ command, index: index++ })),
      };
    })
    .filter((group) => group.items.length > 0);

  return {
    commands: groups.flatMap((group) => group.items.map(({ command }) => command)),
    groups,
  };
}

const CLIENT_IMAGE_COMPRESSION_THRESHOLD_BYTES = 1024 * 1024;
const CLIENT_MAX_IMAGE_SIDE = 1024;
const CLIENT_JPEG_QUALITY = 0.85;

export function shouldCompressImageFile(file: Pick<File, "size" | "type">): boolean {
  return file.size > CLIENT_IMAGE_COMPRESSION_THRESHOLD_BYTES && file.type !== "image/gif";
}

function readImageFile(file: Blob, mimeType: string): Promise<{ data: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const data = typeof reader.result === "string" ? reader.result.split(",")[1] : undefined;
      if (!data) {
        reject(new Error("Failed to read image"));
        return;
      }
      resolve({ data, mimeType });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export async function compressImageFile(file: File): Promise<{ data: string; mimeType: string }> {
  const original = () => readImageFile(file, file.type);
  if (!shouldCompressImageFile(file) || typeof createImageBitmap !== "function") return original();

  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return original();

  try {
    const scale = Math.min(1, CLIENT_MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return original();
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL("image/jpeg", CLIENT_JPEG_QUALITY).split(",")[1];
    return data && data.length < Math.ceil(file.size / 3) * 4
      ? { data, mimeType: "image/jpeg" }
      : original();
  } catch {
    return original();
  } finally {
    bitmap.close();
  }
}

async function saveOriginalImage(file: File): Promise<string> {
  const response = await fetch("/api/attachments/image", {
    method: "POST",
    headers: { "Content-Type": file.type, "X-Image-Name": encodeURIComponent(file.name) },
    body: file,
  });
  const result = await response.json().catch(() => null) as { filePath?: unknown } | null;
  if (!response.ok || typeof result?.filePath !== "string" || !result.filePath) {
    throw new Error("Could not save the original image");
  }
  return result.filePath;
}

function draftImageToAttachedImage(image: ChatDraftImage): AttachedImage {
  return {
    ...image,
    previewUrl: `data:${image.mimeType};base64,${image.data}`,
  };
}

function draftImagesToAttachedImages(images: ChatDraftImage[] | undefined): AttachedImage[] {
  return (images ?? [])
    .filter(isBase64ImageWithinLimits)
    .map(draftImageToAttachedImage);
}

export function canRestoreUserMessage(
  value: string,
  attachedImageCount: number,
  pendingImageCount: number,
): boolean {
  return !value.trim() && attachedImageCount === 0 && pendingImageCount === 0;
}

export { getUserMessageText };

export function getUserMessageDraftImages(message: UserMessage, imagePaths = getUserMessageDisplay(message).imagePaths): ChatDraftImage[] {
  if (typeof message.content === "string") return [];
  const images = message.content.filter((block) => block.type === "image");
  // Older prompts only stored the distinct paths. Associate them when every image has a path.
  const paths = imagePaths.length === images.length ? imagePaths : [];
  return images.flatMap((block, index) => {
    // Support both the current nested image format and older flat pi-ai entries.
    const flat = block as unknown as { data?: unknown; mimeType?: unknown };
    const data = block.source?.type === "base64" ? block.source.data : flat.data;
    const mimeType = block.source?.type === "base64" ? block.source.media_type : flat.mimeType;
    if (typeof data !== "string" || typeof mimeType !== "string") return [];

    const filePath = paths[index];
    const image = { data, mimeType, ...(filePath ? { filePath } : {}) };
    return isBase64ImageWithinLimits(image) ? [image] : [];
  });
}

function revokeImagePreview(image: AttachedImage): void {
  if (image.previewUrl.startsWith("blob:")) {
    URL.revokeObjectURL(image.previewUrl);
  }
}

function QueuedMessageRow({ item, busy, canSteer, onAction }: {
  item: QueuedInput;
  busy: boolean;
  canSteer: boolean;
  onAction?: (id: string, action: QueueAction) => void;
}) {
  const { t } = useI18n();
  const { id, kind, text, imageCount } = item;
  const steering = kind === "steer";
  const statusColor = steering ? "var(--warning-text, #a16207)" : "var(--accent)";
  const imageLabel = imageCount > 0 ? t("chat.queuedImages", { count: imageCount }) : null;
  const buttonClass = "rounded-md border border-border px-2 py-1 text-xs text-text hover:bg-bg-hover disabled:opacity-50";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border px-2.5 py-2 text-xs">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <strong className="shrink-0 rounded px-1.5 py-0.5 font-semibold" style={{
            color: statusColor,
            background: "color-mix(in srgb, " + statusColor + " 12%, transparent)",
          }}>
            {steering ? t("chat.steeringCurrent") : t("chat.followUpQueued")}
          </strong>
          {text && <span className="truncate text-text" title={text}>{text}</span>}
          {imageLabel && <span className="shrink-0 text-text-muted">{imageLabel}</span>}
        </div>
        <small className="mt-0.5 block text-text-muted">
          {steering ? t("chat.steeringCurrentHint") : t("chat.followUpQueuedHint")}
        </small>
      </div>
      {id && onAction && (
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {!steering && canSteer && (
            <button type="button" className={buttonClass} disabled={busy} onClick={() => onAction(id, "steer")}>
              {t("chat.promoteToSteer")}
            </button>
          )}
          <button type="button" className={buttonClass} disabled={busy} onClick={() => onAction(id, "recall")}>
            {t("chat.recall")}
          </button>
        </div>
      )}
    </div>
  );
}

function ModelNoticeBanner({ tone, title, body, onClose }: { tone: "error" | "warning"; title: string; body: string; onClose?: () => void }) {
  const color = tone === "error" ? "239,68,68" : "234,179,8";
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        maxHeight: 120,
        marginBottom: 8,
        padding: "7px 10px",
        overflowY: "auto",
        border: `1px solid rgba(${color},0.3)`,
        borderRadius: 6,
        background: `rgba(${color},0.07)`,
        color: `rgb(${color})`,
        fontSize: 11,
        lineHeight: 1.45,
      }}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flexShrink: 0, marginTop: 1 }}
        aria-hidden="true"
      >
        <path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{body}</div>
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss"
          style={{
            flexShrink: 0,
            background: "none",
            border: "none",
            padding: "0 2px",
            cursor: "pointer",
            color: "inherit",
            opacity: 0.7,
            fontSize: 13,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

export function ModelErrorBanner({ error }: { error?: string | null }) {
  const { t } = useI18n();
  if (!error) return null;
  return <ModelNoticeBanner tone="error" title={t("chat.modelError")} body={error} />;
}

/** True when the selected model is known to accept image input (#584). Unknown modality info never blocks the user. */
export function modelSupportsImageInput(
  model: { provider: string; modelId: string } | null | undefined,
  modelList: { id: string; name: string; provider: string; input?: string[] }[] | undefined
): boolean {
  if (!model) return true;
  const entry = modelList?.find((m) => m.provider === model.provider && m.id === model.modelId);
  if (!entry || !entry.input) return true;
  return entry.input.includes("image");
}

/** Surfaces `enabledModels` patterns that matched nothing, so a typo is visible (#307). */
export function ModelScopeWarningBanner({ warnings }: { warnings?: string[] }) {
  const { t } = useI18n();
  if (!warnings || warnings.length === 0) return null;
  return (
    <ModelNoticeBanner
      tone="warning"
      title={warnings.length > 1 ? t("chat.modelScopeWarnings") : t("chat.modelScopeWarning")}
      body={warnings.join("\n")}
    />
  );
}

export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput({
  onSend, onAbort, stopLabel, onFollowUp, isStreaming, submissionDisabled, model, isAutoModelSelection, modelNames, modelList, modelError, modelScopeWarnings, onModelChange, modelSwitching,
  imageModel, imageModelList, onImageModelChange, imageModelSwitching,
  compactError, compactResult,
  workMode, pendingWorkMode, showWorkMode, workModeDisabled, onNewWorkModeChanged, onSessionWorkModeChange, onResolvedWorkMode,
  messagePlaceholder, approvalPolicyControl,
  subagentMode, onSubagentModeChange, subagentModeDisabled,
  thinkingLevel, onThinkingLevelChange, availableThinkingLevels, thinkingLevelMap,
  retryInfo, queuedMessages, inputHistory = [], onQueueAction,
  slashCommands, slashCommandsLoading, availableTools, onLoadSlashCommands,
  onBuiltinCommand,
  soundEnabled, onSoundToggle, onAudioUnlock,
  draftKey,
  cwd,
  compact = false,
}: Props, ref) {
  const { t } = useI18n();
  const { fontSize } = useChatAppearance();
  const isMobile = useIsMobile();
  const [value, setValue] = useState(() => (draftKey ? getDraft(draftKey)?.value ?? "" : ""));
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>(() => (
    draftKey ? draftImagesToAttachedImages(getDraft(draftKey)?.images) : []
  ));
  const [fileUploadStatus, setFileUploadStatus] = useState<{
    phase: "idle" | "uploading" | "success" | "error";
    message?: string;
  }>({ phase: "idle" });
  const [savingImages, setSavingImages] = useState(false);
  const [imageSaveFailed, setImageSaveFailed] = useState(false);
  const [queueActionPending, setQueueActionPending] = useState(false);
  const tooManyImages = attachedImages.length > MAX_ATTACHED_IMAGES;
  const attachmentsUploading = savingImages || fileUploadStatus.phase === "uploading";
  const uploadStatus = savingImages
    ? { phase: "uploading", message: t("chat.savingImages") }
    : !attachmentsUploading && (tooManyImages || imageSaveFailed)
      ? { phase: "error", message: tooManyImages
        ? t("chat.tooManyAttachedImages", { count: MAX_ATTACHED_IMAGES })
        : t("chat.imageSaveFailed") }
      : fileUploadStatus;
  const queueItems: QueuedInput[] = queuedMessages?.items ?? [
    ...(queuedMessages?.steering ?? []).map((text): QueuedInput => ({ kind: "steer", text, imageCount: 0 })),
    ...(queuedMessages?.followUp ?? []).map((text): QueuedInput => ({ kind: "followUp", text, imageCount: 0 })),
  ];
  const trimmedValue = value.trimStart();
  const bashMode = attachedImages.length === 0 && trimmedValue.startsWith("!");
  const bashExcluded = bashMode && trimmedValue.startsWith("!!");
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [slashMenuMaxHeight, setSlashMenuMaxHeight] = useState<number | null>(null);
  const [atQuery, setAtQuery] = useState<AtQueryMatch | null>(null);
  const [atMenuOpen, setAtMenuOpen] = useState(false);
  const [atMenuMaxHeight, setAtMenuMaxHeight] = useState<number | null>(null);
  const [atActiveIndex, setAtActiveIndex] = useState(0);
  const [imageWarningDismissed, setImageWarningDismissed] = useState(false);
  const [historyMenuOpen, setHistoryMenuOpen] = useState(false);
  const [historyActiveIndex, setHistoryActiveIndex] = useState(0);
  const [builtinCommandPending, setBuiltinCommandPending] = useState(false);
  const builtinCommandPendingRef = useRef(false);
  const [fileIndex, setFileIndex] = useState<{ cwd: string; entries: FileIndexEntry[]; truncated: boolean } | null>(null);
  const [fileIndexLoading, setFileIndexLoading] = useState(false);
  const [atServerResult, setAtServerResult] = useState<{ cwd: string; query: string; matches: FileIndexEntry[] } | null>(null);
  const [skillDormancyState, setSkillDormancyState] = useState<{
    cwd: string;
    values: Record<string, boolean>;
  } | null>(null);
  const skillDormancy = cwd && skillDormancyState?.cwd === cwd
    ? skillDormancyState.values
    : {};

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const historyMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);
  const slashCommandsRequestedRef = useRef(false);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const slashItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const atMenuRef = useRef<HTMLDivElement>(null);
  const atItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const historyItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const fileIndexMetaRef = useRef<{ cwd: string; fetchedAt: number } | null>(null);
  const fileIndexFetchingRef = useRef<string | null>(null);
  const draftKeyRef = useRef(draftKey);
  const valueRef = useRef(value);
  const attachedImagesRef = useRef(attachedImages);
  const pendingImageCountRef = useRef(0);
  const composerMountedRef = useRef(false);
  valueRef.current = value;
  attachedImagesRef.current = attachedImages;

  useImperativeHandle(ref, () => ({
    insertIfEmpty(text: string) {
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      if (current.trim()) return;
      valueRef.current = text;
      setValue(text);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    replaceMessage(message: UserMessage) {
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      if (!canRestoreUserMessage(current, attachedImagesRef.current.length, pendingImageCountRef.current)) return;

      const { text: restoredText, imagePaths } = getUserMessageDisplay(message);
      const restoredImages = draftImagesToAttachedImages(getUserMessageDraftImages(message, imagePaths));
      valueRef.current = restoredText;
      attachedImagesRef.current = restoredImages;
      setValue(restoredText);
      setAtQuery(null);
      setHistoryMenuOpen(false);
      setAttachedImages((prev) => {
        prev.forEach(revokeImagePreview);
        return restoredImages;
      });
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    rekeyDraft(previousKey: string, nextKey: string) {
      if (previousKey === nextKey) return;
      if (draftKeyRef.current !== previousKey) {
        rekeyStoredDraft(previousKey, nextKey);
        return;
      }

      const currentDraft = {
        value: valueRef.current,
        images: attachedImagesRef.current.map(toChatDraftImage),
      };
      const moved = rekeyStoredDraft(previousKey, nextKey, currentDraft) ?? { value: "", images: [] };
      const unchanged = moved.value === currentDraft.value
        && moved.images.length === currentDraft.images.length
        && moved.images.every((image, index) => (
          image.data === currentDraft.images[index]?.data
          && image.mimeType === currentDraft.images[index]?.mimeType
        ));
      draftKeyRef.current = nextKey;
      if (unchanged) return;

      const movedImages = draftImagesToAttachedImages(moved.images);
      valueRef.current = moved.value;
      attachedImagesRef.current = movedImages;
      setValue(moved.value);
      setAttachedImages((current) => {
        current.forEach(revokeImagePreview);
        return movedImages;
      });
      setAtQuery(null);
      setHistoryMenuOpen(false);
    },
    restoreSubmission(text: string, images?: ChatDraftImage[], targetDraftKey?: string) {
      if (!text.trim() && !images?.length) return;

      // clearInput is queued before the submission handler runs. Compose with
      // that queued state so a fast rejection cannot observe stale DOM text and
      // then get overwritten by the clear.
      const currentDraftKey = draftKeyRef.current;
      const destinationDraftKey = targetDraftKey ?? currentDraftKey;
      const targetsCurrentComposer = destinationDraftKey === currentDraftKey;
      const storedDraft = !targetsCurrentComposer && destinationDraftKey
        ? getDraft(destinationDraftKey)
        : null;
      const restoredDraft = mergeRestoredSubmissionDraft(
        text,
        images,
        targetsCurrentComposer ? valueRef.current : (storedDraft?.value ?? ""),
        targetsCurrentComposer
          ? attachedImagesRef.current.map(toChatDraftImage)
          : (storedDraft?.images ?? []),
      );
      // The first optimistic message switches ChatWindow out of its empty-state
      // layout and remounts this component. Persist synchronously so recovery is
      // not lost if this instance is the one being unmounted.
      if (destinationDraftKey) setDraft(destinationDraftKey, restoredDraft);
      if (!targetsCurrentComposer) return;
      const restoredImages = images?.length
        ? [...draftImagesToAttachedImages(images), ...attachedImagesRef.current]
        : attachedImagesRef.current;
      // Session promotion can rekey this composer before React flushes the
      // functional updates below, so update the imperative snapshot first.
      valueRef.current = restoredDraft.value;
      attachedImagesRef.current = restoredImages;
      setValue((current) => {
        const restored = mergeRestoredSubmissionText(text, current);
        valueRef.current = restored;
        return restored;
      });
      setAtQuery(null);
      setHistoryMenuOpen(false);
      if (images?.length) {
        setAttachedImages((current) => {
          const restored = draftImagesToAttachedImages(images);
          const next = restored.length > 0 ? [...restored, ...current] : current;
          attachedImagesRef.current = next;
          return next;
        });
      }
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    insertText(text: string) {
      const ta = textareaRef.current;
      if (!ta) {
        setValue((v) => v + (v ? " " : "") + text);
        return;
      }
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? ta.value.length;
      const before = ta.value.slice(0, start);
      const after = ta.value.slice(end);
      const sep = before.length > 0 && !before.endsWith(" ") ? " " : "";
      const newVal = before + sep + text + after;
      valueRef.current = newVal;
      setValue(newVal);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        const pos = start + sep.length + text.length;
        ta.setSelectionRange(pos, pos);
        ta.focus();
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    addImages(files: File[]) {
      processImageFiles(files);
    },
  }));

  const processImageFiles = useCallback(async (files: File[]) => {
    if (compact) return;
    const remaining = Math.max(
      0,
      MAX_ATTACHED_IMAGES - attachedImagesRef.current.length - pendingImageCountRef.current,
    );
    const imageFiles = files
      .filter((f) => f.type.startsWith("image/") && f.size <= MAX_ATTACHED_IMAGE_BYTES)
      .slice(0, remaining);
    if (!imageFiles.length) return;
    const targetDraftKey = draftKeyRef.current;
    if (pendingImageCountRef.current === 0) setImageSaveFailed(false);
    pendingImageCountRef.current += imageFiles.length;
    setSavingImages(true);
    try {
      const results = await Promise.allSettled(
        imageFiles.map(async (file) => ({
          ...await compressImageFile(file),
          filePath: await saveOriginalImage(file),
        }))
      );
      if (!composerMountedRef.current || draftKeyRef.current !== targetDraftKey) {
        const saved = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
        if (targetDraftKey && saved.length) restoreDraftSubmission(targetDraftKey, "", saved);
        return;
      }

      const saved = results.flatMap((result, index) => result.status === "fulfilled"
        ? [{ ...result.value, file: imageFiles[index] }]
        : [])
        .map(({ file, ...image }) => ({ ...image, previewUrl: URL.createObjectURL(file) }));
      const next = [...attachedImagesRef.current, ...saved];
      attachedImagesRef.current = next;
      setAttachedImages(next);
      if (results.some((result) => result.status === "rejected")) setImageSaveFailed(true);
    } finally {
      pendingImageCountRef.current -= imageFiles.length;
      if (composerMountedRef.current) setSavingImages(pendingImageCountRef.current > 0);
    }
  }, [compact]);

  const appendUploadedFileMentions = useCallback((fileNames: string[]) => {
    if (!fileNames.length) return;
    const mentions = buildFileAtMentionsText(fileNames);
    setValue((current) => {
      const separator = current && !/\s$/.test(current) ? " " : "";
      const next = `${current}${separator}${mentions}`;
      valueRef.current = next;
      return next;
    });
    // Force the next @ lookup to include the files that were just uploaded.
    fileIndexMetaRef.current = null;
    setFileIndex(null);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    });
  }, []);

  const uploadProjectFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    if (!cwd) {
      setFileUploadStatus({ phase: "error", message: t("chat.fileUploadNeedsProject") });
      return;
    }

    setFileUploadStatus({ phase: "uploading", message: t("chat.uploadingFiles") });
    try {
      const formData = new FormData();
      files.forEach((file) => formData.append("files", file, file.name));
      const response = await fetch(
        `/api/files/${encodeFilePathForApi(cwd)}?type=upload&conflict=rename`,
        { method: "POST", body: formData },
      );
      const data = await response.json().catch(() => ({})) as ComposerUploadResponse;
      if (!response.ok) {
        throw new Error(data.error ?? t("chat.fileUploadFailed"));
      }
      const uploaded = data.uploaded ?? [];
      appendUploadedFileMentions(uploaded);
      const failures = data.errors ?? [];
      if (failures.length > 0) {
        setFileUploadStatus({
          phase: "error",
          message: failures.map((item) => `${item.name}: ${item.error}`).join("\n"),
        });
      } else {
        setFileUploadStatus({
          phase: "success",
          message: t("chat.filesAdded", { count: uploaded.length }),
        });
      }
    } catch (error) {
      setFileUploadStatus({
        phase: "error",
        message: error instanceof Error ? error.message : t("chat.fileUploadFailed"),
      });
    }
  }, [appendUploadedFileMentions, cwd, t]);

  const processComposerFiles = useCallback((files: File[]) => {
    if (compact || files.length === 0) return;
    const images = files.filter((file) => file.type.startsWith("image/"));
    const projectFiles = files.filter((file) => !file.type.startsWith("image/"));
    if (images.length > 0) void processImageFiles(images);
    if (projectFiles.length > 0) void uploadProjectFiles(projectFiles);
  }, [compact, processImageFiles, uploadProjectFiles]);

  const removeImage = useCallback((index: number) => {
    setAttachedImages((prev) => {
      const next = [...prev];
      const [removed] = next.splice(index, 1);
      if (removed) revokeImagePreview(removed);
      attachedImagesRef.current = next;
      return next;
    });
  }, []);

  const clearImages = useCallback(() => {
    attachedImagesRef.current = [];
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview);
      return [];
    });
  }, []);

  const clearInput = useCallback(() => {
    valueRef.current = "";
    setValue("");
    setAtQuery(null);
    setHistoryMenuOpen(false);
    setFileUploadStatus({ phase: "idle" });
    setImageSaveFailed(false);
    if (draftKey) clearDraft(draftKey);
    if (draftKeyRef.current && draftKeyRef.current !== draftKey) clearDraft(draftKeyRef.current);
    clearImages();
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [clearImages, draftKey]);

  useEffect(() => {
    if (!draftKey || draftKeyRef.current !== draftKey) return;
    setDraft(draftKey, {
      value,
      images: attachedImages.map(toChatDraftImage),
    });
  }, [attachedImages, draftKey, value]);

  useEffect(() => {
    const previousDraftKey = draftKeyRef.current;
    if (previousDraftKey === draftKey) return;

    if (previousDraftKey) {
      setDraft(previousDraftKey, {
        value: valueRef.current,
        images: attachedImagesRef.current.map(toChatDraftImage),
      });
    }

    const draft = draftKey ? getDraft(draftKey) : null;
    draftKeyRef.current = draftKey;
    const nextValue = draft?.value ?? "";
    const nextImages = draftImagesToAttachedImages(draft?.images);
    valueRef.current = nextValue;
    attachedImagesRef.current = nextImages;
    setValue(nextValue);
    setAtQuery(null);
    setHistoryMenuOpen(false);
    setImageSaveFailed(false);
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview);
      return nextImages;
    });
  }, [draftKey]);

  const resizeTextarea = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    if (ta.value) ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, []);

  useLayoutEffect(resizeTextarea, [value, fontSize, resizeTextarea]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    let previousWidth = -1;
    const observer = new ResizeObserver(([entry]) => {
      // Height updates also notify the observer; only remeasure on width changes.
      if (entry.contentRect.width === previousWidth) return;
      previousWidth = entry.contentRect.width;
      resizeTextarea();
    });
    observer.observe(ta);
    return () => observer.disconnect();
  }, [resizeTextarea]);

  useEffect(() => {
    composerMountedRef.current = true;
    return () => {
      composerMountedRef.current = false;
      attachedImagesRef.current.forEach(revokeImagePreview);
    };
  }, []);

  const runBuiltinCommand = useCallback(async (msg: string): Promise<boolean> => {
    if (attachedImages.length || !msg.startsWith("/") || !onBuiltinCommand) return false;
    if (builtinCommandPendingRef.current) return true;
    builtinCommandPendingRef.current = true;
    setBuiltinCommandPending(true);
    try {
      const result = await onBuiltinCommand(msg);
      if (!result.handled) return false;
      if (!result.error && canClearBuiltinCommandInput(valueRef.current, attachedImagesRef.current.length, msg)) clearInput();
      return true;
    } finally {
      builtinCommandPendingRef.current = false;
      setBuiltinCommandPending(false);
    }
  }, [attachedImages.length, clearInput, onBuiltinCommand]);

  const handleSend = useCallback(async () => {
    if (submissionDisabled || builtinCommandPendingRef.current || pendingImageCountRef.current > 0 || fileUploadStatus.phase === "uploading" || tooManyImages) return;
    const msg = value.trim();
    if (!msg && !attachedImages.length) return;
    onAudioUnlock?.();
    const builtinAllowed = !isStreaming || canRunBuiltinSlashCommandWhileStreaming(msg);
    if (builtinAllowed && await runBuiltinCommand(msg)) return;
    if (isStreaming) return;
    clearInput();
    onSend(msg, attachedImages.length ? attachedImages : undefined);
  }, [value, attachedImages, isStreaming, submissionDisabled, runBuiltinCommand, onSend, clearInput, onAudioUnlock, fileUploadStatus.phase, tooManyImages]);

  const slashQuery = !compact && value.startsWith("/") && !/\s/.test(value.slice(1))
    ? value.slice(1).toLowerCase()
    : null;

  const filteredSlashCommands = (() => {
    if (slashQuery === null) return [];
    const builtinCommands = isStreaming
      ? BUILTIN_SLASH_COMMANDS.filter((command) => command.availableWhileStreaming)
      : BUILTIN_SLASH_COMMANDS;
    const commands = filterUserFacingSlashCommands([...builtinCommands, ...(slashCommands ?? [])]);
    return [...commands]
      .filter((command) => {
        return getSlashCommandSearchText(command, t).includes(slashQuery);
      })
      .sort((a, b) => {
        const rankDelta = slashMatchRank(a, slashQuery, t) - slashMatchRank(b, slashQuery, t);
        if (rankDelta !== 0) return rankDelta;
        return SLASH_SOURCE_ORDER[a.source] - SLASH_SOURCE_ORDER[b.source]
          || TEXT_COLLATOR.compare(a.name, b.name);
      });
  })();

  const {
    commands: displayedSlashCommands,
    groups: groupedSlashCommands,
  } = buildSlashCommandLayout(filteredSlashCommands, skillDormancy);

  const slashCommandCountLabel = filteredSlashCommands.length === 1
    ? t(slashQuery ? "chat.match" : "chat.command")
    : t(slashQuery ? "chat.matches" : "chat.commands", { count: filteredSlashCommands.length });
  const hasInputText = Boolean(value.trim());
  const canSubmitMessage = !submissionDisabled && !builtinCommandPending && !attachmentsUploading
    && !tooManyImages && (hasInputText || attachedImages.length > 0);
  // Warn when images are attached but the selected model is known not to accept
  // image input (#584), including a resolved default. Unknown models stay silent.
  const showImageUnsupportedWarning = (
    attachedImages.length > 0
    && !modelSupportsImageInput(model, modelList)
    && !imageWarningDismissed
  );
  useEffect(() => {
    if (attachedImages.length === 0) setImageWarningDismissed(false);
  }, [attachedImages.length]);

  // ── @ capability and file autocomplete ──────────────────────────────────
  // Skills, extension commands, and files share one discoverable menu.
  // Selecting a capability rewrites the draft to its real slash command so
  // the upstream agent invokes it rather than treating it as plain mention
  // text; any text already typed becomes that command's argument.
  const updateAtQuery = useCallback((text: string, cursor: number | null) => {
    const pos = cursor ?? text.length;
    setAtQuery(extractAtQuery(text.slice(0, pos)));
  }, []);

  const atQueryText = atQuery?.query ?? null;
  const atLocalMatches: FileIndexEntry[] = React.useMemo(() => (
    atQueryText !== null && fileIndex && fileIndex.cwd === cwd
      ? filterFileEntries(fileIndex.entries, atQueryText)
      : []
  ), [atQueryText, fileIndex, cwd]);

  // When the client index is truncated (repo larger than the index cap),
  // local filtering cannot see deep files, so queries are also ranked
  // server-side against the full listing. Local matches render immediately
  // and are replaced when the (debounced) server result for the current
  // query arrives; stale responses are ignored via the query/cwd tag.
  const needsServerSearch = Boolean(atQueryText && fileIndex?.truncated && fileIndex.cwd === cwd);
  useEffect(() => {
    if (!needsServerSearch || !cwd || !atQueryText) return;
    const fetchCwd = cwd;
    const query = atQueryText;
    const timer = setTimeout(() => {
      fetch(`/api/file-index?cwd=${encodeURIComponent(fetchCwd)}&q=${encodeURIComponent(query)}`)
        .then((res) => {
          if (!res.ok) throw new Error(`file search failed: ${res.status}`);
          return res.json() as Promise<{ matches?: FileIndexEntry[] }>;
        })
        .then((data) => setAtServerResult({ cwd: fetchCwd, query, matches: data.matches ?? [] }))
        .catch(() => {
          // Keep showing local matches; the next keystroke retries.
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [needsServerSearch, atQueryText, cwd]);

  const serverResultInUse = needsServerSearch
    && atServerResult !== null
    && atServerResult.cwd === cwd
    && atServerResult.query === atQueryText;
  const atFileMatches: FileIndexEntry[] = serverResultInUse ? atServerResult.matches : atLocalMatches;
  const atCommandMatches = React.useMemo(() => {
    if (!atQuery) return [];
    const query = atQuery.query.toLowerCase();
    return filterUserFacingSlashCommands(slashCommands ?? [])
      .filter((command) => command.source === "skill" || command.source === "extension")
      .filter((command) => getSlashCommandSearchText(command, t).includes(query))
      .sort((a, b) => {
        const sourceDelta = (a.source === "skill" ? 0 : 1) - (b.source === "skill" ? 0 : 1);
        return sourceDelta || TEXT_COLLATOR.compare(a.name, b.name);
      })
      .slice(0, 24);
  }, [atQuery, slashCommands, t]);
  const atToolMatches = React.useMemo(() => {
    if (!atQuery) return [];
    const query = atQuery.query.toLowerCase();
    return (availableTools ?? [])
      .filter((tool) => tool.active && !BUILTIN_TOOL_NAMES.has(tool.name))
      .filter((tool) => tool.name.toLowerCase().includes(query)
        || tool.description.toLowerCase().includes(query))
      .sort((a, b) => TEXT_COLLATOR.compare(a.name, b.name))
      .slice(0, 24);
  }, [atQuery, availableTools]);
  const atMatches: AtPaletteItem[] = React.useMemo(() => [
    ...atCommandMatches.map((command): AtPaletteItem => ({ kind: "command", command })),
    ...atToolMatches.map((tool): AtPaletteItem => ({ kind: "tool", tool })),
    ...atFileMatches.map((entry): AtPaletteItem => ({ kind: "file", entry })),
  ], [atCommandMatches, atToolMatches, atFileMatches]);

  // Open/reset the menu whenever the @token appears or changes (mirrors the
  // slash menu: Escape closes it, the next keystroke re-opens it).
  const atTokenKey = atQuery === null ? null : `${atQuery.start}:${atQuery.quoted ? 1 : 0}:${atQuery.query}`;
  useEffect(() => {
    if (atTokenKey === null) {
      setAtMenuOpen(false);
      setAtActiveIndex(0);
      return;
    }
    setAtMenuOpen(true);
    setAtActiveIndex(0);
  }, [atTokenKey]);

  // Fetch the file index when the menu opens. The server caches per cwd for
  // ~10s, so re-opening refreshes cheaply; while typing nothing refetches.
  const atTokenActive = atQuery !== null;
  useEffect(() => {
    if (!atTokenActive || !cwd) return;
    const meta = fileIndexMetaRef.current;
    if (meta && meta.cwd === cwd && Date.now() - meta.fetchedAt < 10_000) return;
    if (fileIndexFetchingRef.current === cwd) return;
    fileIndexFetchingRef.current = cwd;
    const fetchCwd = cwd;
    setFileIndexLoading(true);
    fetch(`/api/file-index?cwd=${encodeURIComponent(fetchCwd)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`file index failed: ${res.status}`);
        return res.json() as Promise<{ files?: string[]; truncated?: boolean }>;
      })
      .then((data) => {
        setFileIndex({ cwd: fetchCwd, entries: buildEntriesFromFiles(data.files ?? []), truncated: !!data.truncated });
        fileIndexMetaRef.current = { cwd: fetchCwd, fetchedAt: Date.now() };
      })
      .catch(() => {
        // Leave any previous index in place; next open retries.
        fileIndexMetaRef.current = null;
      })
      .finally(() => {
        fileIndexFetchingRef.current = null;
        setFileIndexLoading(false);
      });
  }, [atTokenActive, cwd]);

  useEffect(() => {
    if (!atTokenActive || slashCommandsRequestedRef.current || !onLoadSlashCommands) return;
    slashCommandsRequestedRef.current = true;
    Promise.resolve(onLoadSlashCommands()).catch(() => {
      slashCommandsRequestedRef.current = false;
    });
  }, [atTokenActive, onLoadSlashCommands]);

  const applyAtCompletion = useCallback((item: AtPaletteItem) => {
    if (!atQuery) return;
    const ta = textareaRef.current;
    const cursor = ta?.selectionStart ?? value.length;
    const before = value.slice(0, atQuery.start);
    let after = value.slice(cursor);
    if (item.kind === "command") {
      const argumentsText = [before.trim(), after.trim()].filter(Boolean).join(" ");
      const commandPrefix = getSlashCommandInsertText(item.command);
      const nextValue = argumentsText
        ? `${commandPrefix}${argumentsText}`
        : commandPrefix;
      setValue(nextValue);
      setAtQuery(null);
      setAtMenuOpen(false);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(nextValue.length, nextValue.length);
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
      });
      return;
    }
    if (item.kind === "tool") {
      const argumentsText = [before.trim(), after.trim()].filter(Boolean).join(" ");
      const instruction = t("chat.usePluginTool", { name: item.tool.name });
      const nextValue = `${instruction}${argumentsText ? ` ${argumentsText}` : " "}`;
      setValue(nextValue);
      setAtQuery(null);
      setAtMenuOpen(false);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(nextValue.length, nextValue.length);
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
      });
      return;
    }
    const entry = item.entry;
    // Completing inside a quoted token (@"my dir/… with the caret before the
    // closing quote): the replacement carries its own closing quote, so drop
    // the old one right after the caret (mirrors the TUI's applyCompletion).
    if (atQuery.quoted && after.startsWith('"')) {
      after = after.slice(1);
    }
    const insert = buildAtInsertText(entry.path, entry.isDir, atQuery.quoted);
    const newValue = before + insert.text + after;
    const newPos = before.length + insert.cursorOffset;
    setValue(newValue);
    // setValue alone does not fire onChange — re-derive the token here. Files
    // end with a space (token closes, menu hides); directories end with "/"
    // before the caret (token stays open for drill-down into the directory).
    setAtQuery(extractAtQuery(newValue.slice(0, newPos)));
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(newPos, newPos);
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    });
  }, [atQuery, value, t]);

  useEffect(() => {
    if (atActiveIndex >= atMatches.length) {
      setAtActiveIndex(Math.max(0, atMatches.length - 1));
    }
  }, [atMatches.length, atActiveIndex]);

  useEffect(() => {
    atItemRefs.current.length = atMatches.length;
  }, [atMatches.length]);

  useEffect(() => {
    if (!atMenuOpen) return;
    atItemRefs.current[atActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [atActiveIndex, atMenuOpen]);

  useEffect(() => {
    if (historyActiveIndex >= inputHistory.length) {
      setHistoryActiveIndex(Math.max(0, inputHistory.length - 1));
    }
  }, [inputHistory.length, historyActiveIndex]);

  useEffect(() => {
    historyItemRefs.current.length = inputHistory.length;
  }, [inputHistory.length]);

  useEffect(() => {
    if (!historyMenuOpen) return;
    historyItemRefs.current[historyActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [historyActiveIndex, historyMenuOpen]);

  const applyHistoryInput = useCallback((text: string) => {
    setValue(text);
    setHistoryMenuOpen(false);
    setHistoryActiveIndex(0);
    setAtQuery(null);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(text.length, text.length);
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    });
  }, []);

  const applySlashCommand = useCallback((command: SlashCommandPaletteItem) => {
    const nextValue = getSlashCommandInsertText(command);
    setValue(nextValue);
    setSlashMenuOpen(false);
    setSlashActiveIndex(0);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(nextValue.length, nextValue.length);
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    });
  }, []);

  const openCapabilityPalette = useCallback(() => {
    const current = valueRef.current;
    const nextValue = current.trim() ? `${current.replace(/\s*$/, "")} @` : "@";
    valueRef.current = nextValue;
    setValue(nextValue);
    setHistoryMenuOpen(false);
    updateAtQuery(nextValue, nextValue.length);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(nextValue.length, nextValue.length);
    });
  }, [updateAtQuery]);

  const sendQueued = useCallback(() => {
    if (!onFollowUp || builtinCommandPendingRef.current || pendingImageCountRef.current > 0 || fileUploadStatus.phase === "uploading" || tooManyImages) return;
    const msg = value.trim();
    if (!msg && !attachedImages.length) return;
    onAudioUnlock?.();
    if (!attachedImages.length && onBuiltinCommand && canRunBuiltinSlashCommandWhileStreaming(msg)) {
      void runBuiltinCommand(msg);
      return;
    }
    clearInput();
    onFollowUp(msg, attachedImages.length ? attachedImages : undefined);
  }, [value, attachedImages, onBuiltinCommand, onFollowUp, clearInput, onAudioUnlock, runBuiltinCommand, fileUploadStatus.phase, tooManyImages]);

  const updateQueueItem = useCallback(async (id: string, action: QueueAction) => {
    if (!onQueueAction || queueActionPending) return;
    setQueueActionPending(true);
    try {
      await onQueueAction(id, action);
    } finally {
      setQueueActionPending(false);
    }
  }, [onQueueAction, queueActionPending]);

  const getNextSlashIndex = useCallback((direction: "up" | "down" | "left" | "right") => {
    const lastIndex = displayedSlashCommands.length - 1;
    if (lastIndex < 0) return 0;

    if (direction === "left") return Math.max(0, slashActiveIndex - 1);
    if (direction === "right") return Math.min(lastIndex, slashActiveIndex + 1);

    const currentNode = slashItemRefs.current[slashActiveIndex];
    if (!currentNode) {
      return direction === "down"
        ? Math.min(lastIndex, slashActiveIndex + 1)
        : Math.max(0, slashActiveIndex - 1);
    }

    const currentRect = currentNode.getBoundingClientRect();
    const currentX = currentRect.left + currentRect.width / 2;
    const currentY = currentRect.top + currentRect.height / 2;
    let bestIndex = -1;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let index = 0; index <= lastIndex; index += 1) {
      if (index === slashActiveIndex) continue;
      const node = slashItemRefs.current[index];
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      const candidateY = rect.top + rect.height / 2;
      const verticalDelta = candidateY - currentY;
      if (direction === "down" ? verticalDelta <= 4 : verticalDelta >= -4) continue;

      const candidateX = rect.left + rect.width / 2;
      const score = Math.abs(verticalDelta) * 1000 + Math.abs(candidateX - currentX);
      if (score < bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    }

    if (bestIndex >= 0) return bestIndex;
    return direction === "down"
      ? Math.min(lastIndex, slashActiveIndex + 1)
      : Math.max(0, slashActiveIndex - 1);
  }, [displayedSlashCommands.length, slashActiveIndex]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const nativeEvent = e.nativeEvent;
      const sendShortcut = e.key === "Enter" && !e.shiftKey && (!isMobile || e.ctrlKey || e.metaKey);
      const recentlyComposed = Date.now() - lastCompositionEndAtRef.current < COMPOSITION_END_ENTER_GRACE_MS;
      const isComposing =
        isComposingRef.current ||
        nativeEvent.isComposing ||
        nativeEvent.keyCode === 229;

      if (sendShortcut && (isComposing || recentlyComposed)) {
        if (recentlyComposed) e.preventDefault();
        return;
      }

      if (historyMenuOpen && !isComposing) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setHistoryActiveIndex((i) => Math.min(Math.max(0, inputHistory.length - 1), i + 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setHistoryActiveIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setHistoryMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || sendShortcut) && inputHistory[historyActiveIndex]) {
          e.preventDefault();
          applyHistoryInput(inputHistory[historyActiveIndex]);
          return;
        }
      }

      if (slashMenuOpen && slashQuery !== null) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("down"));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("up"));
          return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("right"));
          return;
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("left"));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashMenuOpen(false);
          return;
        }
        const selectedCommand = displayedSlashCommands[slashActiveIndex];
        if (e.key === "Tab" && selectedCommand) {
          e.preventDefault();
          applySlashCommand(selectedCommand);
          return;
        }
        if (sendShortcut && selectedCommand) {
          e.preventDefault();
          const canSubmitNow = !isStreaming
            || (selectedCommand.source === "builtin" && selectedCommand.availableWhileStreaming === true);
          if (canSubmitNow && isExactSlashCommand(value, selectedCommand)) {
            setSlashMenuOpen(false);
            void handleSend();
          } else {
            applySlashCommand(selectedCommand);
          }
          return;
        }
      }

      // @ file menu — skip while composing so IME candidate navigation
      // (arrows/Enter/Tab) is never intercepted.
      if (atMenuOpen && atQuery !== null && !isComposing) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setAtActiveIndex((i) => cycleListIndex(i, atMatches.length, 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setAtActiveIndex((i) => cycleListIndex(i, atMatches.length, -1));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setAtMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || sendShortcut) && atMatches[atActiveIndex]) {
          e.preventDefault();
          applyAtCompletion(atMatches[atActiveIndex]);
          return;
        }
      }

      if (e.key === "ArrowUp" && !isComposing && !isStreaming && inputHistory.length > 0 && value.trim().length === 0) {
        e.preventDefault();
        setSlashMenuOpen(false);
        setAtMenuOpen(false);
        setHistoryActiveIndex(inputHistory.length - 1);
        setHistoryMenuOpen(true);
        return;
      }

      // Esc stops the agent when no slash/@/history menu or IME composition is active.
      if (e.key === "Escape" && !isComposing && isStreaming && onAbort) {
        e.preventDefault();
        onAbort();
        return;
      }

      if (sendShortcut) {
        e.preventDefault();
        if (isStreaming && onFollowUp) {
          sendQueued();
        } else {
          handleSend();
        }
      }
    },
    [isMobile, isStreaming, onFollowUp, onAbort, slashMenuOpen, slashQuery, displayedSlashCommands, slashActiveIndex, applySlashCommand, sendQueued, handleSend, getNextSlashIndex, atMenuOpen, atQuery, atMatches, atActiveIndex, applyAtCompletion, historyMenuOpen, inputHistory, historyActiveIndex, applyHistoryInput, value]
  );

  const handleInput = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItems = items.filter((item) => item.type.startsWith("image/"));
    if (!compact && imageItems.length) {
      e.preventDefault();
      const files = imageItems.map((item) => item.getAsFile()).filter((f): f is File => f !== null);
      processImageFiles(files);
      return;
    }

    const html = e.clipboardData.getData("text/html");
    const text = e.clipboardData.getData("text/plain");
    if (!html || !text) return;
    const document = new DOMParser().parseFromString(html, "text/html");
    const links = Array.from(document.querySelectorAll("a[href]"), (link) => {
      const label = link.textContent ?? "";
      const range = document.createRange();
      range.setStart(document.body, 0);
      range.setEndBefore(link);
      return {
        label,
        href: link.getAttribute("href")?.trim() ?? "",
        occurrence: label ? range.toString().split(label).length - 1 : 0,
      };
    });
    const markdown = replaceLinksWithMarkdown(text, links);
    if (markdown === null) return;

    const ta = e.currentTarget;
    const start = ta.selectionStart;
    const nextValue = ta.value.slice(0, start) + markdown + ta.value.slice(ta.selectionEnd);
    e.preventDefault();
    valueRef.current = nextValue;
    setValue(nextValue);
    setHistoryMenuOpen(false);
    updateAtQuery(nextValue, start + markdown.length);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(start + markdown.length, start + markdown.length);
    });
  }, [compact, processImageFiles, updateAtQuery]);

  useEffect(() => {
    if (slashQuery === null) {
      setSlashMenuOpen(false);
      setSlashActiveIndex(0);
      slashCommandsRequestedRef.current = false;
      return;
    }
    setSlashMenuOpen(true);
    setSlashActiveIndex(0);
    if (!slashCommandsRequestedRef.current && onLoadSlashCommands) {
      slashCommandsRequestedRef.current = true;
      Promise.resolve(onLoadSlashCommands()).catch(() => {
        slashCommandsRequestedRef.current = false;
      });
    }
  }, [slashQuery, onLoadSlashCommands]);

  // Lazy-load skill dormancy (disable-model-invocation) each time the slash
  // palette opens, so toggles made in the skills panel are reflected on the
  // next open. Failures degrade silently to the unannotated palette.
  useEffect(() => {
    if (!slashMenuOpen || !cwd) return;
    const requestCwd = cwd;
    let cancelled = false;
    setSkillDormancyState({ cwd: requestCwd, values: {} });
    fetch(`/api/skills?cwd=${encodeURIComponent(requestCwd)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`skills fetch failed: ${res.status}`);
        return res.json() as Promise<Partial<SkillsResponse>>;
      })
      .then((data) => {
        if (cancelled) return;
        const dormancy: Record<string, boolean> = {};
        for (const skill of data.skills ?? []) dormancy[skill.name] = skill.disableModelInvocation;
        setSkillDormancyState({ cwd: requestCwd, values: dormancy });
      })
      .catch(() => {
        if (!cancelled) setSkillDormancyState({ cwd: requestCwd, values: {} });
      });
    return () => {
      cancelled = true;
    };
  }, [slashMenuOpen, cwd]);

  useEffect(() => {
    if (slashActiveIndex >= displayedSlashCommands.length) {
      setSlashActiveIndex(Math.max(0, displayedSlashCommands.length - 1));
    }
  }, [displayedSlashCommands.length, slashActiveIndex]);

  useEffect(() => {
    slashItemRefs.current.length = displayedSlashCommands.length;
  }, [displayedSlashCommands.length]);

  useEffect(() => {
    if (!slashMenuOpen) return;
    slashItemRefs.current[slashActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [slashActiveIndex, slashMenuOpen]);

  useLayoutEffect(() => {
    if (!slashMenuOpen || slashQuery === null) {
      setSlashMenuMaxHeight(null);
      return;
    }
    const menu = slashMenuRef.current;
    if (!menu) return;
    return subscribeUpwardMenuMaxHeight(menu, (nextHeight) => {
      setSlashMenuMaxHeight((current) => current === nextHeight ? current : nextHeight);
    });
  }, [slashMenuOpen, slashQuery]);

  useLayoutEffect(() => {
    if (!atMenuOpen || atQuery === null) {
      setAtMenuMaxHeight(null);
      return;
    }
    const menu = atMenuRef.current;
    if (!menu) return;
    return subscribeUpwardMenuMaxHeight(menu, (nextHeight) => {
      setAtMenuMaxHeight((current) => current === nextHeight ? current : nextHeight);
    });
  }, [atMenuOpen, atQuery]);

  // Build model options: prefer modelList (has provider info), fallback to modelNames
  const modelOptions: ModelSelectorOption[] = (() => {
    if (modelList && modelList.length > 0) {
      return modelList.map((m) => ({ provider: m.provider, providerDisplayName: m.providerDisplayName, modelId: m.id, name: m.name }));
    }
    return Object.entries(modelNames ?? {}).map(([modelId, name]) => ({
      provider: model?.provider ?? "unknown",
      modelId,
      name,
    }));
  })();
  const imageModelOptions: ModelSelectorOption[] = (imageModelList ?? []).map((item) => ({
    provider: item.provider,
    providerDisplayName: item.providerDisplayName,
    modelId: item.id,
    name: item.name,
  }));

  const compactSavedTokens = compactResult
    ? Math.max(0, compactResult.tokensBefore - compactResult.estimatedTokensAfter)
    : 0;
  const compactResultText = compactResult
    ? `${compactResult.reason && compactResult.reason !== "manual" ? `${compactResult.reason[0].toUpperCase()}${compactResult.reason.slice(1)} ` : t("chat.compacted")} ${formatTokenCount(compactResult.tokensBefore)} -> ${formatTokenCount(compactResult.estimatedTokensAfter)} tokens (${t("chat.tokensSaved", { saved: formatTokenCount(compactSavedTokens) })})`
    : null;
  const reasoningModelName = model
    ? modelOptions.find((option) => option.provider === model.provider && option.modelId === model.modelId)?.name || model.modelId
    : undefined;

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (historyMenuRef.current && !historyMenuRef.current.contains(e.target as Node) && !textareaRef.current?.contains(e.target as Node)) {
        setHistoryMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <fieldset
      disabled={builtinCommandPending && !isStreaming}
      aria-busy={builtinCommandPending}
      style={{
        flexShrink: 0,
        minWidth: 0,
        margin: 0,
        border: 0,
        background: "transparent",
        padding: compact ? 0 : "0 0 8px",
        opacity: builtinCommandPending ? 0.5 : 1,
        transition: "opacity 0.15s",
      }}
    >
      {/* Hidden file input */}
      {!compact && <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          processComposerFiles(files);
          e.target.value = "";
        }}
      />}
      <div className={compact ? undefined : "chat-reading-column"}>
        <ModelErrorBanner error={modelError} />
        <ModelScopeWarningBanner warnings={modelScopeWarnings} />
        {showImageUnsupportedWarning && (() => {
          const entry = modelList?.find((m) => m.provider === model?.provider && m.id === model?.modelId);
          return (
            <ModelNoticeBanner
              tone="warning"
              title={t("chat.imageNotSupportedTitle")}
              body={t("chat.imageNotSupportedBody", { model: entry?.name || model?.modelId || "" })}
              onClose={() => setImageWarningDismissed(true)}
            />
          );
        })()}
        {queueItems.length > 0 && (
          <div aria-label={t("chat.pendingMessages", { count: queueItems.length })} className="mb-2 grid gap-1.5">
            {queueItems.map((item, index) => (
              <QueuedMessageRow
                key={item.id ?? item.kind + "-" + index}
                item={item}
                busy={queueActionPending}
                canSteer={Boolean(onFollowUp)}
                onAction={onQueueAction ? updateQueueItem : undefined}
              />
            ))}
          </div>
        )}
        {/* Retry banner */}
        {retryInfo && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "rgba(234,179,8,0.08)", border: "1px solid rgba(234,179,8,0.25)",
            borderRadius: 6, fontSize: 12, color: "rgba(180,130,0,0.9)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
             {t("chat.retrying", { attempt: retryInfo.attempt, max: retryInfo.maxAttempts })}{retryInfo.errorMessage && <span style={{ opacity: 0.7, marginLeft: 4 }}>— {retryInfo.errorMessage}</span>}
          </div>
        )}
        {compactResultText && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "rgba(16,185,129,0.08)", border: "1px solid rgba(16,185,129,0.24)",
            borderRadius: 6, fontSize: 12, color: "rgba(5,150,105,0.95)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {compactResultText}
          </div>
        )}
        {compactError && (
          <div
            role="alert"
            style={{
              marginBottom: 8,
              padding: "7px 10px",
              background: "rgba(239,68,68,0.07)",
              border: "1px solid rgba(239,68,68,0.3)",
              borderRadius: 6,
              color: "#ef4444",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {compactError}
          </div>
        )}
        {uploadStatus.phase !== "idle" && (
          <div
            role={uploadStatus.phase === "error" ? "alert" : "status"}
            aria-live="polite"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginBottom: 6,
              color: uploadStatus.phase === "error"
                ? "#ef4444"
                : uploadStatus.phase === "success"
                  ? "#22c55e"
                  : "var(--text-muted)",
              fontSize: 11,
              lineHeight: 1.4,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {uploadStatus.phase === "uploading" && (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" style={{ animation: "spin 0.8s linear infinite", flexShrink: 0 }} aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-5.7-8.4" />
              </svg>
            )}
            <span>{uploadStatus.message}</span>
          </div>
        )}
        {/* Image previews */}
        {attachedImages.length > 0 && (
          <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
            {attachedImages.map((img, i) => (
              <div key={i} style={{ position: "relative", flexShrink: 0 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.previewUrl}
                  alt=""
                  title={img.filePath}
                  style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)", display: "block" }}
                />
                <button
                  onClick={() => removeImage(i)}
                  style={{
                    position: "absolute", top: -4, right: -4,
                    width: 16, height: 16, borderRadius: "50%",
                    background: "var(--bg-panel)", border: "1px solid var(--border)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    cursor: "pointer", padding: 0, color: "var(--text-muted)",
                  }}
                >
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <line x1="1" y1="1" x2="7" y2="7" /><line x1="7" y1="1" x2="1" y2="7" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Main input */}
        <div style={{ position: "relative", minWidth: 0 }}>
          {historyMenuOpen && inputHistory.length > 0 && (
            <div
              ref={historyMenuRef}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: "calc(100% + 8px)",
                zIndex: 120,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                boxShadow: "0 -6px 20px rgba(0,0,0,0.12)",
                overflow: "hidden",
                maxHeight: "min(44vh, 360px)",
              }}
            >
              <div
                title={t("chat.inputHistory")}
                style={{
                  height: 30,
                  padding: "0 10px",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  color: "var(--text-dim)",
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3 12a9 9 0 1 0 3-6.7" />
                  <path d="M3 4v5h5" />
                  <path d="M12 7v5l3 2" />
                </svg>
              </div>
              <div style={{ maxHeight: "calc(min(44vh, 360px) - 31px)", overflowY: "auto", padding: 4 }}>
                {inputHistory.map((item, index) => {
                  const active = index === historyActiveIndex;
                  return (
                    <button
                      key={`${index}:${item}`}
                      ref={(node) => {
                        historyItemRefs.current[index] = node;
                      }}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        applyHistoryInput(item);
                      }}
                      onMouseEnter={() => setHistoryActiveIndex(index)}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 8,
                        padding: "7px 8px",
                        border: "none",
                        borderRadius: 6,
                        background: active ? "var(--bg-selected)" : "none",
                        color: "var(--text)",
                        cursor: "pointer",
                        textAlign: "left",
                        fontSize: 12.5,
                        lineHeight: 1.45,
                      }}
                    >
                      <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)", paddingTop: 1 }}>
                        {index + 1}
                      </span>
                      <span style={{ minWidth: 0, display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflow: "hidden", overflowWrap: "anywhere" }}>
                        {item}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {slashMenuOpen && slashQuery !== null && (
            <div
              ref={slashMenuRef}
              className="ui-glass-menu"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: "calc(100% + 8px)",
                zIndex: 120,
                overflow: "hidden",
                boxSizing: "border-box",
                display: "flex",
                flexDirection: "column",
                maxHeight: slashMenuMaxHeight === null
                  ? "min(72.8vh, 598px)"
                  : `min(72.8vh, 598px, ${slashMenuMaxHeight}px)`,
              }}
            >
              <div
                style={{
                  padding: "8px 12px",
                  borderBottom: "0.5px solid color-mix(in srgb, var(--border) 70%, transparent)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  fontSize: 11,
                  color: "var(--text-dim)",
                  flexShrink: 0,
                }}
              >
                 <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                   <span>{slashCommandsLoading ? t("chat.loadingCommands") : t("chat.slashCommands", { label: slashCommandCountLabel })}</span>
                   {!slashCommandsLoading && <small style={{ color: "var(--text-dim)", fontSize: 10 }}>{t("chat.slashHelp")}</small>}
                 </span>
                 <span style={{ fontFamily: "var(--font-mono)" }}>{t("chat.tabEnter")}</span>
              </div>
              <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: 10 }}>
                {!slashCommandsLoading && filteredSlashCommands.length === 0 ? (
                  <div style={{ padding: "2px 2px 4px", fontSize: 12, color: "var(--text-dim)" }}>
                     {t("chat.noCommands")}
                  </div>
                ) : (
                  groupedSlashCommands.map((group) => (
                    <section key={group.source} style={{ marginBottom: 12 }}>
                      <div
                        style={{
                          position: "sticky",
                          top: -10,
                          zIndex: 1,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                          padding: "4px 0 6px",
                          background: "var(--bg)",
                          color: "var(--text-dim)",
                          fontSize: 10,
                          fontWeight: 600,
                          textTransform: "uppercase",
                        }}
                      >
                           <span>{t(SLASH_SOURCE_GROUP_LABEL_KEYS[group.source])}</span>
                        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 500 }}>{group.items.length}</span>
                      </div>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                          gap: 8,
                        }}
                      >
                        {group.items.map(({ command, index }) => {
                          const active = index === slashActiveIndex;
                          const dormant = isDormantSkillCommand(command, skillDormancy);
                          const presentation = getSlashCommandPresentation(command, t);
                          return (
                            <button
                              key={`${command.source}:${command.name}`}
                              ref={(node) => {
                                slashItemRefs.current[index] = node;
                              }}
                              type="button"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                applySlashCommand(command);
                              }}
                              onMouseEnter={() => setSlashActiveIndex(index)}
                              title={presentation.description}
                              data-slash-source={command.source}
                              data-slash-mode={presentation.mode}
                              style={{
                                width: "100%",
                                minWidth: 0,
                                minHeight: 58,
                                display: "flex",
                                flexDirection: "column",
                                gap: 4,
                                justifyContent: "center",
                                padding: "9px 10px",
                                border: `0.5px solid ${active ? "var(--accent)" : "color-mix(in srgb, var(--border) 75%, transparent)"}`,
                                borderRadius: 10,
                                background: active ? "var(--bg-selected)" : "color-mix(in srgb, var(--bg-panel) 55%, transparent)",
                                color: "var(--text)",
                                cursor: "pointer",
                                textAlign: "left",
                                boxShadow: active ? "0 0 0 1px color-mix(in srgb, var(--accent) 28%, transparent)" : "none",
                              }}
                            >
                              <span style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                                <span style={{
                                  minWidth: 0,
                                  fontSize: 13,
                                  fontFamily: "var(--font-mono)",
                                  overflowWrap: "anywhere",
                                  wordBreak: "break-word",
                                  color: dormant ? "var(--text-dim)" : undefined,
                                }}>
                                  {presentation.label}
                                </span>
                                <span style={{
                                  flexShrink: 0,
                                  padding: "2px 5px",
                                  border: "1px solid color-mix(in srgb, var(--border) 75%, transparent)",
                                  borderRadius: 999,
                                  color: "var(--text-dim)",
                                  fontSize: 9,
                                  lineHeight: 1.25,
                                  whiteSpace: "nowrap",
                                }}>
                                  {dormant
                                    ? t("chat.dormant")
                                    : t(presentation.mode === "direct" ? "chat.directAction" : "chat.assistantInstruction")}
                                </span>
                              </span>
                              {presentation.description && (
                                <span style={{
                                  display: "-webkit-box",
                                  WebkitBoxOrient: "vertical",
                                  WebkitLineClamp: 2,
                                  overflow: "hidden",
                                  fontSize: 11,
                                  lineHeight: 1.35,
                                  color: "var(--text-dim)",
                                }}>
                                  {presentation.description}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  ))
                )}
              </div>
            </div>
          )}
          {atMenuOpen && atQuery !== null && (() => {
            const indexLoading = fileIndexLoading && (!fileIndex || fileIndex.cwd !== cwd);
             const matchCountLabel = atMatches.length === 1 ? t("chat.match") : t("chat.matches", { count: atMatches.length });
            // With a truncated index, local results are provisional — the
            // debounced server search over the full listing replaces them.
            const truncatedHint = fileIndex?.truncated && !serverResultInUse
               ? (atQuery.query ? t("chat.searchingAll") : t("chat.indexTruncated"))
              : "";
            return (
              <div
                ref={atMenuRef}
                className="ui-glass-menu"
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: "calc(100% + 8px)",
                  zIndex: 120,
                  overflow: "hidden",
                  boxSizing: "border-box",
                  display: "flex",
                  flexDirection: "column",
                  maxHeight: atMenuMaxHeight === null
                    ? "min(48vh, 400px)"
                    : `min(48vh, 400px, ${atMenuMaxHeight}px)`,
                }}
              >
                <div
                  style={{
                    padding: "8px 12px",
                    borderBottom: "0.5px solid color-mix(in srgb, var(--border) 70%, transparent)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    fontSize: 11,
                    color: "var(--text-dim)",
                    flexShrink: 0,
                  }}
                >
                  <span>
                    {t("chat.capabilitiesAndFiles", { label: matchCountLabel, hint: truncatedHint })}
                    {indexLoading ? ` · ${t("chat.loadingFiles")}` : ""}
                  </span>
                   <span style={{ fontFamily: "var(--font-mono)" }}>{t("chat.tabEnter")}</span>
                </div>
                <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: 4 }}>
                  {!indexLoading && atMatches.length === 0 ? (
                    <div style={{ padding: "6px 8px", fontSize: 12, color: "var(--text-dim)" }}>
                       {needsServerSearch && !serverResultInUse ? t("chat.searching") : t("chat.noMatchingCapabilitiesOrFiles")}
                    </div>
                  ) : (
                    atMatches.map((item, index) => {
                      const active = index === atActiveIndex;
                      if (item.kind === "command") {
                        const command = item.command;
                        const skill = command.source === "skill";
                        const presentation = getSlashCommandPresentation(command, t);
                        return (
                          <button
                            key={`command:${command.source}:${command.name}`}
                            ref={(node) => { atItemRefs.current[index] = node; }}
                            type="button"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              applyAtCompletion(item);
                            }}
                            onMouseEnter={() => setAtActiveIndex(index)}
                            style={{
                              width: "100%",
                              minHeight: 46,
                              display: "flex",
                              alignItems: "center",
                              gap: 9,
                              padding: "7px 8px",
                              border: "none",
                              borderRadius: 9,
                              background: active ? "var(--bg-selected)" : "none",
                              color: "var(--text)",
                              cursor: "pointer",
                              textAlign: "left",
                            }}
                          >
                            <span style={{
                              width: 28, height: 28, display: "grid", placeItems: "center", flexShrink: 0,
                              borderRadius: 9,
                              color: skill ? "var(--accent)" : "#8b5cf6",
                              background: skill
                                ? "color-mix(in srgb, var(--accent) 11%, var(--assistant-bg))"
                                : "color-mix(in srgb, #8b5cf6 10%, var(--assistant-bg))",
                              fontSize: 13, fontWeight: 700,
                            }} aria-hidden="true">
                              {skill ? "✦" : "⌘"}
                            </span>
                            <span style={{ minWidth: 0, flex: 1 }}>
                              <strong style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 600 }}>
                                {presentation.label}
                              </strong>
                              {presentation.description && (
                                <small style={{ display: "block", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: 10.5 }}>
                                  {presentation.description}
                                </small>
                              )}
                            </span>
                            <span style={{ flexShrink: 0, padding: "2px 7px", borderRadius: 999, background: "var(--bg-subtle)", color: "var(--text-dim)", fontSize: 9.5 }}>
                              {skill ? t("chat.assistantInstruction") : t(presentation.mode === "direct" ? "chat.directAction" : "chat.assistantInstruction")}
                            </span>
                          </button>
                        );
                      }
                      if (item.kind === "tool") {
                        const tool = item.tool;
                        return (
                          <button
                            key={`tool:${tool.name}`}
                            ref={(node) => { atItemRefs.current[index] = node; }}
                            type="button"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              applyAtCompletion(item);
                            }}
                            onMouseEnter={() => setAtActiveIndex(index)}
                            style={{
                              width: "100%",
                              minHeight: 46,
                              display: "flex",
                              alignItems: "center",
                              gap: 9,
                              padding: "7px 8px",
                              border: "none",
                              borderRadius: 9,
                              background: active ? "var(--bg-selected)" : "none",
                              color: "var(--text)",
                              cursor: "pointer",
                              textAlign: "left",
                            }}
                          >
                            <span
                              aria-hidden="true"
                              style={{
                                width: 28,
                                height: 28,
                                display: "grid",
                                placeItems: "center",
                                flexShrink: 0,
                                borderRadius: 9,
                                color: "#8b5cf6",
                                background: "color-mix(in srgb, #8b5cf6 10%, var(--assistant-bg))",
                              }}
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 22v-5" /><path d="M9 8V2" /><path d="M15 8V2" /><path d="M18 8v4a6 6 0 0 1-12 0V8Z" />
                              </svg>
                            </span>
                            <span style={{ minWidth: 0, flex: 1 }}>
                              <strong style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 600 }}>
                                {tool.name}
                              </strong>
                              {tool.description && (
                                <small style={{ display: "block", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: 10.5 }}>
                                  {tool.description}
                                </small>
                              )}
                            </span>
                            <span style={{ flexShrink: 0, padding: "2px 7px", borderRadius: 999, background: "color-mix(in srgb, #8b5cf6 8%, var(--bg-subtle))", color: "#7c3aed", fontSize: 9.5 }}>
                              {t("chat.pluginTool")}
                            </span>
                          </button>
                        );
                      }
                      const entry = item.entry;
                      const name = entry.path.split("/").pop() ?? entry.path;
                      const dirPrefix = entry.path.slice(0, entry.path.length - name.length);
                      return (
                        <button
                          key={`${entry.isDir ? "d" : "f"}:${entry.path}`}
                          ref={(node) => {
                            atItemRefs.current[index] = node;
                          }}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            applyAtCompletion(item);
                          }}
                          onMouseEnter={() => setAtActiveIndex(index)}
                          style={{
                            width: "100%",
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "6px 8px",
                            border: "none",
                            borderRadius: 6,
                            background: active ? "var(--bg-selected)" : "none",
                            color: "var(--text)",
                            cursor: "pointer",
                            textAlign: "left",
                            fontSize: 12.5,
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
                            {entry.isDir ? <FolderIcon size={14} /> : getFileIcon(name, 14)}
                          </span>
                          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {dirPrefix && <span style={{ color: "var(--text-dim)" }}>{dirPrefix}</span>}
                            {name}
                            {entry.isDir && <span style={{ color: "var(--text-dim)" }}>/</span>}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })()}
          <div
            className="ui-composer"
            style={{
              minWidth: 0,
              display: "flex",
              flexDirection: compact ? "column" : "row",
              gap: 8,
              alignItems: compact ? "stretch" : "center",
              background: "var(--assistant-bg)",
              border: compact ? "none" : `1px solid ${bashMode ? "var(--tool-bg)" : isStreaming && onFollowUp
                ? "rgba(234,179,8,0.4)"
                : "color-mix(in srgb, var(--border) 70%, transparent)"}`,
              borderRadius: compact ? 0 : 22,
              padding: compact ? 0 : "10px 10px 10px 16px",
              boxShadow: compact ? "none" : "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10)",
              transition: "border-color 0.15s, background 0.15s, box-shadow 0.15s",
            } as React.CSSProperties}
          >
          <textarea
            ref={textareaRef}
            className="chat-input-textarea"
            aria-label={compact ? t("chat.quoteQuestion") : undefined}
            value={value}
            onChange={(e) => {
              valueRef.current = e.target.value;
              setValue(e.target.value);
              setHistoryMenuOpen(false);
              updateAtQuery(e.target.value, e.target.selectionStart);
            }}
            onSelect={(e) => {
              const el = e.currentTarget;
              updateAtQuery(el.value, el.selectionStart);
            }}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              isComposingRef.current = false;
              lastCompositionEndAtRef.current = Date.now();
              const el = e.currentTarget;
              updateAtQuery(el.value, el.selectionStart);
            }}
            onInput={handleInput}
            onPaste={handlePaste}
            placeholder={
              isStreaming && onFollowUp
                ? t("chat.queuePlaceholder")
                : isStreaming ? t("chat.agentPlaceholder")
                : messagePlaceholder ?? t("chat.messagePlaceholder")
            }
            rows={1}
            style={{
              flex: compact ? "none" : 1,
              minWidth: 0,
              width: "100%",
              background: "none",
              border: "none",
              outline: "none",
              resize: "none",
              color: "var(--text)",
              fontSize: "var(--chat-content-font-size, 14px)",
              lineHeight: 1.6,
              fontFamily: "inherit",
              minHeight: compact ? 96 : 24,
              maxHeight: 200,
              overflow: "auto",
            }}
          />

          <div className="composer-send-actions">
            {isStreaming && !compact && (
              <button
                type="button"
                className="composer-stop-button"
                onClick={onAbort}
                title={stopLabel ?? t("chat.stopAgent")}
                aria-label={stopLabel ?? t("chat.stopAgent")}
                aria-keyshortcuts="Escape"
              >
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="currentColor" />
                </svg>
                {t("chat.stop")}
              </button>
            )}
            {isStreaming && !onFollowUp ? (
              <span className="ui-thinking-dots" aria-hidden="true"><span /><span /><span /></span>
            ) : (
              <button
                type="button"
                onClick={isStreaming ? sendQueued : handleSend}
                disabled={!canSubmitMessage}
                title={isStreaming ? t("chat.followUpHint") : undefined}
                aria-keyshortcuts={isMobile ? "Control+Enter Meta+Enter" : "Enter"}
                className="ui-send-btn"
                style={{
                  flexShrink: 0,
                  display: "flex", alignItems: "center", gap: 6,
                  background: canSubmitMessage ? "var(--accent)" : "var(--bg-panel)",
                  border: "none",
                  borderRadius: 999,
                  color: canSubmitMessage ? "var(--accent-contrast)" : "var(--text-dim)",
                  cursor: canSubmitMessage ? "pointer" : "not-allowed",
                  fontSize: 13,
                  fontWeight: 600,
                  letterSpacing: "-0.01em",
                  boxShadow: canSubmitMessage ? "0 1px 3px color-mix(in srgb, var(--accent) 25%, transparent)" : "none",
                }}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="2" y1="7" x2="11" y2="7" />
                  <polyline points="7.5 3 12 7 7.5 11" />
                </svg>
                {t(isStreaming ? "chat.queueMessage" : "chat.send")}
              </button>
            )}
          </div>
          </div>
        </div>

        {/* Bash mode status label */}
        {bashMode && (
          <div className="text-xs px-2 py-1" style={{ color: bashExcluded ? "var(--text-muted)" : "var(--accent)", marginTop: 4 }}>
             {t("chat.shell")} · {bashExcluded ? t("chat.outputLocal") : t("chat.outputModel")}
          </div>
        )}

        {!compact && <div className="composer-controls">

          <div className="composer-controls-left">
            <button
              onClick={() => fileInputRef.current?.click()}
              title={t("chat.attachFiles")}
              aria-label={t("chat.attachFiles")}
              disabled={attachmentsUploading}
              style={{
                flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                width: 32, height: 32, padding: 0,
                background: "none", border: "none",
                borderRadius: 9,
                color: attachedImages.length || fileUploadStatus.phase === "success" ? "var(--accent)" : "var(--text-muted)",
                cursor: attachmentsUploading ? "wait" : "pointer",
                opacity: attachmentsUploading ? 0.7 : 1,
                transition: "background 0.12s, color 0.12s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = attachedImages.length || fileUploadStatus.phase === "success" ? "var(--accent)" : "var(--text)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "none";
                e.currentTarget.style.color = attachedImages.length || fileUploadStatus.phase === "success" ? "var(--accent)" : "var(--text-muted)";
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d="m21.4 11.6-8.9 8.9a6 6 0 0 1-8.5-8.5l9.6-9.6a4 4 0 1 1 5.7 5.7l-9.6 9.6a2 2 0 0 1-2.8-2.8l8.9-8.9" />
              </svg>
            </button>
            <button
              type="button"
              onClick={openCapabilityPalette}
              title={t("chat.findCapabilities")}
              aria-label={t("chat.findCapabilities")}
              style={{
                flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                width: 32, height: 32, padding: 0,
                background: atMenuOpen ? "var(--bg-selected)" : "none", border: "none",
                borderRadius: 9,
                color: atMenuOpen ? "var(--accent)" : "var(--text-muted)",
                cursor: "pointer",
                fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 650,
                transition: "background 0.12s, color 0.12s",
              }}
            >
              @
            </button>
            {onSoundToggle && (
              <button
                type="button"
                className="composer-sound-button"
                onClick={onSoundToggle}
                title={t("chat.completionSound")}
                aria-label={t("chat.completionSound")}
                aria-pressed={soundEnabled ?? false}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  {soundEnabled ? (
                    <><path d="M15.54 8.46a5 5 0 0 1 0 7.07" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" /></>
                  ) : (
                    <path d="m17 9 6 6m0-6-6 6" />
                  )}
                </svg>
              </button>
            )}
            {showWorkMode && <WorkModeSelector
              mode={workMode ?? "auto"}
              pendingMode={pendingWorkMode}
              disabled={workModeDisabled ?? false}
              onChanged={onNewWorkModeChanged}
              onSessionModeChange={onSessionWorkModeChange}
              onResolvedMode={onResolvedWorkMode}
            />}
            {approvalPolicyControl}
            {onSubagentModeChange && (
              <label className="chat-subagent-mode" title={t(subagentModeDisabled
                ? "chat.subagentModeUnavailable"
                : `chat.subagentModeHint.${subagentMode ?? DEFAULT_SUBAGENT_MODE}`)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="5" y="7" width="14" height="11" rx="2" /><path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" />
                </svg>
                <select
                  aria-label={t("chat.subagentMode")}
                  disabled={subagentModeDisabled || isStreaming}
                  value={subagentModeDisabled ? "off" : subagentMode ?? DEFAULT_SUBAGENT_MODE}
                  onChange={(event) => onSubagentModeChange(event.target.value as SubagentMode)}
                >
                  {SUBAGENT_MODES.map((mode) => <option key={mode} value={mode}>{t(`chat.subagentMode.${mode}`)}</option>)}
                </select>
              </label>
            )}
            {/* Model selector - visible always, disabled while the session or switch is busy */}
            {(modelOptions.length > 0 || model || modelError) && onModelChange && (
              <ModelSelector
                options={modelOptions}
                value={model}
                onChange={onModelChange}
                disabled={isStreaming}
                busy={modelSwitching}
                isAutoSelection={isAutoModelSelection}
              />
            )}
            {imageModelOptions.length > 0 && onImageModelChange && (
              <ModelSelector
                options={imageModelOptions}
                value={imageModel}
                onChange={onImageModelChange}
                disabled={isStreaming}
                busy={imageModelSwitching}
                selectedLabel={imageModel ? t("chat.imageModelLabel", { model: imageModel.modelId }) : t("chat.selectImageModel")}
                emptyLabel={t("chat.selectImageModel")}
                ariaLabel={t("chat.selectSessionImageModel")}
              />
            )}
          </div>

          {onThinkingLevelChange && (
            <ReasoningControl
              key={model ? `${model.provider}:${model.modelId}` : undefined}
              modelName={reasoningModelName}
              level={thinkingLevel ?? "auto"}
              supportedLevels={availableThinkingLevels}
              levelMap={thinkingLevelMap}
              onChange={onThinkingLevelChange}
              disabled={isStreaming || modelSwitching || submissionDisabled || builtinCommandPending}
            />
          )}
        </div>}
      </div>
    </fieldset>
  );
});
