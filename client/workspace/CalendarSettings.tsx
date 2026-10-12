import { useEffect, useState } from "react";
import { CalendarDays, RefreshCw, Link2, Unlink } from "lucide-react";
import { api, json, Button, ErrorBanner, Loading, useToast } from "../ui";

type Calendar = {
  id: "google" | "microsoft";
  name: string;
  configured: boolean;
  missing: string[];
  redirectUri: string | null;
  connected: boolean;
  accountName: string | null;
  lastSync: string | null;
  lastError: string | null;
  eventCount: number;
};

export default function CalendarSettings() {
  const [items, setItems] = useState<Calendar[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const toast = useToast();
  async function load() {
    const response = await api("calendar");
    setItems(response.items);
  }
  useEffect(() => {
    let active = true;
    api("calendar")
      .then((response) => {
        if (active) setItems(response.items);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    const status = new URLSearchParams(window.location.search).get("calendar");
    if (status === "denied")
      setError(
        "Calendar connection was cancelled or denied. You can connect again when ready.",
      );
    return () => {
      active = false;
    };
  }, []);
  async function act(
    calendar: Calendar,
    action: "connect" | "sync" | "disconnect",
  ) {
    setBusy(`${calendar.id}:${action}`);
    setError("");
    try {
      const result = await api(
        `calendar/${calendar.id}${action === "disconnect" ? "" : `/${action}`}`,
        json(action === "disconnect" ? "DELETE" : "POST", {}),
      );
      if (action === "connect") {
        const url = new URL(result.url);
        if (
          ![
            "https://accounts.google.com",
            "https://login.microsoftonline.com",
          ].includes(url.origin)
        )
          throw new Error("The calendar authorization address is invalid.");
        window.location.assign(url.href);
        return;
      }
      await load();
      toast(
        action === "sync"
          ? `Calendar synced: ${result.created} new, ${result.updated} updated conversations`
          : "Calendar disconnected. Imported conversations were kept.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <section aria-labelledby="calendar-settings-title">
      <h2 id="calendar-settings-title">Your calendars</h2>
      <p className="muted">
        Import events from your primary calendar for the next 30 days. Sync runs
        when you choose it. Calendar events stay read-only; ArkOffer does not
        join meetings or record calls.
      </p>
      <ErrorBanner error={error} />
      {!items && !error ? <Loading /> : null}
      <div className="integration-grid">
        {items?.map((calendar) => (
          <article className="integration-card" key={calendar.id}>
            <div className="integration-icon">
              <CalendarDays size={23} />
            </div>
            <h3>{calendar.name}</h3>
            <span className={`badge ${calendar.connected ? "green" : ""}`}>
              {calendar.connected
                ? "Connected"
                : calendar.configured
                  ? "Ready to connect"
                  : "Setup required"}
            </span>
            {calendar.accountName ? (
              <p style={{ overflowWrap: "anywhere" }}>{calendar.accountName}</p>
            ) : null}
            {calendar.connected ? (
              <>
                <p className="muted">
                  {calendar.lastSync
                    ? `Last synced ${new Date(calendar.lastSync).toLocaleString()} · ${calendar.eventCount} upcoming events`
                    : "Connect complete. Sync to import upcoming events."}
                </p>
                {calendar.lastError ? (
                  <ErrorBanner error={calendar.lastError} />
                ) : null}
                <div
                  className="button-row"
                  style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
                >
                  <Button
                    onClick={() => act(calendar, "sync")}
                    disabled={!!busy || !calendar.configured}
                    busy={busy === `${calendar.id}:sync`}
                  >
                    <RefreshCw size={15} />
                    Sync now
                  </Button>
                  <Button
                    onClick={() => act(calendar, "disconnect")}
                    disabled={!!busy}
                    busy={busy === `${calendar.id}:disconnect`}
                  >
                    <Unlink size={15} />
                    Disconnect
                  </Button>
                  {calendar.lastError ? (
                    <Button
                      onClick={() => act(calendar, "connect")}
                      disabled={!!busy || !calendar.configured}
                    >
                      Reconnect
                    </Button>
                  ) : null}
                </div>
                <p className="muted">
                  <small>
                    Disconnect removes ArkOffer’s saved credentials. You can
                    also revoke access in your provider account settings.
                  </small>
                </p>
              </>
            ) : (
              <Button
                variant="primary"
                onClick={() => act(calendar, "connect")}
                disabled={!!busy || !calendar.configured}
                busy={busy === `${calendar.id}:connect`}
              >
                <Link2 size={15} />
                Connect {calendar.name}
              </Button>
            )}
            {!calendar.configured ? (
              <details style={{ marginTop: 12 }}>
                <summary>Server setup needed</summary>
                <p className="muted">Ask your administrator to configure:</p>
                <ul>
                  {calendar.missing.map((key) => (
                    <li key={key}>
                      <code style={{ overflowWrap: "anywhere" }}>{key}</code>
                    </li>
                  ))}
                </ul>
                {calendar.redirectUri ? (
                  <p className="muted">
                    Register this redirect URI with the provider:{" "}
                    <code style={{ overflowWrap: "anywhere" }}>
                      {calendar.redirectUri}
                    </code>
                  </p>
                ) : null}
              </details>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}
