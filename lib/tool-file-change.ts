import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { isPathWithinRoots } from "./path-security";
import type { AgentSessionLike } from "./pi-types";
import { TOOL_FILE_CHANGE_KEY, type WrittenFile } from "./turn-written-files";

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** A single command with a single literal output redirect. Skip shell expansions and compound syntax. */
function shellOutputPath(command: unknown): string | undefined {
  if (typeof command !== "string" || command.length > 8_192 || /[\r\n]/.test(command.trim())) return undefined;
  const line = command.trim();
  const nextToken = /[ \t]+|>>?|'[^']*'|"[^"\\$`]*"|[^\s'"\\$`;&|<>()>#]+/y;
  let hasCommand = false;
  for (let offset = 0; offset < line.length;) {
    nextToken.lastIndex = offset;
    const token = nextToken.exec(line)?.[0];
    if (!token) return undefined;
    offset = nextToken.lastIndex;
    if (token !== ">" && token !== ">>") {
      if (token.trim()) hasCommand = true;
      continue;
    }
    if (!hasCommand) return undefined;
    const literal = line.slice(offset).trim().match(/^(?:'([^']+)'|"([^"\\$`]+)"|([a-z\d_./-]+))$/i);
    return literal?.[1] ?? literal?.[2] ?? literal?.[3];
  }
  return undefined;
}

type FileState = { inode: bigint; size: bigint; modifiedAt: bigint } | "missing";

function fileState(path: string, realRoot: Set<string>): FileState | undefined {
  try {
    const realPath = realpathSync(path);
    if (!isPathWithinRoots(realPath, realRoot)) return undefined;
    const stat = lstatSync(realPath, { bigint: true });
    if (!stat.isFile()) return undefined;
    return { inode: stat.ino, size: stat.size, modifiedAt: stat.mtimeNs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    return undefined;
  }
}

/** Attach small proof of a local write to the tool result the SDK persists. */
export function installToolFileChangeTracking(session: AgentSessionLike): () => void {
  const pending = new Map<string, { path: string; before: FileState; root: Set<string> }>();
  const previousBefore = session.agent.beforeToolCall;
  const previousAfter = session.agent.afterToolCall;

  session.agent.beforeToolCall = async (context, signal) => {
    const decision = await previousBefore?.(context, signal);
    if (decision?.block || signal?.aborted) return decision;
    const args = object(context.args);
    const rawPath = context.toolCall.name === "write" ? args?.path
      : context.toolCall.name === "bash" ? shellOutputPath(args?.command) : undefined;
    if (typeof rawPath !== "string" || !rawPath || rawPath.startsWith("~") || rawPath.includes("\0")) return decision;
    const cwd = session.sessionManager.getCwd();
    const path = resolve(cwd, rawPath);
    if (!isPathWithinRoots(path, new Set([cwd]))) return decision;
    let root: Set<string>;
    try {
      root = new Set([realpathSync(cwd)]);
    } catch {
      return decision;
    }
    const before = fileState(path, root);
    if (before !== undefined) pending.set(context.toolCall.id, { path, root, before });
    return decision;
  };

  session.agent.afterToolCall = async (context, signal) => {
    const candidate = pending.get(context.toolCall.id);
    pending.delete(context.toolCall.id);
    const after = candidate ? fileState(candidate.path, candidate.root) : undefined;
    const prior = await previousAfter?.(context, signal);
    if (!candidate || context.isError || prior?.isError || !after || after === "missing") return prior;
    const { before, path } = candidate;
    if (before !== "missing" && before.inode === after.inode && before.size === after.size && before.modifiedAt === after.modifiedAt) return prior;
    const oldDetails = prior?.details ?? context.result.details;
    const details = object(oldDetails);
    if (oldDetails != null && !details) return prior;
    const change: WrittenFile = { filePath: path, change: before === "missing" ? "created" : "modified" };
    return { ...prior, details: { ...details, [TOOL_FILE_CHANGE_KEY]: change } };
  };

  return () => pending.clear();
}
