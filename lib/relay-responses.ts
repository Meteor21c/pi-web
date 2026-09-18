import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, FetchFunction, Model } from "@earendil-works/pi-ai";
import { isRelayProviderId, relayModelNeedsResponseRepair } from "./relay-config";

const RECOVERABLE_DELTA_EVENTS = new Set([
  "response.output_text.delta",
  "response.refusal.delta",
  "response.reasoning_summary_text.delta",
  "response.reasoning_text.delta",
  "response.function_call_arguments.delta",
  "response.custom_tool_call_input.delta",
]);

const installedRuntimes = new WeakSet<object>();

/**
 * Read one complete JSON string value from a (possibly truncated) JSON object.
 * The relay failures we have observed happen after the useful delta field, so
 * keeping this deliberately small and conservative avoids inventing content.
 */
function readJsonStringField(source: string, field: string): string | undefined {
  const fieldPattern = new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*"`);
  const match = fieldPattern.exec(source);
  if (!match) return undefined;

  const start = match.index + match[0].length;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character !== '"') continue;
    const encoded = source.slice(start, index);
    try {
      return JSON.parse(`"${encoded}"`) as string;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function readJsonNumberField(source: string, field: string): number | undefined {
  const pattern = new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`);
  const match = pattern.exec(source);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\[\]\\]/g, "\\$&");
}

/**
 * Recover only the fields needed by pi-ai's Responses event reducer. A
 * malformed terminal event is intentionally not recovered; the SDK must still
 * report an incomplete stream instead of silently claiming success.
 */
export function recoverMalformedResponseEvent(source: string): Record<string, unknown> | undefined {
  const type = readJsonStringField(source, "type");
  if (!type || !RECOVERABLE_DELTA_EVENTS.has(type)) return undefined;

  const delta = readJsonStringField(source, "delta");
  if (delta === undefined) return undefined;

  const recovered: Record<string, unknown> = { type, delta };
  for (const field of ["output_index", "content_index", "sequence_number"]) {
    const value = readJsonNumberField(source, field);
    if (value !== undefined) recovered[field] = value;
  }
  for (const field of ["item_id", "call_id", "id"]) {
    const value = readJsonStringField(source, field);
    if (value !== undefined) recovered[field] = value;
  }
  return recovered;
}

function repairSseFrame(frame: string): string {
  const lines = frame.split(/\r?\n/);
  const dataIndexes: number[] = [];
  const dataParts: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.startsWith("data:")) continue;
    dataIndexes.push(index);
    dataParts.push(line.slice(5).trimStart());
  }

  if (dataIndexes.length === 0) return `${frame}\n\n`;
  const data = dataParts.join("\n");
  if (data === "[DONE]") return `${frame}\n\n`;

  try {
    JSON.parse(data);
    return `${frame}\n\n`;
  } catch {
    const recovered = recoverMalformedResponseEvent(data);
    if (!recovered) return "";
    const firstDataIndex = dataIndexes[0];
    const rewritten = lines.filter((_, index) => !dataIndexes.includes(index));
    rewritten.splice(firstDataIndex, 0, `data: ${JSON.stringify(recovered)}`);
    return `${rewritten.join("\n")}\n\n`;
  }
}

function createRepairingSseBody(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  let finished = false;

  const flushFrames = (controller: ReadableStreamDefaultController<Uint8Array>, flushAll = false): number => {
    let emitted = 0;
    while (true) {
      const separator = /\r?\n\r?\n/.exec(pending);
      if (!separator) break;
      const frame = pending.slice(0, separator.index);
      pending = pending.slice(separator.index + separator[0].length);
      const repaired = repairSseFrame(frame);
      if (repaired) {
        controller.enqueue(encoder.encode(repaired));
        emitted += 1;
      }
    }
    if (flushAll && pending.length > 0) {
      const repaired = repairSseFrame(pending);
      pending = "";
      if (repaired) {
        controller.enqueue(encoder.encode(repaired));
        emitted += 1;
      }
    }
    return emitted;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      try {
        // A frame may span many network chunks. Keep reading within one pull
        // until we can enqueue something; otherwise the Web Streams backpressure
        // algorithm has no reason to invoke pull() again for a still-pending read.
        while (!finished) {
          const { done, value } = await reader.read();
          if (done) {
            pending += decoder.decode();
            flushFrames(controller, true);
            finished = true;
            controller.close();
            return;
          }
          pending += decoder.decode(value, { stream: true });
          if (flushFrames(controller) > 0) return;
        }
      } catch (error) {
        finished = true;
        controller.error(error);
      }
    },
    async cancel(reason) {
      finished = true;
      await reader.cancel(reason);
    },
  });
}

function responseIsSse(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") === true;
}

/**
 * Wrap a fetch implementation for the relay's known malformed Responses SSE.
 * Non-SSE responses and every other provider are returned byte-for-byte.
 */
export function createRelayResponsesFetch(fetchImpl: FetchFunction = globalThis.fetch): FetchFunction {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (!response.body || !responseIsSse(response)) return response;
    return new Response(createRepairingSseBody(response.body), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

function needsRepair(model: Model<Api>): boolean {
  return isRelayProviderId(model.provider)
    && model.api === "openai-responses"
    && relayModelNeedsResponseRepair(model.id);
}

function withRelayRepairFetch<T extends { fetch?: FetchFunction }>(options: T | undefined): T {
  return {
    ...(options ?? {}),
    fetch: createRelayResponsesFetch(options?.fetch),
  } as T;
}

/**
 * Install the compatibility fetch at the ModelRuntime boundary. AgentSession
 * uses streamSimple for normal turns, while the extra stream hook protects SDK
 * callers and completeSimple (which delegates to streamSimple).
 */
export function installRelayResponseRepair(modelRuntime: ModelRuntime): void {
  if (installedRuntimes.has(modelRuntime)) return;
  installedRuntimes.add(modelRuntime);

  const originalStreamSimple = modelRuntime.streamSimple.bind(modelRuntime);
  modelRuntime.streamSimple = ((model, context, options) => {
    if (!needsRepair(model)) return originalStreamSimple(model, context, options);
    return originalStreamSimple(model, context, withRelayRepairFetch(options));
  }) as ModelRuntime["streamSimple"];

  const originalStream = modelRuntime.stream.bind(modelRuntime);
  modelRuntime.stream = ((model, context, options) => {
    if (!needsRepair(model)) return originalStream(model, context, options);
    return originalStream(model, context, withRelayRepairFetch(options));
  }) as ModelRuntime["stream"];
}
