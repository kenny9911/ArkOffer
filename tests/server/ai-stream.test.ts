import { test } from "node:test";
import assert from "node:assert/strict";
import { createAi, AiError } from "../../server/ai.js";

const messages = [{ role: "user", content: "Return a synthetic JSON draft." }];
const frame = (content: string, finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`;
function response(text: string, width = 9) {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += width)
          controller.enqueue(bytes.slice(i, i + width));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream; charset=utf-8" } },
  );
}

test("streaming preserves UTF-8 and SSE framing, heartbeat comments and provider usage endings", async () => {
  for (const usage of [
    { choices: [], usage: { total_tokens: 20 } },
    {
      choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }],
      usage: { total_tokens: 20 },
    },
  ]) {
    const raw =
      ': PROCESSING\r\n\r\nevent: message\r\ndata: {"choices":[{\r\ndata: "index":0,"delta":{"content":"{\\\"message\\\":\\\""},"finish_reason":null}]}\r\n\r\n' +
      frame("Hello 👋 café") +
      frame('\"}', "stop") +
      `data: ${JSON.stringify(usage)}\n\ndata: [DONE]\n\n`;
    let calls = 0;
    const ai = createAi({
      apiKey: "synthetic",
      fetch: async (_url, init) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        assert.equal(body.stream, true);
        assert.equal(body.response_format.type, "json_object");
        return response(raw, 1);
      },
    });
    assert.deepEqual(
      JSON.parse(await ai.complete(messages, true, { stream: true })),
      { message: "Hello 👋 café" },
    );
    assert.equal(calls, 1);
  }
});

test("a streaming request accepts a gateway's complete JSON response without issuing a fallback request", async () => {
  let calls = 0;
  const ai = createAi({
    apiKey: "synthetic",
    fetch: async () => {
      calls++;
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: '{"ok":true}' }, finish_reason: "stop" },
          ],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  });
  assert.equal(
    await ai.complete(messages, true, { stream: true }),
    ' {"ok":true}'.trim(),
  );
  assert.equal(calls, 1);
});

test("stream failures, truncation, refusals and malformed events never return partial drafts or leak provider details", async () => {
  const start = frame(' {"partial":true} ');
  const endings = [
    "", // A closed transport is not a completed generation.
    "data: [DONE]\n\n", // Completion sentinel without a valid stop is insufficient.
    frame("", "stop"), // A stop without the sentinel may still be followed by an error.
    'data: {"choices":[{"index":1,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    frame("", "length") + "data: [DONE]\n\n",
    frame("", "content_filter") + "data: [DONE]\n\n",
    frame("", "tool_calls") + "data: [DONE]\n\n",
    'data: {"error":{"message":"secret provider payload"}}\n\n',
    'data: {"choices":[{"index":0,"delta":{"refusal":"secret provider refusal"}}]}\n\n',
    "data: secret malformed payload\n\n",
    frame("", "stop") + frame("late secret token") + "data: [DONE]\n\n",
    `: ${"x".repeat(1_000_001)}\n\n`,
  ];
  for (const end of endings) {
    let calls = 0;
    const ai = createAi({
      apiKey: "synthetic",
      fetch: async () => {
        calls++;
        return response(start + end, 65536);
      },
    });
    await assert.rejects(
      ai.complete(messages, true, { stream: true }),
      (error) =>
        error instanceof AiError &&
        !/secret|partial|payload/.test(error.message),
    );
    assert.equal(calls, 1);
  }
});

test("stream cancellation and deadlines cancel a stalled reader even when the transport ignores abort", async (t) => {
  for (const timed of [false, true]) {
    const controller = new AbortController();
    const mock = timed
      ? t.mock.method(AbortSignal, "timeout", () => controller.signal)
      : null;
    let consumed!: () => void;
    const entered = new Promise<void>((resolve) => {
      consumed = resolve;
    });
    let cancelled = 0;
    const ai = createAi({
      apiKey: "synthetic",
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull() {
              consumed();
            },
            cancel() {
              cancelled++;
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    const pending = ai.complete(messages, true, {
      stream: true,
      ...(timed ? {} : { signal: controller.signal }),
    });
    await entered;
    controller.abort();
    await assert.rejects(pending, timed ? /took too long/ : /cancelled/);
    assert.equal(cancelled, 1);
    mock?.mock.restore();
  }
});

test("streaming JSON fallback requires a completed unrefused primary response", async () => {
  for (const item of [
    { finish_reason: null },
    { finish_reason: "content_filter" },
    { finish_reason: "tool_calls" },
    { finish_reason: "stop", index: 1 },
    {
      finish_reason: "stop",
      message: { content: '{"partial":true}', refusal: "secret refusal" },
    },
  ]) {
    let calls = 0;
    const ai = createAi({
      apiKey: "synthetic",
      fetch: async () => {
        calls++;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"partial":true}' }, ...item }],
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    });
    await assert.rejects(
      ai.complete(messages, true, { stream: true }),
      (error) =>
        error instanceof AiError && !/secret|partial/.test(error.message),
    );
    assert.equal(calls, 1);
  }
});
