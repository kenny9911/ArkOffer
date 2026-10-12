import { useEffect, useState } from "react";
import { MessageSquare, RefreshCw } from "lucide-react";
import {
  api,
  json,
  Button,
  ErrorBanner,
  Field,
  Loading,
  useToast,
} from "../ui";

type Schedule = {
  kind: "digest" | "reminder";
  enabled: number;
  hourUtc: number;
  delivery: "draft" | "automatic";
  nextAt: number;
};
type Job = {
  id: string;
  kind: string;
  status: string;
  body: string;
  revision: string;
  error: string;
  createdAt: number;
};
type Status = {
  configured: boolean;
  missing: string[];
  canManage: boolean;
  connected: boolean;
  linked: boolean;
  teamName: string | null;
  slackUserId: string | null;
  redirectUri: string | null;
  commandUrl: string | null;
  eventsUrl: string | null;
  scopes: string[];
  schedules: Schedule[];
  jobs: Job[];
};
const names = {
  digest: "Activity digest",
  reminder: "Interview reminder",
  ask: "Knowledge question",
};

export default function SlackSettings() {
  const [data, setData] = useState<Status | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(""),
    [code, setCode] = useState<{ command: string; expiresAt: number } | null>(
      null,
    );
  const toast = useToast();
  async function load() {
    setData(await api("slack"));
  }
  useEffect(() => {
    let active = true;
    api("slack")
      .then((result) => {
        if (active) setData(result);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    if (new URLSearchParams(window.location.search).get("slack") === "denied")
      setError(
        "Slack installation was cancelled. You can connect again when ready.",
      );
    return () => {
      active = false;
    };
  }, []);
  async function act(
    key: string,
    path: string,
    method: string,
    body?: unknown,
  ) {
    setBusy(key);
    setError("");
    try {
      const result = await api(path, json(method, body));
      if (key === "connect") {
        const url = new URL(result.url);
        if (
          url.origin !== "https://slack.com" ||
          url.pathname !== "/oauth/v2/authorize"
        )
          throw new Error("Invalid Slack authorization URL.");
        window.location.assign(url.href);
        return;
      }
      if (key === "link") setCode(result);
      if (key === "unlink" || key === "disconnect") setCode(null);
      await load();
      if (key !== "link")
        toast(
          result.message ||
            (key === "draft"
              ? "Draft queued. Refresh to review it."
              : "Slack settings updated"),
        );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function refresh() {
    setBusy("refresh");
    setError("");
    try {
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <section
      className="settings-section slack-settings"
      aria-labelledby="slack-settings-title"
    >
      <h2 id="slack-settings-title">
        <MessageSquare size={20} /> Slack assistant
      </h2>
      <p className="muted">
        Ask about interview notes you can access and schedule personal activity
        updates. Answers and approved messages go only to your private DM with
        ArkOffer.
      </p>
      <ErrorBanner error={error} />
      {!data && !error ? <Loading /> : null}
      {data ? (
        <>
          <p>
            <span className={`badge ${data.connected ? "green" : ""}`}>
              {data.connected
                ? `Connected to ${data.teamName}`
                : data.configured
                  ? "Ready to install"
                  : "Setup required"}
            </span>
          </p>
          {!data.connected ? (
            <Button
              variant="primary"
              disabled={!!busy || !data.configured || !data.canManage}
              onClick={() => act("connect", "slack/connect", "POST", {})}
            >
              Install Slack app
            </Button>
          ) : null}
          {!data.canManage && !data.connected ? (
            <p className="muted">
              A workspace owner or administrator must install the app.
            </p>
          ) : null}
          {!data.configured || data.canManage ? (
            <details style={{ marginTop: 12 }}>
              <summary>Slack app setup</summary>
              <p>
                Create a dedicated Slack app with bot scopes{" "}
                <code>{data.scopes.join(", ")}</code>. Configure{" "}
                <code>/arkoffer</code> and subscribe to{" "}
                <code>app_uninstalled</code> and <code>tokens_revoked</code>.
                Keep token rotation disabled; rotating and Enterprise-wide
                installs are not supported.
              </p>
              {data.missing.length ? (
                <p>
                  Server configuration needed:{" "}
                  <code>{data.missing.join(", ")}</code>. Ask the operator to
                  authorize this ArkOffer workspace and the intended Slack team.
                </p>
              ) : null}
              <p>
                Slack requires a publicly reachable HTTPS endpoint for real
                event delivery.
              </p>
              <dl style={{ overflowWrap: "anywhere" }}>
                <dt>OAuth redirect URL</dt>
                <dd>
                  {data.redirectUri || "Configure the ArkOffer origin first"}
                </dd>
                <dt>Slash command request URL</dt>
                <dd>{data.commandUrl || "Not configured"}</dd>
                <dt>Events request URL</dt>
                <dd>{data.eventsUrl || "Not configured"}</dd>
              </dl>
            </details>
          ) : null}
          {data.connected ? (
            <>
              <h3>Your Slack account</h3>
              <p>
                {data.linked
                  ? `Linked to Slack user ${data.slackUserId}.`
                  : "Link your own Slack account with a short-lived code. Email addresses are never used to link accounts automatically."}
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {data.linked ? (
                  <Button
                    disabled={!!busy}
                    onClick={() => act("unlink", "slack/link", "DELETE")}
                  >
                    Unlink my Slack account
                  </Button>
                ) : (
                  <Button
                    disabled={!!busy || !data.configured}
                    onClick={() => act("link", "slack/link", "POST", {})}
                  >
                    Generate link code
                  </Button>
                )}
                <Button disabled={!!busy} onClick={refresh}>
                  <RefreshCw size={15} /> Refresh Slack status
                </Button>
              </div>
              {code && !data.linked ? (
                <div role="status">
                  <p>
                    Run this command as yourself in the connected Slack
                    workspace. Keep the code private; it expires at{" "}
                    {new Date(code.expiresAt).toLocaleTimeString()} and can be
                    used once.
                  </p>
                  <code style={{ overflowWrap: "anywhere" }}>
                    {code.command}
                  </code>
                  <p>Then refresh Slack status here.</p>
                </div>
              ) : null}
              {data.linked ? (
                <>
                  <p>
                    In Slack, use{" "}
                    <code>
                      /arkoffer ask What did we learn about the candidate’s
                      experience?
                    </code>{" "}
                    Questions use your current ArkOffer access. The command
                    acknowledges privately and queues an answer.
                  </p>
                  <h3>Your daily updates</h3>
                  <p className="muted">
                    Schedules are off until enabled. Drafts await your approval
                    here. Automatic delivery is an explicit opt-in for messages
                    to your own linked Slack account. Updates never contact
                    candidates or change recruiting records.
                  </p>
                  {(["digest", "reminder"] as const).map((kind) => {
                    const schedule = data.schedules.find(
                      (s) => s.kind === kind,
                    );
                    return (
                      <form
                        key={`${kind}:${JSON.stringify(schedule)}`}
                        onSubmit={(e) => {
                          e.preventDefault();
                          const values = new FormData(e.currentTarget);
                          void act(
                            `schedule:${kind}`,
                            "slack/schedule",
                            "PUT",
                            {
                              kind,
                              enabled: values.get("enabled") === "on",
                              hourUtc: Number(values.get("hourUtc")),
                              delivery: values.get("delivery"),
                            },
                          );
                        }}
                        style={{ marginBottom: 24 }}
                      >
                        <h4>{names[kind]}</h4>
                        <p className="muted">
                          {kind === "digest"
                            ? "Titles of accessible interviews updated in the previous 24 hours, up to 15."
                            : "Titles of accessible interviews scheduled in the next 24 hours, up to 15."}
                        </p>
                        <fieldset
                          disabled={!!busy || !data.configured}
                          className="settings-fields"
                        >
                          <label>
                            <input
                              type="checkbox"
                              name="enabled"
                              defaultChecked={!!schedule?.enabled}
                            />{" "}
                            Enable {names[kind].toLowerCase()}
                          </label>
                          <Field label={`${names[kind]} time (UTC)`}>
                            <select
                              name="hourUtc"
                              defaultValue={schedule?.hourUtc ?? 9}
                            >
                              {Array.from({ length: 24 }, (_, hour) => (
                                <option key={hour} value={hour}>
                                  {String(hour).padStart(2, "0")}:00 UTC
                                </option>
                              ))}
                            </select>
                          </Field>
                          <Field label={`${names[kind]} delivery`}>
                            <select
                              name="delivery"
                              defaultValue={schedule?.delivery || "draft"}
                            >
                              <option value="draft">
                                Create a draft for my approval
                              </option>
                              <option value="automatic">
                                Automatically send to my private DM
                              </option>
                            </select>
                          </Field>
                          <div
                            style={{
                              display: "flex",
                              gap: 8,
                              flexWrap: "wrap",
                            }}
                          >
                            <Button type="submit">
                              Save {names[kind].toLowerCase()}
                            </Button>
                            <Button
                              type="button"
                              onClick={() =>
                                act("draft", "slack/drafts", "POST", { kind })
                              }
                            >
                              Draft {names[kind].toLowerCase()} now
                            </Button>
                          </div>
                        </fieldset>
                        {schedule?.enabled ? (
                          <p className="muted">
                            Next run:{" "}
                            {new Date(schedule.nextAt).toLocaleString()}
                          </p>
                        ) : null}
                      </form>
                    );
                  })}
                </>
              ) : null}
              {data.canManage ? (
                <div>
                  <Button
                    disabled={!!busy}
                    onClick={() => act("disconnect", "slack", "DELETE")}
                  >
                    Disconnect workspace Slack
                  </Button>
                  <p className="muted">
                    Disconnect cancels pending jobs and schedules for the
                    workspace and removes saved credentials.
                  </p>
                </div>
              ) : null}
            </>
          ) : null}
          {data.jobs.length ? (
            <div>
              <h3>Your Slack queue</h3>
              <p className="muted">
                Drafts expire after 24 hours. Unknown delivery means Slack may
                have received the message; automatic retries are disabled.
              </p>
              {data.jobs.map((job) => (
                <article
                  key={job.id}
                  className="integration-card"
                  style={{ marginBottom: 12 }}
                >
                  <h4>{names[job.kind as keyof typeof names] || job.kind}</h4>
                  <p>
                    <span className="badge">{job.status}</span> ·{" "}
                    {new Date(job.createdAt).toLocaleString()}
                  </p>
                  {job.error ? <p>{job.error}</p> : null}
                  {job.body ? (
                    <pre
                      style={{
                        whiteSpace: "pre-wrap",
                        overflowWrap: "anywhere",
                        fontFamily: "inherit",
                      }}
                    >
                      {job.body}
                    </pre>
                  ) : null}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {job.status === "draft" ? (
                      <Button
                        variant="primary"
                        disabled={!!busy}
                        onClick={() =>
                          act(
                            `approve:${job.id}`,
                            `slack/jobs/${job.id}/approve`,
                            "POST",
                            { revision: job.revision },
                          )
                        }
                      >
                        Approve and send to my DM
                      </Button>
                    ) : null}
                    {["draft", "queued", "processing"].includes(job.status) ? (
                      <Button
                        disabled={!!busy}
                        onClick={() =>
                          act(
                            `cancel:${job.id}`,
                            `slack/jobs/${job.id}`,
                            "DELETE",
                          )
                        }
                      >
                        Cancel Slack job
                      </Button>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
