import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Database, Video, RefreshCw } from "lucide-react";
import {
  api,
  json,
  Button,
  Field,
  ErrorBanner,
  Loading,
  useToast,
} from "../ui";

type Provider = {
  id: string;
  name: string;
  configured: boolean;
  allowed: boolean;
  canManage: boolean;
  missing: string[];
  lastSync?: string;
  lastError?: string;
  counts?: Record<string, number>;
};
type Capture = {
  id: string;
  title: string;
  meetingUrl: string;
  joinAt: string | null;
  status: string;
  transcriptReady: boolean;
  conversationId: string | null;
  importedAt: string | null;
  lastError: string | null;
  canCancel: boolean;
  canLeave: boolean;
  events: { operation: string; status: string; occurredAt: string }[];
};
export default function ProviderSettings() {
  const [providers, setProviders] = useState<Provider[] | null>(null),
    [captures, setCaptures] = useState<Capture[]>([]),
    [workspaceId, setWorkspaceId] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(""),
    [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const toast = useToast();
  async function load() {
    const [p, c] = await Promise.all([api("providers"), api("captures")]);
    setProviders(p.items);
    setWorkspaceId(p.workspaceId);
    setCaptures(c.items);
  }
  useEffect(() => {
    let active = true;
    Promise.all([api("providers"), api("captures")])
      .then(([p, c]) => {
        if (active) {
          setProviders(p.items);
          setWorkspaceId(p.workspaceId);
          setCaptures(c.items);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  async function run(
    key: string,
    operation: () => Promise<any>,
    message: string,
  ) {
    setBusy(key);
    setError("");
    try {
      const result = await operation();
      await load();
      toast(message);
      return result;
    } catch (e) {
      setError((e as Error).message);
      await load().catch(() => {});
      return null;
    } finally {
      setBusy("");
    }
  }
  const recall = providers?.find((p) => p.id === "recall");
  return (
    <section
      aria-labelledby="provider-settings-title"
      style={{ marginTop: 36 }}
    >
      <h2 id="provider-settings-title">ATS and meeting capture</h2>
      <p className="muted">
        These services use your organization’s provider accounts. Only workspace
        owners and admins in workspaces enabled by the server administrator can
        run them.
      </p>
      <ErrorBanner error={error} />
      {!providers && !error ? <Loading /> : null}
      <div className="integration-grid">
        {providers?.map((provider) => (
          <article className="integration-card" key={provider.id}>
            <div className="integration-icon">
              {provider.id === "greenhouse" ? (
                <Database size={23} />
              ) : (
                <Video size={23} />
              )}
            </div>
            <h3>{provider.name}</h3>
            <span className={`badge ${provider.configured ? "green" : ""}`}>
              {provider.configured ? "Configured" : "Setup required"}
            </span>
            <p className="muted">
              {provider.id === "greenhouse"
                ? "Import non-private candidates, non-confidential jobs and associated applications. Later syncs refresh provider snapshots and preserve your local edits and decisions. Greenhouse is never modified."
                : "Send a visible recording bot to a Google Meet, Zoom or Teams meeting. Recall records and transcribes the call using your provider account; provider usage charges apply."}
            </p>
            {!provider.configured ? (
              <details>
                <summary>Server setup needed</summary>
                <ul>
                  {provider.missing.map((name) => (
                    <li key={name}>
                      <code style={{ overflowWrap: "anywhere" }}>{name}</code>
                    </li>
                  ))}
                </ul>
                <p className="muted">
                  Workspace ID:{" "}
                  <code style={{ overflowWrap: "anywhere" }}>
                    {workspaceId}
                  </code>
                </p>
                {provider.id === "greenhouse" ? (
                  <p className="muted">
                    Use Harvest v3 credentials with read-only candidate, job and
                    application permissions. The optional GREENHOUSE_USER_ID
                    must authorize listing these resources.
                  </p>
                ) : (
                  <p className="muted">
                    RECALL_REGION defaults to us-east-1. Your Recall API key
                    must belong to the selected region.
                  </p>
                )}
              </details>
            ) : null}
            {!provider.canManage ? (
              <p className="muted">
                A workspace owner or admin manages this integration.
              </p>
            ) : null}
            {provider.id === "greenhouse" ? (
              <>
                <ErrorBanner error={provider.lastError || ""} />
                {provider.lastSync ? (
                  <p className="muted">
                    Last sync: {new Date(provider.lastSync).toLocaleString()}.{" "}
                    {Object.entries(provider.counts || {})
                      .map(([kind, count]) => `${count} ${kind}`)
                      .join(" · ")}
                  </p>
                ) : null}
                <Button
                  disabled={
                    !!busy || !provider.configured || !provider.canManage
                  }
                  busy={busy === "greenhouse"}
                  onClick={() =>
                    run(
                      "greenhouse",
                      () => api("providers/greenhouse/sync", json("POST", {})),
                      "Greenhouse import completed",
                    )
                  }
                >
                  <RefreshCw size={15} />
                  Sync Greenhouse
                </Button>
              </>
            ) : null}
          </article>
        ))}
      </div>
      <h3 style={{ marginTop: 28 }}>Meeting captures</h3>
      <p className="muted">
        Schedule at least 10 minutes ahead, or leave the time empty to join now.
        Ask participants for permission before recording. Status refresh and
        transcript import run only when you choose them.
      </p>
      <form
        style={{ maxWidth: 650 }}
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget,
            data = new FormData(form),
            when = String(data.get("joinAt") || "");
          const result = await run(
            "create",
            () =>
              api(
                "captures",
                json("POST", {
                  title: String(data.get("title") || ""),
                  meetingUrl: String(data.get("meetingUrl") || ""),
                  joinAt: when ? new Date(when).toISOString() : null,
                  consent: data.get("consent") === "on",
                  requestKey,
                }),
              ),
            "Capture request saved",
          );
          if (result && ["unknown", "failed"].includes(result.item.status)) {
            setError(
              result.item.lastError ||
                "Review the capture status before trying again.",
            );
          } else if (result) {
            form.reset();
            setRequestKey(crypto.randomUUID());
          }
        }}
      >
        <Field label="Capture title">
          <input
            name="title"
            required
            maxLength={300}
            placeholder="Product design interview"
          />
        </Field>
        <Field label="Meeting URL">
          <input
            name="meetingUrl"
            type="url"
            required
            maxLength={3000}
            placeholder="https://meet.google.com/abc-defg-hij"
          />
        </Field>
        <Field label="Join time (your local time)">
          <input name="joinAt" type="datetime-local" />
        </Field>
        <label
          style={{
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            margin: "16px 0",
          }}
        >
          <input
            name="consent"
            type="checkbox"
            required
            style={{ width: "auto", marginTop: 4 }}
          />
          <span>
            I have permission to record this meeting and will inform all
            participants. I authorize using this workspace’s Recall account for
            recording and transcription.
          </span>
        </label>
        <Button
          variant="primary"
          type="submit"
          disabled={!!busy || !recall?.configured || !recall?.canManage}
          busy={busy === "create"}
        >
          <Video size={16} />
          Create recording capture
        </Button>
        <Button
          type="button"
          disabled={!!busy}
          onClick={() => {
            setRequestKey(crypto.randomUUID());
            setError("");
          }}
        >
          Start a new request
        </Button>
      </form>
      {!captures.length ? (
        <p className="muted" style={{ marginTop: 24 }}>
          No meeting captures yet.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 16, marginTop: 24 }}>
          {captures.map((capture) => (
            <article className="integration-card" key={capture.id}>
              <h3>{capture.title}</h3>
              <span className="badge">
                {capture.status.replaceAll("_", " ")}
              </span>
              <p className="muted" style={{ overflowWrap: "anywhere" }}>
                {capture.meetingUrl}
              </p>
              {capture.joinAt ? (
                <p className="muted">
                  Scheduled: {new Date(capture.joinAt).toLocaleString()}
                </p>
              ) : null}
              <ErrorBanner error={capture.lastError || ""} />
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Button
                  disabled={!!busy || !recall?.configured || !recall?.canManage}
                  onClick={() =>
                    run(
                      capture.id,
                      () =>
                        api(`captures/${capture.id}/refresh`, json("POST", {})),
                      "Capture status refreshed",
                    )
                  }
                >
                  <RefreshCw size={15} />
                  Refresh status
                </Button>
                {capture.conversationId ? (
                  <Link
                    className="button"
                    to={`/app/notes/${capture.conversationId}`}
                  >
                    Open conversation
                  </Link>
                ) : (
                  <Button
                    disabled={
                      !!busy ||
                      !recall?.configured ||
                      !recall?.canManage ||
                      !capture.transcriptReady ||
                      !!capture.importedAt
                    }
                    onClick={() =>
                      run(
                        capture.id,
                        () =>
                          api(
                            `captures/${capture.id}/import`,
                            json("POST", {}),
                          ),
                        "Transcript imported into Notes",
                      )
                    }
                  >
                    Import transcript
                  </Button>
                )}
                {capture.canCancel ? (
                  <Button
                    disabled={
                      !!busy || !recall?.configured || !recall?.canManage
                    }
                    onClick={() =>
                      run(
                        capture.id,
                        () => api(`captures/${capture.id}`, json("DELETE", {})),
                        "Scheduled capture cancelled",
                      )
                    }
                  >
                    Cancel scheduled capture
                  </Button>
                ) : capture.canLeave ? (
                  <Button
                    disabled={
                      !!busy || !recall?.configured || !recall?.canManage
                    }
                    onClick={() =>
                      run(
                        capture.id,
                        () =>
                          api(`captures/${capture.id}/leave`, json("POST", {})),
                        "Recall accepted the request to leave",
                      )
                    }
                  >
                    Leave call
                  </Button>
                ) : null}
              </div>
              {capture.status === "unknown" ? (
                <details style={{ marginTop: 12 }}>
                  <summary>Recover a bot created by Recall</summary>
                  <p className="muted">
                    If this request created a bot in your Recall dashboard,
                    enter its bot ID. ArkOffer verifies that the bot belongs to
                    this exact capture before linking it.
                  </p>
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const botId = String(
                        new FormData(e.currentTarget).get("botId") || "",
                      ).trim();
                      await run(
                        capture.id,
                        () =>
                          api(
                            `captures/${capture.id}/recover`,
                            json("POST", { botId }),
                          ),
                        "Capture recovered from Recall",
                      );
                    }}
                  >
                    <Field label="Recall bot ID">
                      <input name="botId" required maxLength={36} />
                    </Field>
                    <Button
                      type="submit"
                      disabled={
                        !!busy || !recall?.configured || !recall?.canManage
                      }
                    >
                      Recover capture
                    </Button>
                  </form>
                </details>
              ) : null}
              {capture.importedAt && !capture.conversationId ? (
                <p className="muted">
                  The imported conversation was deleted and will not be
                  recreated.
                </p>
              ) : null}
              <details style={{ marginTop: 12 }}>
                <summary>Capture history</summary>
                <ul>
                  {capture.events.map((event, index) => (
                    <li key={index}>
                      {new Date(event.occurredAt).toLocaleString()} ·{" "}
                      {event.operation}: {event.status.replaceAll("_", " ")}
                    </li>
                  ))}
                </ul>
              </details>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
