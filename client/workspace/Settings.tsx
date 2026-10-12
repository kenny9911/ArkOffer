import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ArrowUpRight,
  Check,
  Link2,
  Shield,
  UserRound,
  Building2,
  Plug,
  SlidersHorizontal,
  Info,
} from "lucide-react";
import {
  api,
  json,
  Button,
  Field,
  ErrorBanner,
  Loading,
  useAuth,
  useToast,
  type Item,
} from "../ui";
export default function Settings() {
  const { user, reload } = useAuth();
  const [params, setParams] = useSearchParams(),
    tab = params.get("tab") || "personal";
  const [data, setData] = useState<any>(null),
    [integrations, setIntegrations] = useState<Item[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => {
    Promise.all([api("settings"), api("integrations")])
      .then(([s, i]) => {
        setData(s);
        setIntegrations(i.items);
      })
      .catch((e) => setError(e.message));
  }, []);
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget),
      values = Object.fromEntries(f.entries());
    try {
      const r = await api(
        "settings",
        json(
          "PATCH",
          tab === "personal"
            ? { name: values.name }
            : { workspaceName: values.workspaceName, settings: values },
        ),
      );
      setData(r);
      await reload();
      toast("Settings saved");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">
        {[
          ["personal", "Personal", UserRound],
          ["workspace", "Workspace", Building2],
          ["integrations", "Integrations", Plug],
          ["privacy", "Privacy & data", Shield],
        ].map(([id, name, Icon]: any) => (
          <button
            className={tab === id ? "selected" : ""}
            key={id}
            onClick={() => setParams({ tab: id })}
          >
            <Icon size={18} />
            {name}
          </button>
        ))}
      </nav>
      <main className="settings-main">
        <ErrorBanner error={error} />
        {!data ? (
          <Loading />
        ) : tab === "personal" ? (
          <>
            <h1>Personal settings</h1>
            <p className="muted">Manage how you appear in your workspace.</p>
            <form key="personal" onSubmit={save}>
              <Field label="Your name">
                <input
                  name="name"
                  defaultValue={user?.name}
                  required
                  maxLength={100}
                />
              </Field>
              <Field label="Email address">
                <input value={user?.email || ""} disabled readOnly />
              </Field>
              <Field label="Role">
                <input value={user?.role || "Member"} readOnly disabled />
              </Field>
              <Button variant="primary" type="submit" busy={busy}>
                Save changes
              </Button>
            </form>
          </>
        ) : tab === "workspace" ? (
          <>
            <h1>Workspace settings</h1>
            <p className="muted">
              Set the defaults for your recruiting workspace.
            </p>
            <form key="workspace" onSubmit={save}>
              <Field label="Workspace name">
                <input
                  name="workspaceName"
                  defaultValue={user?.workspaceName}
                  required
                />
              </Field>
              <Field label="Default language">
                <select
                  name="language"
                  defaultValue={data.settings?.language || "English"}
                >
                  {[
                    "English",
                    "Chinese",
                    "French",
                    "German",
                    "Spanish",
                    "Japanese",
                    "Portuguese",
                  ].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </Field>
              <Field label="Default note format">
                <select
                  name="noteFormat"
                  defaultValue={data.settings?.noteFormat || "Bullets"}
                >
                  <option>Bullets</option>
                  <option>Paragraphs</option>
                </select>
              </Field>
              <Field label="Default note length">
                <select
                  name="noteLength"
                  defaultValue={data.settings?.noteLength || "standard"}
                >
                  <option value="concise">Concise</option>
                  <option value="standard">Standard</option>
                  <option value="detailed">Detailed</option>
                </select>
              </Field>
              <Field
                label="Company context"
                hint="Save context for your team to reference when preparing interviews."
              >
                <textarea
                  name="companyContext"
                  rows={6}
                  defaultValue={data.settings?.companyContext || ""}
                />
              </Field>
              <Button variant="primary" type="submit" busy={busy}>
                Save workspace settings
              </Button>
            </form>
          </>
        ) : tab === "integrations" ? (
          <>
            <h1>Integrations</h1>
            <p className="muted">
              Connect the services that power your recruiting workflow.
            </p>
            <div className="integration-grid">
              {integrations.map((i: any) => (
                <article className="integration-card" key={i.id || i.name}>
                  <div className="integration-icon">
                    <Plug size={23} />
                  </div>
                  <h2>{i.name}</h2>
                  <span className={`badge ${i.configured ? "green" : ""}`}>
                    {i.configured ? "Configured" : i.status || "Not configured"}
                  </span>
                  <p>
                    {i.description ||
                      i.message ||
                      "Provider setup is required before this integration can be used."}
                  </p>
                  {i.configured ? (
                    <span className="integration-status">
                      <Check size={15} />
                      Available to this workspace
                    </span>
                  ) : (
                    <details>
                      <summary>Setup requirements</summary>
                      <p>
                        {i.setup ||
                          i.requirements ||
                          "This provider needs an application registration, credentials, and an implemented connector. No external account is connected."}
                      </p>
                    </details>
                  )}
                </article>
              ))}
            </div>
          </>
        ) : (
          <>
            <h1>Privacy & data</h1>
            <p className="muted">
              You control the conversations you add to ArkOffer.
            </p>
            <section className="settings-section">
              <h2>Recording consent</h2>
              <p>
                Tell participants before recording. ArkOffer only records when
                you start a recording and grant microphone access.
              </p>
            </section>
            <section className="settings-section">
              <h2>Sharing</h2>
              <p>
                Conversations are private to the workspace by default. Shared
                links grant read-only access, expire, and can be revoked from
                the conversation's Share & export menu.
              </p>
            </section>
            <section className="settings-section">
              <h2>AI processing</h2>
              <p>
                When an AI provider is configured, transcript content is sent to
                that provider when you request generation or an answer. Without
                a provider, ArkOffer extracts information from the transcript
                locally.
              </p>
            </section>
            <section className="settings-section">
              <h2>Export your data</h2>
              <p>
                Download individual conversation transcripts and notes from
                their Sources panel, or export tables as CSV.
              </p>
              <a
                className="btn"
                href="/api/reports/export?resource=conversations"
              >
                Export conversations
              </a>
            </section>
            <section className="settings-section">
              <h2>Workspace administration</h2>
              <p>
                Enterprise sign-in, automatic retention policies, SCIM, billing,
                and team invitation delivery require additional services. They
                are not enabled in this installation.
              </p>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
