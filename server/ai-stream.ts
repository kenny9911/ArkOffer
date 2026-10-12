/** Bounded Chat Completions SSE reader. Partial generations never become usable drafts. */
export class AiStreamError extends Error {}

export async function readChatStream(
  response: Response,
  signal: AbortSignal,
  cancellationError: () => Error,
): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "",
    text = "",
    bytes = 0,
    terminal = false,
    completed = false;
  let data: string[] = [];
  let rejectAbort: (reason: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    rejectAbort(cancellationError());
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });

  const event = () => {
    if (!data.length) return;
    const value = data.join("\n");
    data = [];
    if (value === "[DONE]") {
      completed = true;
      return;
    }
    const chunk = JSON.parse(value);
    if (
      !chunk ||
      typeof chunk !== "object" ||
      Array.isArray(chunk) ||
      chunk.error
    )
      throw new AiStreamError(
        "The AI provider could not complete the streamed response. Please try again.",
      );
    if (!Array.isArray(chunk.choices)) {
      if (chunk.usage) return;
      throw new AiStreamError("The AI provider returned an unreadable stream.");
    }
    const choice = chunk.choices.find(
      (item: { index?: number }) => item?.index === 0,
    );
    if (!choice) return;
    if (choice.delta?.refusal)
      throw new AiStreamError(
        "The AI provider could not complete this request.",
      );
    const content = choice.delta?.content;
    if (
      content !== null &&
      content !== undefined &&
      typeof content !== "string"
    )
      throw new AiStreamError("The AI provider returned an unreadable stream.");
    if (content) {
      if (terminal)
        throw new AiStreamError(
          "The AI provider returned an invalid stream ending.",
        );
      text += content;
    }
    const finish = choice.finish_reason;
    if (finish === "length")
      throw new AiStreamError(
        "The AI answer reached its output limit. Please ask a narrower question.",
      );
    if (finish && finish !== "stop")
      throw new AiStreamError(
        "The AI provider could not complete this request.",
      );
    if (finish === "stop") terminal = true;
  };
  const feed = (value: string, eof = false) => {
    buffer += value;
    while (!completed) {
      const index = buffer.search(/[\r\n]/);
      if (index < 0) break;
      if (buffer[index] === "\r" && index === buffer.length - 1 && !eof) break;
      const line = buffer.slice(0, index);
      const length =
        buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1;
      buffer = buffer.slice(index + length);
      if (!line) event();
      else if (line === "data") data.push("");
      else if (line.startsWith("data:"))
        data.push(line.slice(5).replace(/^ /, ""));
      // SSE comments, IDs and event names do not contain model output.
    }
  };
  try {
    if (signal.aborted) throw cancellationError();
    while (!completed) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) {
        feed(decoder.decode(), true);
        break;
      }
      bytes += value.byteLength;
      if (bytes > 1_000_000)
        throw new AiStreamError(
          "The AI provider response exceeded the supported size.",
        );
      feed(decoder.decode(value, { stream: true }));
    }
    if (signal.aborted) throw cancellationError();
    if (!completed || !terminal)
      throw new AiStreamError(
        "The AI provider disconnected before completing the response. Please try again.",
      );
    if (!text.trim())
      throw new AiStreamError("The AI provider returned an empty response.");
    return text;
  } finally {
    signal.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
