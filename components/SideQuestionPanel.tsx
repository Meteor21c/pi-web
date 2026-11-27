"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { projectContainsDirectory, type ProjectSnapshot } from "@/lib/projects";
import type { SessionInfo } from "@/lib/types";
import { ChatWindow } from "./ChatWindow";
import type { ChatInputHandle } from "./ChatInput";

interface Props {
  sessionId: string;
  projectSnapshot: ProjectSnapshot;
  sessionRunning: boolean;
  openInMain: boolean;
  initialPrompt?: string;
  onInitialPromptConsumed: () => void;
  onOpenInMain: (session: SessionInfo) => void;
  onOpenFile: (file: string, sessionId: string, projectId?: string) => void;
  onAgentEnd: () => void;
}

export function SideQuestionPanel({
  sessionId, projectSnapshot, sessionRunning, openInMain, initialPrompt,
  onInitialPromptConsumed, onOpenInMain, onOpenFile, onAgentEnd,
}: Props) {
  const { t } = useI18n();
  const inputRef = useRef<ChatInputHandle>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const result = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}?tail=1&deferThinking=1&deferMedia=1`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const body = await result.json() as { info?: SessionInfo };
        if (!result.ok || body.info?.id !== sessionId) throw new Error("Session unavailable");
        if (!controller.signal.aborted) setSession(body.info);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    })();
    return () => controller.abort();
  }, [sessionId]);

  if (!session) {
    return <div className="p-4 text-sm text-text-muted" role={failed ? "alert" : "status"}>
      {t(failed ? "chat.sideQuestionLoadFailed" : "chat.sideQuestionLoading")}
    </div>;
  }

  const projectId = Object.hasOwn(projectSnapshot.assignments, sessionId)
    ? projectSnapshot.assignments[sessionId]
    : session.projectId;
  const project = projectSnapshot.projects.find((item) => item.id === projectId);
  const workspaceUnavailable = Boolean(project && !projectContainsDirectory(project, session.cwd));

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden" aria-label={t("chat.sideQuestionTab")}>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5 text-xs">
        <span className="truncate text-text-muted">{session.name ?? t("chat.sideQuestionTab")}</span>
        {!openInMain && <button type="button" className="shrink-0 rounded px-2 py-1 text-accent hover:bg-bg-hover" onClick={() => onOpenInMain(session)}>
          {t("chat.openSideQuestionInMain")}
        </button>}
      </div>
      {openInMain ? (
        <p className="p-4 text-sm text-text-muted">{t("chat.sideQuestionInMain")}</p>
      ) : (
        <div className="min-h-0 flex-1">
          <ChatWindow
            session={session}
            projectId={projectId}
            savedCwdOutsideProject={workspaceUnavailable}
            uploadCwd={workspaceUnavailable ? null : project?.defaultDirectory}
            newSessionCwd={null}
            newSessionDraftKey={null}
            sessionRunning={sessionRunning}
            initialPrompt={initialPrompt}
            onInitialPromptConsumed={onInitialPromptConsumed}
            onOpenFile={(file) => onOpenFile(file, sessionId, projectId ?? undefined)}
            onAgentEnd={onAgentEnd}
            chatInputRef={inputRef}
            sidePanel
            soundEnabled={false}
          />
        </div>
      )}
    </section>
  );
}
