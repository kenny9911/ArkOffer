import { test } from "node:test";
import assert from "node:assert/strict";
import { createAi, AiError } from "../../server/ai.js";

const messages = [{ role: "user", content: "Draft a synthetic job." }];
const success = () =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: "Draft" }, finish_reason: "stop" }],
    }),
  );

test("job drafting uses a bounded reasoning profile without changing the selected model or other tasks", async () => {
  for (const provider of ["openai", "openrouter"]) {
    for (const [model, expected] of [
      ["gpt-6.1-sol", "low"],
      ["openai/gpt-5.1", "low"],
      ["o3-mini", "low"],
      ["gpt-4.1-mini", undefined],
      ["custom-model", undefined],
      ["gpt-5-pro", undefined],
      ["gpt-5-chat-latest", undefined],
      ["openai/gpt-5.1-chat-latest", undefined],
      ["gpt-5-custom-alias", undefined],
      ["o3-deep-research", undefined],
    ] as const) {
      const requests: Record<string, any>[] = [];
      const ai = createAi({
        env: {
          LLM_PROVIDER: provider,
          OPENAI_API_KEY: "synthetic",
          OPENROUTER_API_KEY: "synthetic",
          LLM_MODEL: model,
        },
        fetch: async (_url, init) => {
          requests.push(JSON.parse(String(init?.body)));
          return success();
        },
      });
      await ai.complete(messages, true, {
        task: "job-draft",
        maxTokens: 4000,
        stream: true,
      });
      await ai.complete(messages);
      assert.equal(requests[0].model, model);
      assert.equal(
        requests[0].max_tokens ?? requests[0].max_completion_tokens,
        4000,
      );
      assert.equal(
        requests[0].reasoning?.effort ?? requests[0].reasoning_effort,
        expected,
      );
      assert.equal(
        requests[1].reasoning?.effort ?? requests[1].reasoning_effort,
        undefined,
      );
      assert.equal(requests.length, 2);
    }
  }
});

test("explicit task and general reasoning settings take precedence and invalid settings make no provider call", async () => {
  for (const [specific, general, expected] of [
    ["high", "low", "high"],
    [undefined, "medium", "medium"],
    ["provider", "high", undefined],
    ["", "provider", undefined],
    ["max", undefined, "max"],
    ["invalid-private-value", "low", "error"],
  ]) {
    let calls = 0;
    const ai = createAi({
      env: {
        LLM_PROVIDER: "openrouter",
        OPENROUTER_API_KEY: "synthetic",
        LLM_MODEL: "gpt-6.1-sol",
        LLM_JOB_REASONING_EFFORT: specific,
        LLM_REASONING_EFFORT: general,
      },
      fetch: async (_url, init) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(
          body.reasoning,
          expected ? { effort: expected } : undefined,
        );
        assert.equal(body.reasoning_effort, undefined);
        return success();
      },
    });
    if (expected === "error") {
      await assert.rejects(
        ai.complete(messages, true, { task: "job-draft" }),
        (error) =>
          error instanceof AiError &&
          error.message ===
            "The configured AI reasoning effort is unsupported.",
      );
      assert.equal(calls, 0);
    } else {
      assert.equal(
        await ai.complete(messages, true, { task: "job-draft" }),
        "Draft",
      );
      assert.equal(calls, 1);
    }
  }
});

test("stalled JSON fallback is explicitly cancelled on deadline or caller abort even if its stream ignores the signal", async (t) => {
  for (const deadline of [false, true]) {
    const controller = new AbortController();
    const timer = deadline
      ? t.mock.method(AbortSignal, "timeout", () => controller.signal)
      : null;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0,
      cancellations = 0;
    const ai = createAi({
      apiKey: "synthetic",
      fetch: async () => {
        calls++;
        return new Response(
          new ReadableStream({
            pull() {
              entered();
            },
            cancel() {
              cancellations++;
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    });
    const pending = ai.complete(messages, true, {
      stream: true,
      ...(deadline ? {} : { signal: controller.signal }),
    });
    await started;
    controller.abort();
    await assert.rejects(pending, deadline ? /took too long/ : /cancelled/);
    assert.equal(calls, 1);
    assert.equal(cancellations, 1);
    timer?.mock.restore();
  }
});
