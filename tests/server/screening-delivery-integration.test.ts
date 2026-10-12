import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../server/app.js";
import { createDatabase } from "../../server/db.js";
import { newScreeningConfig } from "../../shared/screening.js";

test("full app mounts signed agent callbacks and public opt-out routes while blocking unavailable live publication", async () => {
  const secret = "integration-test-only-callback-secret";
  const oldSecret = process.env.LIVEKIT_AGENT_CALLBACK_SECRET;
  const oldKey = process.env.LIVEKIT_API_KEY;
  process.env.LIVEKIT_AGENT_CALLBACK_SECRET = secret;
  process.env.LIVEKIT_API_KEY = "";
  const directory = mkdtempSync(
    join(tmpdir(), "arkoffer-delivery-integration-"),
  );
  const store = createDatabase(directory);
  const app = createApp({
    store,
    appOrigin: "http://localhost:5174",
    openAiApiKey: "",
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const body = JSON.stringify({
      eventId: randomUUID(),
      sessionId: randomUUID(),
      sequence: 1,
      kind: "ready",
    });
    const timestamp = String(Date.now());
    const signed = await fetch(`${base}/api/live-interviews/callback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ArkOffer-Timestamp": timestamp,
        "X-ArkOffer-Signature": createHmac("sha256", secret)
          .update(`${timestamp}.${body}`)
          .digest("hex"),
      },
      body,
    });
    assert.equal(
      signed.status,
      404,
      "valid signature reaches session lookup without browser Origin/session",
    );
    assert.equal((await signed.json()).error, "Live interview is unavailable.");
    for (const path of ["screening-outreach", "report-subscriptions"]) {
      const response = await fetch(
        `${base}/api/${path}/unsubscribe/${"f".repeat(64)}`,
      );
      assert.equal(
        response.status,
        path === "report-subscriptions" ? 200 : 404,
        `${path} confirmation is publicly mounted without a session`,
      );
    }
    assert.equal(
      (await fetch(`${base}/api/live-interviews/status`)).status,
      401,
    );
    const signup = await fetch(`${base}/api/auth/signup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:5174",
      },
      body: JSON.stringify({
        name: "Delivery Tester",
        email: "delivery-integration@example.test",
        password: "Synthetic-only-password-987!",
        seedDemo: false,
      }),
    });
    assert.equal(signup.status, 201);
    const headers = {
      "Content-Type": "application/json",
      Origin: "http://localhost:5174",
      Cookie: signup.headers.get("set-cookie")!.split(";")[0],
    };
    const status = await (
      await fetch(`${base}/api/live-interviews/status`, { headers })
    ).json();
    assert.equal(status.available, false);
    const config = newScreeningConfig();
    config.setup.interviewMode = "live";
    config.sections[0].questions.push({
      id: randomUUID(),
      prompt: "Describe an API you built.",
      type: "text",
      required: true,
      options: [],
      rubric: "",
      followUp: false,
    });
    const created = await fetch(`${base}/api/screening-workspaces`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Live screening",
        description: "Synthetic test",
        screeningConfig: config,
      }),
    });
    assert.equal(created.status, 201);
    const screening = (await created.json()).item;
    const publish = await fetch(
      `${base}/api/screenings/${screening.id}/publish`,
      { method: "POST", headers, body: "{}" },
    );
    assert.equal(publish.status, 409);
    assert.match((await publish.json()).error, /not configured/);
    const preview = await fetch(
      `${base}/api/screenings/${screening.id}/outreach/preview`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          revision: screening.updatedAt,
          recipients: [{ name: "Alex Example", email: "alex@example.test" }],
          subject: "Invitation",
          body: "Please complete this screening.",
          reminderDays: [],
        }),
      },
    );
    assert.equal(preview.status, 409);
    assert.match((await preview.json()).error, /not configured/);
    assert.equal(
      store.db
        .prepare("SELECT COUNT(*) AS n FROM screening_publications")
        .get()!.n,
      0,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    store.close();
    rmSync(directory, { recursive: true, force: true });
    if (oldSecret === undefined)
      delete process.env.LIVEKIT_AGENT_CALLBACK_SECRET;
    else process.env.LIVEKIT_AGENT_CALLBACK_SECRET = oldSecret;
    if (oldKey === undefined) delete process.env.LIVEKIT_API_KEY;
    else process.env.LIVEKIT_API_KEY = oldKey;
  }
});
