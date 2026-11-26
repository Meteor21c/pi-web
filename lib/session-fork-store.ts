import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type SessionManager } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { getUserMessageText } from "./message-display";
import { readSessionForkOrigin, type SessionForkOrigin } from "./session-fork-origin";
import type { SessionEntry, UserMessage } from "./types";

export function formatSessionForkTitle(titleBase: string, number: number): string {
  return `${titleBase}（${number}）`;
}

function sourceTitle(manager: SessionManager): string | undefined {
  const name = manager.getSessionName()?.trim();
  if (name) return name;
  const firstUser = manager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "user");
  if (firstUser?.type !== "message" || firstUser.message.role !== "user") return;
  return Array.from(getUserMessageText(firstUser.message as UserMessage).replace(/\s+/g, " ").trim()).slice(0, 50).join("") || undefined;
}

async function reserveForkNumber(path: string, familyId: string, previous: number): Promise<number> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(path, { realpath: false, retries: { retries: 10, minTimeout: 50, maxTimeout: 300 } });
  try {
    let counts: Record<string, number> = {};
    try {
      counts = JSON.parse(readFileSync(path, "utf8")) as Record<string, number>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const current = Object.hasOwn(counts, familyId) ? counts[familyId] : 0;
    const number = Math.max(current, previous) + 1;
    if (!Number.isSafeInteger(number) || number < 1) throw new Error("Invalid saved session fork number");
    writePrivateFileAtomicSync(path, JSON.stringify({ ...counts, [familyId]: number }) + "\n");
    return number;
  } finally {
    await release();
  }
}

export async function prepareSessionForkOrigin(
  source: SessionManager,
  countsPath = join(getAgentDir(), "meteoragent-fork-counters.json"),
): Promise<Omit<SessionForkOrigin, "sessionId">> {
  const sessionId = source.getSessionId();
  const entries = source.getEntries() as unknown as SessionEntry[];
  const parentMarker = entries.findLast((entry) => readSessionForkOrigin(entry)?.sessionId === sessionId);
  const parent = parentMarker && readSessionForkOrigin(parentMarker);
  const title = sourceTitle(source);
  const titleBase = parent && title === formatSessionForkTitle(parent.titleBase, parent.number)
    ? parent.titleBase
    : title ?? parent?.titleBase ?? "新会话";
  const familyId = parent?.familyId ?? sessionId;
  const number = await reserveForkNumber(countsPath, familyId, parent?.number ?? 0);
  return { familyId, titleBase, number };
}
