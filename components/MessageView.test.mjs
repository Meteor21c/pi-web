import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const {
  MessageView,
  ThinkingBlock,
  formatUsage,
  getDeliveredToolImages,
  getModelDisplayName,
  getTokenEstimateText,
  getToolCallInputText,
  replaceUserMessageText,
} = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { getAssistantTimelineSegments, splitFinalAssistantBlocks } = await jiti.import("@/lib/message-display");

function renderMessage(message, props = {}) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, { message, ...props }),
    ),
  );
}

test("shows a collapsed compaction row before mounting the summary and file context", () => {
  const html = renderMessage({
    role: "custom",
    customType: "compaction",
    content: "Private summary text\n\n<read-files>\nsource.ts\n</read-files>",
    timestamp: 1700000000000,
  });
  assert.match(html, /<details class="chat-compaction"><summary/);
  assert.match(html, /Conversation compacted/);
  assert.doesNotMatch(html, /Private summary text|source.ts/);
});

test("updates a reused message when its written files change", () => {
  const props = { message: { role: "assistant", content: [] } };
  assert.equal(MessageView.compare(props, props), true);
  assert.equal(MessageView.compare(props, { ...props, writtenFiles: [{ path: "/tmp/result.txt" }] }), false);
  assert.equal(MessageView.compare(props, { ...props, actualCost: 0.0007514 }), false);
});

test("shows the authoritative relay charge with enough precision", () => {
  const usage = {
    input: 1021,
    output: 896,
    cacheRead: 192,
    cacheWrite: 0,
    cost: { total: 0.007514 },
  };
  assert.match(formatUsage(usage, 0.0007514), /\$0\.000751$/);
  assert.doesNotMatch(formatUsage(usage, 0.0007514), /\$0\.007514/);

  const html = renderMessage({
    role: "assistant",
    provider: "meteor21c-k143",
    model: "grok-4.6",
    content: [{ type: "text", text: "hello" }],
    usage,
  }, { actualCost: 0.0007514 });
  // v5: 统计行改为图标胶囊，含义说明挂在 data-tip（悬停 tooltip）上。
  assert.match(html, /data-tip="Actual relay charge \(synced\)"/);
  assert.match(html, /\$0\.000751/);
});

test("labels the final usage chips as a whole-turn summary", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "meteor21c-k143",
    model: "grok-4.6",
    content: [{ type: "text", text: "Summary" }],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
  }, {
    usageOverride: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 } },
  });
  assert.match(html, /data-tip="Turn summary · Input"/);
  assert.match(html, />2<\/span>/);
});

test("shows image billing separately only on a successful generated-image turn", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "meteor21c-k143",
    model: "grok-4.6",
    content: [{ type: "text", text: "Done" }],
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
    },
  }, {
    imageBilling: { imageCount: 1, chargeCount: 1, matchedChargeCount: 1, actualCost: 0.12 },
  });
  assert.match(html, /Image \$0\.12/);
  assert.match(html, /Image charge · 1 generation\(s\) · synced/);

  const pending = renderMessage({
    role: "assistant",
    provider: "meteor21c-k143",
    model: "grok-4.6",
    content: [{ type: "text", text: "Waiting" }],
  }, {
    imageBilling: { imageCount: 1, chargeCount: 1, matchedChargeCount: 0, actualCost: 0 },
  });
  assert.match(pending, /Syncing/);
  assert.match(pending, /ui-stat-chip-image is-pending/);
});

test("renders intermediate usage as small text without stat chips", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "meteor21c-k143",
    model: "grok-4.6",
    content: [{ type: "toolCall", toolCallId: "call-1", toolName: "read", input: {} }],
    usage: {
      input: 100,
      output: 20,
      cacheRead: 30,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 },
    },
  }, { compactUsage: true, showModel: false });
  assert.match(html, /ui-usage-compact/);
  assert.doesNotMatch(html, /ui-stat-chip[^-]/);
});

test("tool badges use measured duration when the runtime recorded it", () => {
  const toolCallId = "call-bash";
  const message = {
    role: "assistant",
    content: [{ type: "toolCall", toolCallId, toolName: "bash", input: { command: "printf done" } }],
    timestamp: 7000,
  };
  const result = {
    role: "toolResult",
    toolCallId,
    toolName: "bash",
    content: [{ type: "text", text: "done" }],
    timestamp: 91000,
  };

  const measured = renderMessage(message, {
    toolResults: new Map([[toolCallId, { ...result, durationMs: 2200 }]]),
  });
  assert.match(measured, />2s<\/span>/);
  assert.doesNotMatch(measured, />84s<\/span>/);

  const legacy = renderMessage(message, { toolResults: new Map([[toolCallId, result]]) });
  assert.doesNotMatch(legacy, />84s<\/span>/);
});

test("matches response model aliases and otherwise includes the provider", () => {
  const names = {
    "gateway:claude-sonnet-5": "Sonnet 5",
    "custom-api:GLM-5.3": "GLM 5.3",
  };

  assert.equal(getModelDisplayName("gateway", "anthropic/claude-sonnet-5", names), "Sonnet 5");
  assert.equal(getModelDisplayName("CUSTOM-API", "glm-5.3", names), "GLM 5.3");
  assert.equal(getModelDisplayName("gateway", "unknown-model", names), "gateway/unknown-model");
});

test("keeps the reasoning content closed even if an older preference enabled auto expansion", () => {
  const previousWindow = globalThis.window;
  try {
    for (const expanded of [false, true]) {
      globalThis.window = { localStorage: { getItem: () => String(expanded) } };
      const html = renderToStaticMarkup(React.createElement(
        I18nProvider,
        null,
        React.createElement(ThinkingBlock, {
          block: { type: "thinking", thinking: "**Independent reasoning**\n\nDetailed second line." },
          blockIndex: 2,
          duration: 3,
        }),
      ));
      assert.match(html, /aria-expanded="false"/);
      assert.doesNotMatch(html, /Independent reasoning|Detailed second line\./);
      assert.match(html, /Thinking content/);
      assert.match(html, /3s/);
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("keeps deferred thinking previews behind the disclosure", () => {
  const html = renderMessage({
    role: "assistant",
    content: [{ type: "thinking", thinking: "Historical first line", deferred: true }],
  });
  assert.doesNotMatch(html, /Historical first line/);
  assert.match(html, /aria-expanded="false"/);
});

test("marks only the matched text block after splitting thinking and the final answer", () => {
  const message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "" },
      { type: "thinking", thinking: "Thinking about the result" },
      { type: "text", text: "Process text" },
      { type: "toolCall", toolCallId: "read-1", toolName: "read", input: {} },
      { type: "text", text: "First answer" },
      { type: "text", text: "Matched pi-cwd-spark answer" },
    ],
  };
  const { processBlocks, answerBlocks } = splitFinalAssistantBlocks(message);
  for (const index of [2, 4, 5]) {
    const searchBlock = message.content[index];
    for (const content of [processBlocks, answerBlocks]) {
      const html = renderMessage({ ...message, content }, { searchBlock });
      assert.equal((html.match(/data-search-target="true"/g) ?? []).length, content.includes(searchBlock) ? 1 : 0);
      if (content.includes(searchBlock)) {
        assert.match(html, new RegExp(`data-search-target="true">(?:(?!data-message-text)[\\s\\S])*${searchBlock.text}`));
      }
    }
  }
});

test("keeps streamed tool input out of collapsed markup while counting it", () => {
  const block = {
    type: "toolCall",
    toolCallId: "call-write-1",
    toolName: "write",
    input: {},
    rawInput: '{"path":"/tmp/file","content":"secret-stream-fragment',
  };
  const html = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [block],
  }, { isStreaming: true });

  assert.match(html, /write/);
  assert.match(html, /Generating parameters/);
  assert.doesNotMatch(html, /secret-stream-fragment/);
  assert.equal(getToolCallInputText(block), block.rawInput);
  assert.equal(getTokenEstimateText(block), block.rawInput);
});

test("shows subagent activity as a link without rendering the report in the parent chat", () => {
  const block = {
    type: "toolCall",
    toolCallId: "call-agent-1",
    toolName: "Agent",
    input: {
      subagent_type: "Explore",
      prompt: "Find the parser",
      description: "Find parser",
    },
  };
  const result = {
    role: "toolResult",
    toolCallId: block.toolCallId,
    content: [{ type: "text", text: "Parser is in lib/parser.ts" }],
    details: {
      kind: "pi-web-subagent",
      sessionId: "child-session",
      profile: "Explore",
      description: "Find parser",
      status: "completed",
      runInBackground: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
  const html = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [block],
  }, {
    toolResults: new Map([[block.toolCallId, result]]),
    onOpenSession() {},
  });

  assert.match(html, /<button[^>]*data-subagent-session="child-session"/);
  assert.match(html, /Find parser · Subagent completed/);
  assert.doesNotMatch(html, /Parser is in lib\/parser\.ts|Find the parser|pi-web:/);

  const plain = renderMessage({ role: "assistant", content: [{ ...block, toolName: "get_subagent_result" }] }, {
    toolResults: new Map([[block.toolCallId, result]]),
  });
  assert.match(plain, /Find parser · Subagent completed/);
  assert.doesNotMatch(plain, /Parser is in lib\/parser\.ts|<button/);

  const notification = renderMessage({
    role: "custom",
    customType: "pi-web:subagent-notification",
    display: true,
    content: "Parser is in lib/parser.ts",
    details: result.details,
  }, { onOpenSession() {} });
  assert.match(notification, /<button[^>]*data-subagent-session="child-session"/);
  assert.match(notification, /Find parser · Subagent completed/);
  assert.doesNotMatch(notification, /Parser is in lib\/parser\.ts|pi-web:/);

  const ordinaryHtml = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [{ ...block, toolCallId: "call-extension-1", toolName: "extension_tool" }],
  }, {
    toolResults: new Map(),
    onOpenSession() {},
  });
  assert.doesNotMatch(ordinaryHtml, /Open sub-agent session/);
});

const COMPLETE_SKILL_EXPANSION = `<skill name="review" location="/skills/review/SKILL.md">
References are relative to /skills/review.

Review the supplied files.
</skill>

src/main.ts`;

test("renders a provider error when the assistant message has no content", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [],
    stopReason: "error",
    errorMessage: "OpenAI API error (403): <html>request forbidden</html>",
  });

  assert.match(html, /role="alert"/);
  assert.match(html, /Model error: OpenAI API error \(403\)/);
  assert.match(html, /&lt;html&gt;request forbidden&lt;\/html&gt;/);
});

test("renders partial assistant content before the provider error", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Partial response" }],
    stopReason: "error",
    errorMessage: "Connection closed",
  });

  assert.match(html, /Partial response/);
  assert.match(html, /Model error: Connection closed/);
});

test("replaces a low-level truncated Responses error with actionable guidance", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "meteor21c-k20",
    model: "gpt-6-astra",
    content: [{ type: "text", text: "Partial response" }],
    stopReason: "error",
    errorMessage: "Unexpected end of JSON input",
  });

  assert.match(html, /upstream response was interrupted/i);
  assert.match(html, /Compatibility mode/);
  assert.doesNotMatch(html, /Unexpected end of JSON input/);
});

test("marks persisted assistant messages with their source entry", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Select this response" }],
  }, { entryId: "assistant-entry" });

  assert.match(html, /data-message-role="assistant"/);
  assert.match(html, /data-entry-id="assistant-entry"/);
});

test("renders a complete SDK skill expansion as a compact command", () => {
  const html = renderMessage({
    role: "user",
    content: COMPLETE_SKILL_EXPANSION,
  });

  assert.match(html, /\/skill:review/);
  assert.match(html, /src\/main\.ts/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /Review the supplied files/);
});

test("does not collapse incomplete skill-looking user text", () => {
  const html = renderMessage({
    role: "user",
    content: '<skill name="review" location="/skills/review/SKILL.md">\nordinary user text',
  });

  assert.match(html, /ordinary user text/);
  assert.doesNotMatch(html, /aria-expanded/);
});

test("keeps attached images when restoring a compact command for editing", () => {
  const image = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "QUJDRA==" },
  };
  const restored = replaceUserMessageText({
    role: "user",
    content: [{ type: "text", text: COMPLETE_SKILL_EXPANSION }, image],
  }, "/skill:review src/main.ts");

  assert.deepEqual(restored.content, [
    { type: "text", text: "/skill:review src/main.ts" },
    image,
  ]);
});

test("renders user-message images as buttons that open a larger preview", () => {
  const html = renderMessage({
    role: "user",
    content: [
      { type: "text", text: "inspect this" },
      { type: "image", data: "YWJj", mimeType: "image/png" },
    ],
    timestamp: Date.now(),
  });

  assert.match(html, /<button[^>]+aria-label="Preview image"[^>]*>/);
  assert.match(html, /<img[^>]+src="data:image\/png;base64,YWJj"/);
});

test("renders assistant images instead of dropping the image content block", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "meteor21c-image",
    model: "image-model",
    content: [
      { type: "text", text: "Generated image" },
      { type: "image", data: "YWJj", mimeType: "image/png" },
      { type: "image", source: { type: "url", url: "https://example.test/generated.webp" } },
    ],
    timestamp: Date.now(),
  });

  assert.equal((html.match(/data-message-image=/g) ?? []).length, 2);
  assert.equal((html.match(/aria-label="Preview image"/g) ?? []).length, 2);
  assert.match(html, /<img[^>]+src="data:image\/png;base64,YWJj"/);
  assert.match(html, /<img[^>]+src="https:\/\/example\.test\/generated\.webp"/);
  assert.match(html, /max-width:min\(100%, 420px\)/);
  assert.match(html, /max-height:320px/);
});

test("uses the conversation's file access for a local image embedded in an assistant reply", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "local",
    model: "model",
    content: [{ type: "text", text: "![Preview](/tmp/chat-preview/preview%20file.png)" }],
  }, { cwd: "/home/me/project", sessionId: "session-1", onOpenFile() {} });

  assert.match(html, /src="\/api\/files\/tmp\/chat-preview\/preview%20file\.png\?type=read&amp;sessionId=session-1"/);
});

test("renders pi-image-gen detail images inline with tool details closed", () => {
  const block = {
    type: "toolCall",
    toolCallId: "image-call-1",
    toolName: "image_generate",
    input: { prompt: "a golden hamster" },
  };
  const html = renderMessage({
    role: "assistant",
    provider: "meteor21c-image",
    model: "image-model",
    content: [block],
  }, {
    cwd: "/tmp/project",
    sessionId: "session-1",
    toolResults: new Map([[block.toolCallId, {
      role: "toolResult",
      toolCallId: block.toolCallId,
      toolName: "image_generate",
      content: [{ type: "text", text: "Generated 1 image(s): /tmp/project/.pi/images/hamster.png" }],
      details: { images: [{ path: "/tmp/project/.pi/images/hamster.png", mimeType: "image/png" }] },
    }]]),
  });

  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-label="Preview image"/);
  assert.doesNotMatch(html, /a golden hamster/);
  assert.match(html, /src="\/api\/files\/tmp\/project\/\.pi\/images\/hamster\.png\?type=read&amp;sessionId=session-1"/);
  assert.doesNotMatch(html, /Generated 1 image\(s\): \/tmp\/project\/\.pi\/images\/hamster\.png/);
});

test("keeps screenshot and image-read results within adjacent tool activity", () => {
  const toolCalls = ["read", "computer_use_get_window_state", "bash"].map((toolName) => ({
    type: "toolCall", toolCallId: toolName, toolName, input: {},
  }));
  const screenshot = { type: "image", source: { type: "url", url: "/api/sessions/session-1/media" } };
  const toolResults = new Map(toolCalls.slice(0, 2).map(({ toolCallId, toolName }) => [toolCallId, {
    role: "toolResult", toolCallId, toolName, content: [screenshot],
  }]));
  const message = { role: "assistant", content: [...toolCalls, { type: "text", text: "Finished checking" }] };
  const segments = getAssistantTimelineSegments(message, {
    isVisibleToolResult: (block) => getDeliveredToolImages(toolResults.get(block.toolCallId), block.toolName).length > 0,
  });
  assert.deepEqual(segments, [
    { kind: "activity", blockIndices: [0, 1, 2] },
    { kind: "output", blockIndices: [3] },
  ]);
  const html = renderMessage(message, { toolResults });
  assert.match(html, /computer_use_get_window_state/);
  assert.match(html, /Finished checking/);
  assert.doesNotMatch(html, /Preview image|\/api\/sessions\/session-1\/media/);
});

test("renders image-tool URL details without accepting arbitrary schemes", () => {
  const block = {
    type: "toolCall",
    toolCallId: "image-call-url",
    toolName: "image_generate",
    input: { prompt: "a cloud" },
  };
  const html = renderMessage({
    role: "assistant",
    provider: "meteor21c-image",
    model: "image-model",
    content: [block],
  }, {
    toolResults: new Map([[block.toolCallId, {
      role: "toolResult",
      toolCallId: block.toolCallId,
      toolName: "image_generate",
      content: [{ type: "text", text: "Generated image" }],
      details: {
        images: [
          { url: "https://cdn.example.test/cloud.webp", mimeType: "image/webp" },
          { url: "javascript:alert(1)", mimeType: "image/png" },
        ],
      },
    }]]),
  });

  assert.equal((html.match(/aria-label="Preview image"/g) ?? []).length, 1);
  assert.match(html, /src="https:\/\/cdn\.example\.test\/cloud\.webp"/);
  assert.doesNotMatch(html, /javascript:alert/);
});

test("renders custom-message images as buttons that open a larger preview", () => {
  const html = renderMessage({
    role: "custom",
    customType: "extension",
    content: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
    timestamp: Date.now(),
  });

  assert.match(html, /<button[^>]+aria-label="Preview image"[^>]*>/);
  assert.match(html, /<img[^>]+src="data:image\/png;base64,YWJj"/);
});
