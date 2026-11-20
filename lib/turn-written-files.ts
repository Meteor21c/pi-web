import type { AssistantContentBlock, ToolResultMessage } from "./types";
import { resolveLocalFileHref, resolveLocalFilePath } from "./file-links";
import { isEditToolName, isWriteToolName } from "./tool-names";

export interface WrittenFile {
  /** Resolved absolute path of a file this turn wrote. */
  filePath: string;
  change?: "created" | "modified" | "generated";
}

export const TOOL_FILE_CHANGE_KEY = "meteoragentFileChange";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readToolPath(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  const value = input.file_path ?? input.path;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isAbsoluteFilePath(path: string): boolean {
  return path.startsWith("/") || /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\");
}

function readRecordedChange(details: unknown): WrittenFile | undefined {
  const change = asRecord(asRecord(details)?.[TOOL_FILE_CHANGE_KEY]);
  if (!change || typeof change.filePath !== "string" || !isAbsoluteFilePath(change.filePath)) return undefined;
  if (change.change !== "created" && change.change !== "modified") return undefined;
  const filePath = resolveLocalFilePath(change.filePath);
  return filePath ? { filePath, change: change.change } : undefined;
}

function generatedImageFiles(details: unknown, cwd?: string): WrittenFile[] {
  const images = asRecord(details)?.images;
  if (!Array.isArray(images)) return [];
  return images.flatMap((image) => {
    const imageData = asRecord(image);
    const localUrl = typeof imageData?.url === "string" && /^file:/i.test(imageData.url) ? imageData.url : undefined;
    const output = typeof image === "string" ? image : imageData?.path ?? localUrl;
    if (typeof output !== "string") return [];
    const outputPath = output.trim();
    if (!outputPath || outputPath.startsWith("/api/") || outputPath.startsWith("/_next/")) return [];
    if (/^file:\/\/[^/]/i.test(outputPath) && !/^file:\/\/localhost\//i.test(outputPath)) return [];
    const filePath = /^file:/i.test(outputPath)
      ? resolveLocalFileHref(outputPath, cwd)
      : /^(?:[a-z][\w+.-]*:|\/\/)/i.test(outputPath) && !/^[a-z]:[\\/]/i.test(outputPath)
        ? null
        : resolveLocalFilePath(outputPath, cwd);
    return filePath ? [{ filePath, change: "generated" as const }] : [];
  });
}

/**
 * Collect files from successful tools in one turn, in first-seen order.
 *
 * Older write/edit results carry paths in their arguments. Current shell
 * output paths require recorded filesystem evidence. Generated images use the
 * extension's local artifact paths.
 */
export function extractTurnWrittenFiles(
  content: AssistantContentBlock[],
  toolResults: Map<string, ToolResultMessage> | undefined,
  cwd?: string,
): WrittenFile[] {
  const writtenFiles = new Map<string, WrittenFile>();
  const add = (file: WrittenFile) => {
    const key = /^(?:[a-z]:\/|\/\/)/i.test(file.filePath) ? file.filePath.toLowerCase() : file.filePath;
    const previous = writtenFiles.get(key);
    if (!previous || (!previous.change && file.change)) writtenFiles.set(key, file);
  };

  for (const block of content) {
    if (block.type !== "toolCall") continue;
    const result = toolResults?.get(block.toolCallId);
    if (!result || result.isError) continue;

    if (block.toolName === "image_generate") {
      for (const file of generatedImageFiles(result.details, cwd)) add(file);
      continue;
    }

    if (block.toolName === "write" || block.toolName === "bash") {
      const recorded = readRecordedChange(result.details);
      if (recorded) {
        add(recorded);
        continue;
      }
    }

    const edited = isEditToolName(block.toolName);
    if (!edited && !isWriteToolName(block.toolName)) continue;
    const operation = block.input?.command ?? block.input?.operation;
    if (typeof operation === "string" && /^(?:view|read|open|show)$/i.test(operation.trim())) continue;
    const rawPath = readToolPath(block.input);
    if (!rawPath) continue;

    // Tool arguments are filesystem paths, not hrefs: preserve characters such
    // as #, ?, and :digits that have special meaning in links and source refs.
    const filePath = resolveLocalFilePath(rawPath, cwd);
    if (!filePath) continue;

    add(block.toolName === "edit" ? { filePath, change: "modified" } : { filePath });
  }

  return [...writtenFiles.values()];
}
