import { test } from "node:test";
import assert from "node:assert/strict";
import { createAi, AiError } from "../../server/ai.js";

const messages = [
  { role: "system", content: "Use only the synthetic example." },
  { role: "user", content: "Reply with fixture text." },
];
const success = (content = "Synthetic response") =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: "stop" }],
    }),
    { headers: { "Content-Type": "application/json" } },
  );
const configured = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  LLM_PROVIDER: "openrouter",
  OPENROUTER_API_KEY: "synthetic-key",
  LLM_MODEL: "gpt-6-luna",
  LLM_WORKSPACE_IDS: "workspace-one",
  ...extra,
});

test("AI gateway honors exact model, root URL alias and safe OpenAI-compatible request protocol", async () => {
  const calls: { url: string; options: RequestInit }[] = [];
  const ai = createAi({
    env: configured({ OPENROUTER_BASE_URL: "https://aigw.store" }),
    fetch: (async (url, options) => {
      calls.push({ url: String(url), options: options! });
      return success();
    }) as typeof fetch,
  });
  assert.equal(ai.configured, true);
  assert.equal(ai.provider, "openrouter");
  assert.equal(ai.model, "gpt-6-luna");
  assert.equal(
    await ai.complete(messages, true, { maxTokens: 321 }),
    "Synthetic response",
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://aigw.store/chat/completions");
  const init = calls[0].options,
    body = JSON.parse(String(init.body));
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  assert.ok(init.signal);
  assert.equal(
    new Headers(init.headers).get("Authorization"),
    "Bearer synthetic-key",
  );
  assert.equal(body.model, "gpt-6-luna");
  assert.deepEqual(body.messages, messages);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.max_tokens, 321);
  assert.equal(body.max_completion_tokens, undefined);
});

test("AI configuration remains disabled without credentials or supported provider/model and requires workspace enablement", async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return success();
  }) as typeof fetch;
  for (const env of [
    {},
    configured({ OPENROUTER_API_KEY: "" }),
    configured({ LLM_MODEL: "" }),
    configured({ LLM_PROVIDER: "unsupported" }),
  ]) {
    const ai = createAi({ env, fetch: fetcher });
    assert.equal(ai.configured, false);
    assert.equal(ai.allowed("workspace-one"), false);
    await assert.rejects(ai.complete(messages), /not configured/);
  }
  assert.equal(calls, 0);
  const ai = createAi({ env: configured() });
  assert.equal(ai.allowed("workspace-one"), true);
  assert.equal(ai.allowed("workspace-two"), false);
  assert.equal(
    createAi({ env: configured({ LLM_WORKSPACE_IDS: "" }) }).allowed(
      "workspace-one",
    ),
    false,
  );
  assert.equal(
    createAi({
      env: configured({
        LLM_WORKSPACE_IDS: "",
        OPENAI_WORKSPACE_IDS: "workspace-one",
      }),
    }).allowed("workspace-one"),
    false,
  );
  const legacy = configured({ OPENAI_WORKSPACE_IDS: "workspace-one" });
  delete legacy.LLM_WORKSPACE_IDS;
  assert.equal(createAi({ env: legacy }).allowed("workspace-one"), true);
  const empty = configured();
  delete empty.LLM_WORKSPACE_IDS;
  assert.equal(createAi({ env: empty }).allowed("workspace-one"), false);
});

test("AI endpoint configuration rejects insecure or credential-bearing URLs and honors explicit base precedence", async () => {
  for (const base of [
    "http://gateway.example/v1",
    "https://user:secret@gateway.example/v1",
    "https://gateway.example/v1?key=secret",
    "https://gateway.example/v1#secret",
    "not a url",
  ]) {
    assert.throws(
      () => createAi({ env: configured({ OPENROUTER_BASE_URL: base }) }),
      (error) =>
        error instanceof Error &&
        /AI API base URL/.test(error.message) &&
        !error.message.includes("secret"),
    );
  }
  for (const [env, expected] of [
    [configured(), "https://openrouter.ai/api/v1/chat/completions"],
    [
      configured({
        OPENROUTER_API_BASE_URL: "https://explicit.example/api/v1/",
        OPENROUTER_BASE_URL: "https://alias.example",
      }),
      "https://explicit.example/api/v1/chat/completions",
    ],
    [
      {
        OPENAI_API_KEY: "synthetic-key",
        OPENAI_BASE_URL: "https://custom.example/v1/",
      },
      "https://custom.example/v1/chat/completions",
    ],
  ] as const) {
    const ai = createAi({
      env,
      fetch: (async (url) => {
        assert.equal(String(url), expected);
        return success();
      }) as typeof fetch,
    });
    await ai.complete(messages);
  }
});

test("explicit test key uses OpenAI protocol and interview configuration uses provider-specific reasoning without renaming models", async () => {
  const openai = createAi({
    env: configured({
      LLM_INTERVIEW_MODEL: "gpt-6-luna",
      LLM_INTERVIEW_REASONING_EFFORT: "low",
    }),
    apiKey: "test-key",
    model: "explicit-model",
    fetch: (async (url, init) => {
      assert.equal(String(url), "https://api.openai.com/v1/chat/completions");
      const body = JSON.parse(String(init!.body));
      assert.equal(body.model, "gpt-6-luna");
      assert.equal(body.reasoning_effort, "low");
      assert.equal(body.reasoning, undefined);
      assert.equal(body.max_completion_tokens, 8192);
      return success();
    }) as typeof fetch,
  });
  assert.equal(openai.provider, "openai");
  assert.equal(openai.model, "explicit-model");
  assert.equal(openai.allowed("test-workspace"), true);
  await openai.complete(messages, false, {
    interview: true,
    maxTokens: Infinity,
  });
  const router = createAi({
    env: configured({
      LLM_INTERVIEW_MODEL: "gpt-6-luna",
      LLM_INTERVIEW_REASONING_EFFORT: "medium",
    }),
    fetch: (async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      assert.equal(body.model, "gpt-6-luna");
      assert.deepEqual(body.reasoning, { effort: "medium" });
      assert.equal(body.reasoning_effort, undefined);
      assert.equal(body.max_tokens, 450);
      return success();
    }) as typeof fetch,
  });
  await router.complete(messages, false, { interview: true, maxTokens: 450.9 });
});

test("AI provider errors, malformed and oversized output are bounded, sanitized and never automatically retried", async () => {
  for (const handler of [
    () => new Response("secret provider error", { status: 429 }),
    () => new Response("secret provider error", { status: 500 }),
    () => {
      throw new Error("secret credential or URL");
    },
    () => new Response("secret malformed JSON"),
    () => new Response(null),
    () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "" } }] })),
    () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: ["not plain text"] } }],
        }),
      ),
    () => new Response("x".repeat(1_000_001)),
    () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: "unfinished text" },
              finish_reason: "length",
            },
          ],
        }),
      ),
  ]) {
    let count = 0;
    const ai = createAi({
      env: configured(),
      fetch: (async () => {
        count++;
        return handler();
      }) as typeof fetch,
    });
    await assert.rejects(
      ai.complete(messages),
      (error) =>
        error instanceof AiError &&
        error.status === 502 &&
        !/secret|unfinished text/.test(error.message),
    );
    assert.equal(count, 1);
  }
});

test("AI input shape, bytes and token budgets are bounded before provider submission", async () => {
  let count = 0;
  const budgets: number[] = [];
  const ai = createAi({
    env: configured(),
    fetch: (async (_url, init) => {
      count++;
      budgets.push(JSON.parse(String(init!.body)).max_tokens);
      return success();
    }) as typeof fetch,
  });
  for (const value of [
    [],
    [{ role: "user", content: "x".repeat(1_000_001) }],
    [{ role: "unsupported", content: "test" }],
    [null],
  ])
    await assert.rejects(ai.complete(value as any), AiError);
  assert.equal(count, 0);
  for (const budget of [-1, 9000, NaN])
    await ai.complete(messages, false, { maxTokens: budget });
  assert.deepEqual(budgets, [1, 8192, 8192]);
});

test("AI request cancellation is propagated and a previously aborted action never reaches the provider", async () => {
  let count = 0;
  const preAborted = new AbortController();
  preAborted.abort();
  const first = createAi({
    env: configured(),
    fetch: (async () => {
      count++;
      return success();
    }) as typeof fetch,
  });
  await assert.rejects(
    first.complete(messages, false, { signal: preAborted.signal }),
    /cancelled/,
  );
  assert.equal(count, 0);
  const controller = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const second = createAi({
    env: configured(),
    fetch: (async (_url, init) => {
      count++;
      entered();
      return new Promise<Response>((_resolve, reject) =>
        init!.signal!.addEventListener(
          "abort",
          () => reject(new Error("secret abort detail")),
          { once: true },
        ),
      );
    }) as typeof fetch,
  });
  const pending = second.complete(messages, false, {
    signal: controller.signal,
    timeoutMs: 120_000,
  });
  await started;
  controller.abort();
  await assert.rejects(
    pending,
    (error) =>
      error instanceof AiError &&
      error.message === "The AI request was cancelled.",
  );
  assert.equal(count, 1);
});

test("AI per-call deadlines default to 60 seconds and cannot exceed 120 seconds", async (t) => {
  const deadlines: number[] = [];
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    deadlines.push(milliseconds);
    return new AbortController().signal;
  });
  const ai = createAi({
    env: configured(),
    fetch: (async () => success()) as typeof fetch,
  });
  for (const timeoutMs of [
    undefined,
    120_000,
    900_000,
    0,
    -1,
    501.9,
    NaN,
    Infinity,
    "120000" as unknown as number,
  ])
    await ai.complete(messages, false, { timeoutMs });
  assert.deepEqual(
    deadlines,
    [60_000, 120_000, 120_000, 1, 1, 501, 60_000, 60_000, 60_000],
  );
});

test("AI deadline aborts both transport and response reading without retries or provider-detail leakage", async (t) => {
  for (const phase of ["transport", "body"] as const) {
    const deadline = new AbortController();
    const timer = t.mock.method(AbortSignal, "timeout", () => deadline.signal);
    let calls = 0;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const ai = createAi({
      env: configured(),
      fetch: (async (_url, init) => {
        calls++;
        const signal = init!.signal!;
        if (phase === "body")
          return new Response(
            new ReadableStream({
              start(controller) {
                signal.addEventListener(
                  "abort",
                  () => {
                    controller.error(
                      new Error("secret provider response detail"),
                    );
                  },
                  { once: true },
                );
                entered();
              },
            }),
          );
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(new Error("secret provider transport detail"));
            },
            { once: true },
          );
          entered();
        });
      }) as typeof fetch,
    });
    const pending = ai.complete(messages, false, { timeoutMs: 120_000 });
    await started;
    deadline.abort();
    await assert.rejects(
      pending,
      (error) =>
        error instanceof AiError &&
        error.message ===
          "The AI provider took too long to respond. Please try again.",
    );
    assert.equal(calls, 1);
    timer.mock.restore();
  }
});
