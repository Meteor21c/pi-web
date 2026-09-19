import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import OpenAI from "openai";

const { createRelayResponsesFetch, recoverMalformedResponseEvent } = await createJiti(import.meta.url)
  .import("./relay-responses.ts");

const event = (payload) => `data: ${payload}\n\n`;

function responseFor(chunks, headers = { "content-type": "text/event-stream" }) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  }), { status: 200, headers });
}

test("keeps valid Responses SSE events unchanged", async () => {
  const payload = JSON.stringify({ type: "response.output_text.delta", output_index: 0, delta: "ok" });
  const fetch = createRelayResponsesFetch(async () => responseFor([event(payload)]));
  const response = await fetch("https://relay.example.test/v1/responses");
  assert.equal(await response.text(), event(payload));
});

test("repairs a malformed output delta with a trailing delimiter", async () => {
  const malformed = '{"type":"response.output_text.delta","output_index":0,"delta":"L","item_id":"msg_1",:';
  const fetch = createRelayResponsesFetch(async () => responseFor(["data: ", malformed.slice(0, 38), malformed.slice(38), "\n\n"]));
  const response = await fetch("https://relay.example.test/v1/responses");
  assert.deepEqual(JSON.parse((await response.text()).trim().slice(6)), {
    type: "response.output_text.delta",
    delta: "L",
    output_index: 0,
    item_id: "msg_1",
  });
});

test("repairs a malformed output delta ending in an unterminated field", async () => {
  const malformed = '{"type":"response.output_text.delta","output_index":0,"delta":"text","obfuscation:';
  const fetch = createRelayResponsesFetch(async () => responseFor([event(malformed)]));
  const response = await fetch("https://relay.example.test/v1/responses");
  assert.deepEqual(JSON.parse((await response.text()).trim().slice(6)), {
    type: "response.output_text.delta",
    delta: "text",
    output_index: 0,
  });
});

test("recovers a response delta whose string value was cut off", async () => {
  const malformed = '{"type":"response.output_text.delta","output_index":0,"delta":"partial SVG';
  assert.deepEqual(recoverMalformedResponseEvent(malformed), {
    type: "response.output_text.delta",
    output_index: 0,
    delta: "partial SVG",
  });

  const completed = event(JSON.stringify({
    type: "response.completed",
    response: { id: "resp_partial_1", status: "completed", output: [] },
  }));
  const fetch = createRelayResponsesFetch(async () => responseFor([event(malformed), completed]));
  const response = await fetch("https://relay.example.test/v1/responses");
  const text = await response.text();
  assert.match(text, /partial SVG/);
  assert.match(text, /response\.completed/);
});

test("recovers truncated function-call completion events", () => {
  assert.deepEqual(
    recoverMalformedResponseEvent('{"type":"response.function_call_arguments.done","output_index":2,"arguments":"{\\"path\\":\\"/tmp/a'),
    {
      type: "response.function_call_arguments.done",
      output_index: 2,
      arguments: '{"path":"/tmp/a',
    },
  );
});

test("keeps the first valid Responses event when relay data has trailing garbage", async () => {
  const valid = JSON.stringify({ type: "response.output_text.delta", output_index: 0, delta: "ok" });
  const fetch = createRelayResponsesFetch(async () => responseFor([event(`${valid}garbage`)]));
  const response = await fetch("https://relay.example.test/v1/responses");
  assert.deepEqual(JSON.parse((await response.text()).trim().slice(6)), JSON.parse(valid));
});

test("recovers function-call argument deltas but drops unrepairable events", async () => {
  assert.deepEqual(
    recoverMalformedResponseEvent('{"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\\"x\\":1}",:'),
    { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"x":1}' },
  );
  assert.equal(recoverMalformedResponseEvent('{"type":"response.output_text.de:'), undefined);

  const fetch = createRelayResponsesFetch(async () => responseFor([
    event('{"type":"response.output_text.de:'),
    event("[DONE]"),
  ]));
  const response = await fetch("https://relay.example.test/v1/responses");
  assert.equal(await response.text(), event("[DONE]"));
});

test("preserves a terminal completed event after repaired deltas", async () => {
  const malformed = event('{"type":"response.output_text.delta","output_index":0,"delta":"a",:');
  const completed = event(JSON.stringify({
    type: "response.completed",
    response: { id: "resp_1", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } },
  }));
  const fetch = createRelayResponsesFetch(async () => responseFor([malformed, completed]));
  const response = await fetch("https://relay.example.test/v1/responses");
  const text = await response.text();
  assert.match(text, /response\.output_text\.delta/);
  assert.match(text, /response\.completed/);
});

test("lets the OpenAI Responses SDK consume a repaired relay stream", async () => {
  const malformedDelta = '{"type":"response.output_text.delta","output_index":0,"delta":"OK",:';
  const frames = [
    event(JSON.stringify({ type: "response.created", response: { id: "resp_sdk_1", status: "in_progress" } })),
    event(JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { id: "msg_sdk_1", type: "message", role: "assistant", content: [] } })),
    event(JSON.stringify({ type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } })),
    event(malformedDelta),
    event(JSON.stringify({ type: "response.output_text.done", output_index: 0, content_index: 0, text: "OK" })),
    event(JSON.stringify({ type: "response.completed", response: { id: "resp_sdk_1", status: "completed", output: [] } })),
    event("[DONE]"),
  ];
  const client = new OpenAI({
    apiKey: "test-key",
    baseURL: "https://relay.example.test/v1",
    fetch: createRelayResponsesFetch(async () => responseFor(frames)),
  });
  const { data: stream } = await client.responses.create({
    model: "gpt-test",
    input: "hello",
    stream: true,
  }).withResponse();
  const types = [];
  for await (const item of stream) types.push(item.type);
  assert.ok(types.includes("response.output_text.delta"));
  assert.ok(types.includes("response.completed"));
});

test("does not rewrite non-SSE responses", async () => {
  const fetch = createRelayResponsesFetch(async () => new Response('{"ok":true}', {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  const response = await fetch("https://relay.example.test/v1/responses");
  assert.equal(await response.text(), '{"ok":true}');
});
