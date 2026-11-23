import { randomUUID } from "node:crypto";
import type { SubagentRunInfo } from "./subagents";

/** Wait without holding up the parent after Stop, even if a child is still unwinding. */
export function waitForSubagent<T>(completion: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return completion;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    void completion.then((result) => {
      signal.removeEventListener("abort", abort);
      resolve(result);
    }, (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

function resultKey(sessionId: string, parentToolCallId: string): string {
  return `${sessionId}:${parentToolCallId}`;
}

/** The children and unread results of one accepted parent run. */
export class SubagentTask {
  readonly id = randomUUID();
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly unread = new Map<string, Promise<SubagentRunInfo>>();
  private launches = 0;
  sawFinalAssistant = false;
  waitingForUser = false;

  constructor(readonly preference: "required" | "proactive" | "optional") {}

  get launchCount(): number { return this.launches; }
  get hasUnreadResults(): boolean { return this.unread.size > 0; }

  track(run: SubagentRunInfo, completion: Promise<SubagentRunInfo>): void {
    this.launches += 1;
    this.unread.set(resultKey(run.sessionId, run.parentToolCallId), completion);
  }

  markDelivered(sessionId: string, parentToolCallId: string): void {
    this.unread.delete(resultKey(sessionId, parentToolCallId));
  }

  async waitForResults(signal: AbortSignal): Promise<SubagentRunInfo[]> {
    const results = await waitForSubagent(
      Promise.all(this.unread.values()),
      AbortSignal.any([signal, this.signal]),
    );
    return results.filter((run) => this.unread.has(resultKey(run.sessionId, run.parentToolCallId)));
  }

  cancel(): void {
    this.controller.abort(new DOMException("Parent task ended", "AbortError"));
  }
}
