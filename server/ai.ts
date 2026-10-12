/** Server-only OpenAI-compatible text adapter, including RoboApply environment names. */
import { AiStreamError, readChatStream } from "./ai-stream.js";
export class AiError extends Error {
  readonly status = 502;
}
type Options = {
  env?: NodeJS.ProcessEnv;
  apiKey?: string;
  model?: string;
  fetch?: typeof fetch;
};
export function createAi(options: Options = {}) {
  const env = options.env || process.env;
  const injected = options.apiKey !== undefined;
  const provider = injected
    ? "openai"
    : (env.LLM_PROVIDER?.trim() || "openai").toLowerCase();
  const supported = ["openai", "openrouter"].includes(provider);
  const apiKey = (
    injected
      ? options.apiKey
      : provider === "openrouter"
        ? env.OPENROUTER_API_KEY
        : env.OPENAI_API_KEY
  )?.trim();
  const model =
    options.model?.trim() ||
    env.LLM_MODEL?.trim() ||
    (provider === "openai" ? env.OPENAI_MODEL?.trim() || "gpt-4.1-mini" : "");
  const configured = Boolean(supported && apiKey?.trim() && model);
  const rawBase = injected
    ? "https://api.openai.com/v1"
    : provider === "openrouter"
      ? env.OPENROUTER_API_BASE_URL ||
        env.OPENROUTER_BASE_URL ||
        "https://openrouter.ai/api/v1"
      : env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  let endpoint = "";
  if (configured) {
    let base: URL;
    try {
      base = new URL(rawBase);
    } catch {
      throw new Error("AI API base URL is invalid.");
    }
    if (
      base.protocol !== "https:" ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw new Error(
        "AI API base URL must use HTTPS without credentials, query or fragment.",
      );
    endpoint = `${base.toString().replace(/\/$/, "")}/chat/completions`;
  }
  const allowed = (workspaceId: string) =>
    configured &&
    (injected ||
      (env.LLM_WORKSPACE_IDS ?? env.OPENAI_WORKSPACE_IDS ?? "")
        .split(",")
        .map((s) => s.trim())
        .includes(workspaceId));
  return {
    provider,
    model,
    configured,
    allowed,
    async complete(
      messages: Array<{ role: string; content: string }>,
      json = false,
      settings: {
        interview?: boolean;
        task?: "job-draft";
        signal?: AbortSignal;
        maxTokens?: number;
        timeoutMs?: number;
        stream?: boolean;
      } = {},
    ) {
      if (!configured)
        throw new AiError("The text AI provider is not configured.");
      if (settings.signal?.aborted)
        throw new AiError("The AI request was cancelled.");
      const chosenModel = settings.interview
        ? env.LLM_INTERVIEW_MODEL?.trim() || model
        : model;
      const configuredEffort =
        (settings.interview
          ? env.LLM_INTERVIEW_REASONING_EFFORT?.trim()
          : settings.task === "job-draft"
            ? env.LLM_JOB_REASONING_EFFORT?.trim()
            : undefined) || env.LLM_REASONING_EFFORT?.trim();
      // Use a short drafting profile only for recognized reasoning families.
      // Explicit configuration always wins; unknown models retain provider defaults.
      const jobReasoningModel =
        /^(?:openai\/)?(?:gpt-[56](?:\.\d+)?(?:-(?:mini|nano|sol|astra|luna))?|o[34](?:-mini)?|o1)(?:-\d{4}-\d{2}-\d{2})?$/i.test(
          chosenModel,
        );
      const effort =
        configuredEffort ||
        (settings.task === "job-draft" && jobReasoningModel
          ? "low"
          : undefined);
      if (
        effort &&
        ![
          "provider",
          "none",
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
        ].includes(effort)
      )
        throw new AiError("The configured AI reasoning effort is unsupported.");
      const reasoning =
        effort && effort !== "provider"
          ? provider === "openrouter"
            ? { reasoning: { effort } }
            : { reasoning_effort: effort }
          : {};
      const tokens = Number.isFinite(settings.maxTokens)
        ? Math.max(1, Math.min(Math.floor(settings.maxTokens!), 8192))
        : 8192;
      const timeoutMs = Number.isFinite(settings.timeoutMs)
        ? Math.max(1, Math.min(Math.floor(settings.timeoutMs!), 120_000))
        : 60_000;
      if (
        !Array.isArray(messages) ||
        !messages.length ||
        messages.length > 100 ||
        messages.some(
          (message) =>
            !message ||
            typeof message !== "object" ||
            !["system", "developer", "user", "assistant"].includes(
              message.role,
            ) ||
            typeof message.content !== "string",
        )
      )
        throw new AiError("The AI request contains unsupported messages.");
      const body = JSON.stringify({
        model: chosenModel,
        messages,
        ...(provider === "openrouter"
          ? { max_tokens: tokens }
          : { max_completion_tokens: tokens }),
        ...reasoning,
        ...(settings.stream ? { stream: true } : {}),
        ...(json ? { response_format: { type: "json_object" } } : {}),
      });
      if (Buffer.byteLength(body) > 1_000_000)
        throw new AiError(
          "The AI request exceeded the supported size. Please use less source material.",
        );
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = settings.signal
        ? AbortSignal.any([settings.signal, timeoutSignal])
        : timeoutSignal;
      const cancellationError = () =>
        settings.signal?.aborted
          ? new AiError("The AI request was cancelled.")
          : timeoutSignal.aborted
            ? new AiError(
                "The AI provider took too long to respond. Please try again.",
              )
            : null;
      let response: Response;
      try {
        response = await (options.fetch || fetch)(endpoint, {
          method: "POST",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body,
          signal,
        });
      } catch {
        throw (
          cancellationError() ||
          new AiError("The AI provider could not be reached. Please try again.")
        );
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new AiError(
          "The AI provider could not complete the request. Check its configuration and quota.",
        );
      }
      if (!response.body)
        throw new AiError("The AI provider returned an empty response.");
      if (
        response.headers
          .get("content-type")
          ?.split(";")[0]
          .trim()
          .toLowerCase() === "text/event-stream"
      ) {
        try {
          return await readChatStream(
            response,
            signal,
            () =>
              cancellationError() ||
              new AiError("The AI request was cancelled."),
          );
        } catch (error) {
          if (error instanceof AiError) throw error;
          throw (
            cancellationError() ||
            new AiError(
              error instanceof AiStreamError
                ? error.message
                : "The AI provider returned an unreadable stream.",
            )
          );
        }
      }
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      let rejectAbort: (error: Error) => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
      });
      const onAbort = () => {
        rejectAbort(
          cancellationError() || new AiError("The AI request was cancelled."),
        );
        void reader.cancel().catch(() => {});
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        if (signal.aborted)
          throw (
            cancellationError() || new AiError("The AI request was cancelled.")
          );
        while (true) {
          const { done, value } = await Promise.race([reader.read(), aborted]);
          if (done) break;
          size += value.length;
          if (size > 1_000_000) {
            await reader.cancel();
            throw new AiError(
              "The AI provider response exceeded the supported size.",
            );
          }
          chunks.push(value);
        }
        if (signal.aborted)
          throw (
            cancellationError() || new AiError("The AI request was cancelled.")
          );
        const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (result?.choices?.[0]?.finish_reason === "length")
          throw new AiError(
            "The AI answer reached its output limit. Please ask a narrower question.",
          );
        const choice = result?.choices?.[0];
        if (
          settings.stream &&
          (result?.error ||
            choice?.finish_reason !== "stop" ||
            choice?.message?.refusal ||
            (choice?.index !== undefined && choice.index !== 0))
        )
          throw new AiError(
            "The AI provider did not return a completed response. Please try again.",
          );
        const text = result?.choices?.[0]?.message?.content;
        if (typeof text !== "string" || !text.trim())
          throw new AiError("The AI provider returned an empty response.");
        return text;
      } catch (error) {
        if (error instanceof AiError) throw error;
        throw (
          cancellationError() ||
          new AiError("The AI provider returned an unreadable response.")
        );
      } finally {
        signal.removeEventListener("abort", onAbort);
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    },
  };
}
