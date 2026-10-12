/** Resend transport. No request is made until send() or retrieve() is called.
 * API contract: https://resend.com/docs/api-reference/emails/send-email
 * Idempotency keys: https://resend.com/docs/dashboard/emails/idempotency-keys
 */
export type MailConfig = {
  mode: "outbox" | "resend";
  apiKey: string;
  from: string;
  replyTo: string;
  publicUrl: string;
  workspaceIds: string[];
};
export type OutboundMail = {
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
  unsubscribeUrl?: string;
};
export class MailError extends Error {
  constructor(
    readonly kind: "retryable" | "unknown" | "permanent",
    message: string,
    readonly retryAfterMs = 0,
  ) {
    super(message);
  }
}
export function mailConfig(): MailConfig {
  return {
    mode: process.env.MAIL_MODE === "resend" ? "resend" : "outbox",
    apiKey: process.env.RESEND_API_KEY || "",
    from: process.env.MAIL_FROM || "",
    replyTo: process.env.MAIL_REPLY_TO || "",
    publicUrl: process.env.PUBLIC_APP_URL || "http://localhost:5174",
    workspaceIds: (process.env.MAIL_WORKSPACE_IDS || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  };
}
export function createMailTransport(
  config = mailConfig(),
  fetcher: typeof fetch = fetch,
) {
  const publicUrl = (() => {
    try {
      const url = new URL(config.publicUrl);
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/"
      )
        return "";
      if (config.mode === "resend" && url.protocol !== "https:") return "";
      if (!["http:", "https:"].includes(url.protocol)) return "";
      return url.origin;
    } catch {
      return "";
    }
  })();
  const validSender =
    !!config.from &&
    !/[\r\n]/.test(config.from) &&
    /[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>?$/.test(config.from);
  const validReply =
    !config.replyTo || /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(config.replyTo);
  const configured =
    config.mode === "outbox" ||
    (!!config.apiKey && validSender && validReply && !!publicUrl);
  const request = async (path: string, init: RequestInit) => {
    let response: Response;
    try {
      response = await fetcher(`https://api.resend.com${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
          ...init.headers,
        },
        signal: AbortSignal.timeout(12_000),
        redirect: "error",
      });
    } catch {
      throw new MailError(
        "unknown",
        "The provider response was not received. Delivery is unknown; this message will not be retried automatically.",
      );
    }
    if (!response.ok) {
      void response.body?.cancel();
      const retryable = response.status === 429 || response.status >= 500;
      const seconds = Number(response.headers.get("retry-after"));
      throw new MailError(
        retryable ? "retryable" : "permanent",
        `Email provider returned HTTP ${response.status}. ${retryable ? "A bounded retry is scheduled." : "Check the provider account, sender domain, and permissions."}`,
        Number.isFinite(seconds)
          ? Math.min(Math.max(seconds * 1000, 0), 3_600_000)
          : 0,
      );
    }
    try {
      return (await response.json()) as Record<string, unknown>;
    } catch {
      throw new MailError(
        "unknown",
        "The provider returned an unreadable response. Delivery is unknown; automatic retries are disabled.",
      );
    }
  };
  return {
    config,
    publicUrl,
    configured,
    allowed(workspaceId: string) {
      return (
        configured &&
        (config.mode === "outbox" || config.workspaceIds.includes(workspaceId))
      );
    },
    async send(
      message: OutboundMail,
    ): Promise<{ id: string; state: "accepted" | "outbox" }> {
      if (config.mode === "outbox")
        return { id: `outbox:${message.idempotencyKey}`, state: "outbox" };
      if (!configured)
        throw new MailError(
          "permanent",
          "Email delivery is not configured. Set the Resend key, verified sender, and HTTPS public URL.",
        );
      const data = await request("/emails", {
        method: "POST",
        headers: { "Idempotency-Key": message.idempotencyKey },
        body: JSON.stringify({
          from: config.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          ...(config.replyTo ? { reply_to: config.replyTo } : {}),
          ...(message.unsubscribeUrl
            ? { headers: { "List-Unsubscribe": `<${message.unsubscribeUrl}>` } }
            : {}),
        }),
      });
      if (
        typeof data.id !== "string" ||
        data.id.length > 128 ||
        !/^[a-zA-Z0-9-]+$/.test(data.id)
      )
        throw new MailError(
          "unknown",
          "The provider accepted the request without a usable message ID. Verify delivery in the provider dashboard; automatic retries are disabled.",
        );
      return { id: data.id, state: "accepted" };
    },
    async retrieve(id: string): Promise<string> {
      if (
        config.mode !== "resend" ||
        !configured ||
        !/^[a-zA-Z0-9-]{1,128}$/.test(id)
      )
        throw new MailError(
          "permanent",
          "Provider status is unavailable for this message.",
        );
      const data = await request(`/emails/${encodeURIComponent(id)}`, {
        method: "GET",
      });
      if (typeof data.last_event !== "string")
        throw new MailError(
          "permanent",
          "The provider did not return a delivery event.",
        );
      return data.last_event;
    },
  };
}
