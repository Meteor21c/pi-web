import type { BlockingExtensionUiRequest } from "@/lib/types";

type ExtensionUiQueueEvent =
  | { type: "request"; request: BlockingExtensionUiRequest }
  | { type: "closed"; id: string }
  | { type: "snapshot"; ids: readonly string[] };

/** Keep the first pending screen active while later requests wait in arrival order. */
export function extensionUiQueueReducer(
  queue: ReadonlyMap<string, BlockingExtensionUiRequest>,
  event: ExtensionUiQueueEvent,
): ReadonlyMap<string, BlockingExtensionUiRequest> {
  switch (event.type) {
    case "request": {
      const { request } = event;
      if (request.method !== "custom" && queue.has(request.id)) return queue;
      // A custom screen reuses its ID to redraw. Map.set preserves its place.
      return new Map(queue).set(request.id, request);
    }
    case "closed": {
      if (!queue.has(event.id)) return queue;
      const next = new Map(queue);
      next.delete(event.id);
      return next;
    }
    case "snapshot": {
      // On reconnect keep open forms mounted, and discard requests whose close
      // event was lost. The stream replays new requests after this snapshot.
      const pending = new Set(event.ids);
      const stillOpen = [...queue].filter(([id]) => pending.has(id));
      return stillOpen.length === queue.size ? queue : new Map(stillOpen);
    }
  }
}
