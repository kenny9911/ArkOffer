import { test, expect } from "./fixtures";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

test("reviewed public reports publish selected data, open anonymously and revoke through real APIs", async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const origin = new URL(baseURL!).origin,
    headers = { Origin: origin };
  const signup = await page.request.post("/api/auth/signup", {
    headers,
    data: {
      name: "Public Report Owner",
      email: `public-report-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
      password: "SyntheticReportPass987!",
      workspaceName: "Synthetic public reports",
      seedDemo: false,
    },
  });
  expect(signup.ok(), await signup.text()).toBeTruthy();
  const user = (await signup.json()).user;
  const created = await page.request.post("/api/conversations", {
    headers,
    data: {
      title: "Synthetic private interview",
      transcript: "Candidate: I led a team of four engineers.",
      archived: false,
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const source = (await created.json()).item;
  const definition = {
    name: "Synthetic leadership snapshot",
    question: "What leadership is documented?",
    sourceIds: [source.id],
    columns: [
      {
        id: "public",
        name: "Leadership",
        instruction: "Extract leadership experience",
        type: "text",
      },
      {
        id: "private",
        name: "Private column",
        instruction: "Another extraction",
        type: "text",
      },
    ],
    filters: { title: "", from: "", to: "" },
  };
  const saved = await page.request.post("/api/report-views", {
    headers,
    data: definition,
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  const view = (await saved.json()).item;
  // Seed a completed synthetic run only in the runner's isolated temporary database.
  // All UI and public-link operations below use the real app API and persistence.
  const directory = testInfo.config.webServer?.env?.DATA_DIR;
  expect(directory).toMatch(/^\/tmp\/arkoffer-e2e-\d+$/);
  const db = new DatabaseSync(join(directory!, "arkoffer.sqlite"));
  const runId = randomUUID(),
    snapshotId = randomUUID(),
    date = new Date().toISOString();
  const hash = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  try {
    const row = db
      .prepare(
        "SELECT definition FROM ai_report_views WHERE id=? AND author_id=?",
      )
      .get(view.id, user.id)!;
    expect(row).toBeTruthy();
    db.prepare(
      "INSERT INTO ai_report_runs(id,view_id,workspace_id,author_id,session_hash,request_key,revision,definition,status,cell_count,model,created_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      runId,
      view.id,
      user.workspaceId,
      user.id,
      "synthetic-browser-fixture",
      randomUUID(),
      1,
      String(row.definition),
      "complete",
      2,
      "synthetic-test-model",
      date,
      date,
    );
    const context = { title: source.title, transcript: source.transcript };
    db.prepare(
      "INSERT INTO ai_report_sources(id,run_id,source_id,source_hash,context_hash,context_json,truncated,total_characters,status) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      snapshotId,
      runId,
      source.id,
      hash(context),
      hash(context),
      JSON.stringify(context),
      0,
      source.transcript.length,
      "complete",
    );
    for (const id of ["public", "private"])
      db.prepare(
        "INSERT INTO ai_report_cells(id,run_id,source_snapshot_id,column_id,status,value_json,evidence_json,annotation) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        randomUUID(),
        runId,
        snapshotId,
        id,
        "complete",
        JSON.stringify(
          id === "public" ? "Led four engineers" : "Private unselected answer",
        ),
        JSON.stringify([
          { quote: source.transcript, start: 0, end: source.transcript.length },
        ]),
        "Private reviewer note",
      );
  } finally {
    db.close();
  }
  await page.goto(`/app/reports/${view.id}`);
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page.getByText("Public link", { exact: true }).click();
  const sharing = page.locator(".report-public-sharing");
  await sharing
    .getByLabel("Public title", { exact: true })
    .fill("Reviewed leadership report");
  await sharing.getByLabel("Private column", { exact: true }).uncheck();
  await sharing
    .getByLabel("Allow CSV download of these selected results")
    .check();
  await sharing
    .getByRole("button", { name: "Preview public report", exact: true })
    .click();
  const preview = page.getByRole("region", {
    name: "Public report preview",
    exact: true,
  });
  await expect(
    preview.getByRole("heading", { name: "Reviewed leadership report" }),
  ).toBeVisible();
  await expect(
    preview.getByText("Led four engineers", { exact: true }),
  ).toBeVisible();
  await expect(
    preview.getByText("Synthetic private interview", { exact: true }),
  ).toHaveCount(0);
  await expect(
    preview.getByText("Private unselected answer", { exact: true }),
  ).toHaveCount(0);
  await expect(
    preview.getByRole("button", { name: "Create public link", exact: true }),
  ).toBeDisabled();
  await preview
    .getByRole("checkbox", {
      name: "I have reviewed this content",
      exact: false,
    })
    .check();
  await preview
    .getByRole("button", { name: "Create public link", exact: true })
    .click();
  const urlField = page.getByLabel("Created public report URL");
  await expect(urlField).toBeVisible();
  const url = await urlField.inputValue(),
    token = new URL(url).pathname.split("/").pop()!;
  const anonymous = await browser.newContext({ baseURL });
  try {
    const visitor = await anonymous.newPage();
    await visitor.goto(url);
    await expect(
      visitor.getByRole("heading", { name: "Reviewed leadership report" }),
    ).toBeVisible();
    await expect(
      visitor.getByRole("cell", { name: "Led four engineers", exact: true }),
    ).toBeVisible();
    await expect(
      visitor.getByText("Synthetic private interview", { exact: true }),
    ).toHaveCount(0);
    await expect(
      visitor.getByRole("button", { name: "Share", exact: true }),
    ).toHaveCount(0);
    const response = await anonymous.request.get(
      `/api/public-reports/${token}`,
    );
    expect(response.ok()).toBeTruthy();
    const content = await response.text();
    expect(content).not.toContain(source.id);
    expect(content).not.toContain("Private unselected answer");
    expect(content).not.toContain("Private reviewer note");
    expect(content).not.toContain(source.transcript);
    const exported = await anonymous.request.get(
      `/api/public-reports/${token}/export.csv`,
    );
    expect(exported.ok()).toBeTruthy();
    expect(await exported.text()).toContain("Led four engineers");
    await visitor.setViewportSize({ width: 390, height: 844 });
    // Navigate at the new viewport instead of capturing an in-progress resize paint.
    await visitor.reload();
    await expect(
      visitor.getByRole("heading", { name: "Reviewed leadership report" }),
    ).toBeVisible();
    await expect(visitor.locator(".public-report-page")).toHaveCount(1);
    await expect(visitor.locator(".public-report-brand")).toHaveCount(1);
    await visitor.evaluate(() => document.fonts.ready);
    expect(
      await visitor.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBeTruthy();
    await visitor.screenshot({
      path: testInfo.outputPath("public-report-mobile.png"),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Revoke link", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Confirm revoke link", exact: true })
      .click();
    await expect(
      page.getByText("Public report link revoked.", { exact: true }),
    ).toBeVisible();
    await visitor.reload();
    await expect(
      visitor.getByRole("heading", { name: "Report unavailable" }),
    ).toBeVisible();
    expect(
      (
        await anonymous.request.get(`/api/public-reports/${token}/export.csv`)
      ).status(),
    ).toBe(404);
  } finally {
    await anonymous.close();
  }
  await page.reload();
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page.getByText("Public link", { exact: true }).click();
  await expect(page.getByLabel("Created public report URL")).toHaveCount(0);
  await expect(page.locator(".report-public-links")).toContainText("revoked");

  // Simulate a legacy/imported oversized run only at the UI read boundary.
  // Existing publication assertions above exercised unmodified real API data.
  await page.route(`**/api/report-views/${view.id}`, async (route) => {
    const response = await route.fetch(),
      data = await response.json();
    data.runs[0].columns.push(
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `extra-${index + 1}`,
        name: `Extra column ${index + 1}`,
        type: "text",
      })),
    );
    data.runs[0].rows.push(
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `extra-snapshot-${index + 1}`,
        sourceId: `extra-source-${index + 1}`,
        title: `Extra conversation ${index + 1}`,
        status: "complete",
        cells: [],
      })),
    );
    await route.fulfill({ response, json: data });
  });
  await page.reload();
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page.getByText("Public link", { exact: true }).click();
  const caps = page.locator(".report-public-sharing");
  await expect(
    caps.getByText("5 of up to 5 columns selected.", { exact: false }),
  ).toBeVisible();
  await expect(
    caps.getByLabel("Extra column 4", { exact: true }),
  ).toBeDisabled();
  await caps.getByLabel("Leadership", { exact: true }).uncheck();
  await expect(
    caps.getByLabel("Extra column 4", { exact: true }),
  ).toBeEnabled();
  await caps.getByLabel("Extra column 4", { exact: true }).check();
  await expect(caps.getByLabel("Leadership", { exact: true })).toBeDisabled();
  await caps.getByLabel("Extra column 4", { exact: true }).uncheck();
  await caps.getByLabel("Leadership", { exact: true }).check();
  await expect(
    caps.getByText("20 of up to 20 conversations selected.", { exact: false }),
  ).toBeVisible();
  await expect(
    caps.getByLabel("Extra conversation 20", { exact: true }),
  ).toBeDisabled();
  await caps
    .getByLabel("Synthetic private interview", { exact: true })
    .uncheck();
  await expect(
    caps.getByLabel("Extra conversation 20", { exact: true }),
  ).toBeEnabled();
  await caps.getByLabel("Extra conversation 20", { exact: true }).check();
  await expect(
    caps.getByLabel("Synthetic private interview", { exact: true }),
  ).toBeDisabled();
  await caps.getByLabel("Extra conversation 20", { exact: true }).uncheck();
  await caps.getByLabel("Synthetic private interview", { exact: true }).check();
});
