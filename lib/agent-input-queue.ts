import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText, type ImageContent, type UserMessage } from "@earendil-works/pi-ai";
import type { ChatDraft } from "./draft-store";
import type { AgentSessionLike } from "./pi-types";

export type QueueKind = "steer" | "followUp";
export type QueueAction = "recall" | "steer";

export interface QueuedInput {
  id?: string;
  kind: QueueKind;
  text: string;
  imageCount: number;
}

export interface QueuedMessages {
  steering: string[];
  followUp: string[];
  items?: QueuedInput[];
}

type CoreQueues = {
  steeringQueue?: { messages?: AgentMessage[] };
  followUpQueue?: { messages?: AgentMessage[] };
};

function userInputs(messages: AgentMessage[]) {
  return messages.flatMap((message, index) => message.role === "user"
    ? [{ message, index, text: contentText(message.content, "") }]
    : []);
}

export class AgentInputQueue {
  private readonly ids = new WeakMap<UserMessage, string>();
  private readonly imageDrafts = new WeakMap<ImageContent, { text: string; filePath?: string }>();

  constructor(private readonly session: AgentSessionLike) {}

  rememberDraft(images: ImageContent[], text: unknown, filePaths: unknown): void {
    if (typeof text !== "string" || !Array.isArray(filePaths) || filePaths.length !== images.length) return;
    images.forEach((image, index) => {
      const filePath: unknown = filePaths[index];
      this.imageDrafts.set(image, { text, filePath: typeof filePath === "string" ? filePath : undefined });
    });
  }

  private state(kind: QueueKind) {
    // Pi 1.6 exposes pending text, while its core queue holds the actual user
    // message objects. Keep the adapter here and leave unsupported shapes read-only.
    const core = this.session.agent as CoreQueues;
    const getTexts = () => kind === "steer" ? this.session.getSteeringMessages() : this.session.getFollowUpMessages();
    const texts = getTexts();
    const messages = (kind === "steer" ? core.steeringQueue : core.followUpQueue)?.messages;
    if (!Array.isArray(messages)) return { texts };
    const rows = userInputs(messages);
    // The loop can drain messages just before Pi announces their delivery.
    // Its text mirror still has that prefix until each message_start arrives.
    const offset = texts.length - rows.length;
    const editable = offset >= 0
      && rows.every((row, index) => texts[offset + index] === row.text)
      && texts === getTexts() && !Object.isFrozen(texts) && !Object.isFrozen(messages);
    return { texts, messages, rows, offset, editable };
  }

  private idFor(message: UserMessage): string {
    let id = this.ids.get(message);
    if (!id) {
      id = randomUUID();
      this.ids.set(message, id);
    }
    return id;
  }

  private draftFor(message: UserMessage, text: string): ChatDraft {
    const images = typeof message.content === "string" ? [] : message.content.filter((block) => block.type === "image");
    const metadata = images.map((image) => this.imageDrafts.get(image));
    return {
      value: metadata.find((draft) => draft !== undefined)?.text ?? text,
      images: images.map(({ data, mimeType }, index) => ({ data, mimeType, filePath: metadata[index]?.filePath })),
    };
  }

  snapshot(): QueuedMessages {
    const steering = this.state("steer");
    const followUp = this.state("followUp");
    const items = (["steer", "followUp"] as const).flatMap((kind): QueuedInput[] => {
      const state = kind === "steer" ? steering : followUp;
      if (!state.rows) return state.texts.map((text) => ({ kind, text, imageCount: 0 }));
      return state.rows.map(({ message, text }) => {
        const draft = this.draftFor(message, text);
        return {
          id: state.editable ? this.idFor(message) : undefined,
          kind,
          text: draft.value,
          imageCount: draft.images.length,
        };
      });
    });
    return { steering: [...steering.texts], followUp: [...followUp.texts], items };
  }

  update(id: string, action: QueueAction, running: boolean): ChatDraft | null {
    const steering = this.state("steer");
    const followUp = this.state("followUp");
    for (const state of [steering, followUp]) {
      if (!state.editable || !state.messages || !state.rows) continue;
      const rowIndex = state.rows.findIndex(({ message }) => this.ids.get(message) === id);
      if (rowIndex < 0) continue;
      const { message, index, text } = state.rows[rowIndex];
      const draft = action === "recall" ? this.draftFor(message, text) : null;
      if (action === "steer") {
        if (state === steering) return null;
        if (!running || !steering.editable || !steering.messages) {
          throw new Error("The current response is no longer available to steer");
        }
        steering.messages.push(message);
        (steering.texts as string[]).push(text);
      }

      // Change one item synchronously, keeping both the core and its text mirror
      // in sync. A consumed item is absent above and can never be requeued here.
      state.messages.splice(index, 1);
      (state.texts as string[]).splice(state.offset + rowIndex, 1);
      return draft;
    }
    throw new Error("This message is no longer waiting in the queue");
  }
}
