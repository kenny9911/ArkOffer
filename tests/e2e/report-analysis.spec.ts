import { test, expect } from "./fixtures";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { Page, TestInfo } from "@playwright/test";

async function createReport(
  page: Page,
  baseURL: string,
  testInfo: TestInfo,
  withHistory = false,
) {
  const headers = { Origin: new URL(baseURL).origin };
  const signup = await page.request.post("/api/auth/signup", {
    headers,
    data: {
      name: "Analysis Reviewer",
      email: `analysis-${randomUUID()}@example.com`,
      password: "SyntheticAnalysisPass987!",
      workspaceName: "Synthetic analysis tests",
      seedDemo: false,
    },
  });
  expect(signup.ok(), await signup.text()).toBeTruthy();
  const user = (await signup.json()).user;
  const sources = [];
  for (const title of [
    "Synthetic support conversation",
    "Synthetic engineering conversation",
    "Synthetic undocumented conversation",
  ]) {
    const response = await page.request.post("/api/conversations", {
      headers,
      data: {
        title,
        transcript: `Candidate: This is the ${title} transcript.`,
        archived: false,
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    sources.push((await response.json()).item);
  }
  const definition = {
    name: "Synthetic advanced analysis",
    question: "What did candidates document?",
    sourceIds: sources.map((source) => source.id),
    columns: [
      {
        id: "department",
        name: "Department",
        instruction: "Extract the documented department",
        type: "text",
      },
      {
        id: "score",
        name: "Team size",
        instruction: "Extract the documented team size",
        type: "number",
      },
      {
        id: "comp",
        name: "Compensation",
        instruction: "Extract the documented compensation",
        type: "currency",
      },
      {
        id: "remote",
        name: "Remote",
        instruction: "Extract whether remote is documented",
        type: "boolean",
      },
    ],
    filters: { title: "", from: "", to: "" },
  };
  const response = await page.request.post("/api/report-views", {
    headers,
    data: definition,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const view = (await response.json()).item;
  const directory = testInfo.config.webServer?.env?.DATA_DIR;
  expect(directory).toMatch(/^\/tmp\/arkoffer-e2e-\d+$/);
  const db = new DatabaseSync(join(directory!, "arkoffer.sqlite")),
    runId = randomUUID(),
    date = new Date().toISOString();
  const historyRunId = withHistory ? randomUUID() : null;
  const values = [
    {
      department: "Support",
      score: 4,
      comp: { amount: 100, currency: "USD" },
      remote: true,
    },
    {
      department: "Engineering",
      score: 8,
      comp: { amount: 200, currency: "EUR" },
      remote: false,
    },
    { department: "Engineering", score: null, comp: null, remote: null },
  ];
  try {
    const row = db
      .prepare(
        "SELECT definition FROM ai_report_views WHERE id=? AND author_id=?",
      )
      .get(view.id, user.id)!;
    db.prepare(
      "INSERT INTO ai_report_runs(id,view_id,workspace_id,author_id,session_hash,request_key,revision,definition,status,cell_count,model,created_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      runId,
      view.id,
      user.workspaceId,
      user.id,
      "synthetic-analysis-fixture",
      randomUUID(),
      1,
      String(row.definition),
      "complete",
      12,
      "synthetic-local-results",
      date,
      date,
    );
    if (historyRunId)
      db.prepare(
        "INSERT INTO ai_report_runs(id,view_id,workspace_id,author_id,session_hash,request_key,revision,definition,status,cell_count,model,created_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        historyRunId,
        view.id,
        user.workspaceId,
        user.id,
        "synthetic-analysis-fixture",
        randomUUID(),
        1,
        String(row.definition),
        "complete",
        0,
        "synthetic-local-results",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
    sources.forEach((source, index) => {
      const snapshot = randomUUID(),
        context = { title: source.title, transcript: source.transcript },
        hash = createHash("sha256")
          .update(JSON.stringify(context))
          .digest("hex");
      const day = ["2026-10-01", "2026-10-08", "2026-11-01"][index];
      db.prepare(
        "INSERT INTO ai_report_sources(id,run_id,source_id,source_hash,context_hash,context_json,truncated,total_characters,status,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).run(
        snapshot,
        runId,
        source.id,
        hash,
        hash,
        JSON.stringify(context),
        0,
        source.transcript.length,
        "complete",
        JSON.stringify({
          version: 1,
          createdAt: `${day}T09:00:00.000Z`,
          conversationDate: `${day}T09:00:00.000Z`,
          candidate: `Synthetic candidate ${index + 1}`,
          interviewer: "Synthetic interviewer",
          status: "completed",
          duration: 20 + index * 10,
        }),
      );
      for (const [column, value] of Object.entries(values[index]))
        db.prepare(
          "INSERT INTO ai_report_cells(id,run_id,source_snapshot_id,column_id,status,value_json,evidence_json,annotation) VALUES(?,?,?,?,?,?,?,?)",
        ).run(
          randomUUID(),
          runId,
          snapshot,
          column,
          value === null ? "not_documented" : "complete",
          JSON.stringify(value),
          "[]",
          "",
        );
    });
  } finally {
    db.close();
  }
  await page.goto(`/app/reports/${view.id}`);
  return { view, runId, historyRunId, sources, headers };
}

test("advanced result filters and named date/category charts persist through the real API without new extraction", async ({
  page,
  baseURL,
}, testInfo) => {
  const { view, runId } = await createReport(page, baseURL!, testInfo);
  let extractions = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname.endsWith("/runs")
    )
      extractions++;
  });
  const reports = page.getByRole("region", { name: "AI report views" }),
    analysis = page.getByRole("region", { name: "Advanced report analysis" }),
    evidence = page.getByRole("table", {
      name: "Report evidence",
      exact: true,
    });
  await reports
    .getByRole("button", { name: "Result filters", exact: true })
    .click();
  await analysis.getByRole("button", { name: "Add result filter" }).click();
  await analysis.getByLabel("Result filter 1 field").selectOption("score");
  await analysis.getByLabel("Result filter 1 condition").selectOption("gte");
  await analysis.getByLabel("Result filter 1 value").fill("5");
  await analysis
    .getByRole("button", { name: "Save analysis", exact: true })
    .click();
  await expect(
    reports.getByText(/1 of 3 available conversations match/),
  ).toBeVisible();
  await expect(evidence).toContainText("Synthetic engineering conversation");
  await expect(evidence).not.toContainText("Synthetic support conversation");
  await reports.getByLabel("Show all available results").check();
  await expect(evidence).toContainText("Synthetic support conversation");
  await reports.getByLabel("Show all available results").uncheck();
  await analysis.getByRole("button", { name: "Add result filter" }).click();
  await analysis.getByLabel("Result filter 2 field").selectOption("department");
  await analysis.getByLabel("Result filter 2 value").fill("Support");
  await analysis.getByLabel("Result filter logic").selectOption("any");
  await analysis
    .getByRole("button", { name: "Add chart", exact: true })
    .click();
  await analysis.getByLabel("Chart 1 name").fill("Monthly departments");
  await analysis.getByLabel("Chart 1 type").selectOption("stacked");
  await analysis
    .getByLabel("Chart 1 group by")
    .selectOption("$conversationDate");
  await analysis.getByLabel("Chart 1 date interval").selectOption("month");
  await analysis.getByLabel("Chart 1 split by").selectOption("department");
  await expect(
    analysis
      .getByLabel("Chart 1 calculation")
      .locator('option[value="average"]'),
  ).toHaveJSProperty("disabled", true);
  await analysis
    .getByRole("button", { name: "Add chart", exact: true })
    .click();
  await analysis.getByLabel("Chart 2 name").fill("Compensation by department");
  await analysis.getByLabel("Chart 2 group by").selectOption("department");
  await analysis.getByLabel("Chart 2 calculation").selectOption("sum");
  await analysis.getByLabel("Chart 2 value").selectOption("comp");
  await analysis
    .getByRole("button", { name: "Add chart", exact: true })
    .click();
  await analysis.getByLabel("Chart 3 name").fill("Weekly conversations");
  await analysis.getByLabel("Chart 3 type").selectOption("line");
  await analysis
    .getByLabel("Chart 3 group by")
    .selectOption("$conversationDate");
  await analysis.getByLabel("Chart 3 date interval").selectOption("week");
  await analysis
    .getByRole("button", { name: "Save analysis", exact: true })
    .click();
  await expect(
    reports.getByText(/2 of 3 available conversations match/),
  ).toBeVisible();
  await expect(
    analysis.getByRole("img", {
      name: /Monthly departments, stacked bar chart/,
    }),
  ).toBeVisible();
  await expect(
    analysis.getByRole("table", { name: "Monthly departments values" }),
  ).toContainText("Support");
  await expect(
    analysis.getByRole("table", { name: "Monthly departments values" }),
  ).toContainText("Engineering");
  await expect(
    analysis.getByRole("img", { name: /Compensation by department in USD/ }),
  ).toBeVisible();
  await expect(
    analysis.getByRole("img", { name: /Compensation by department in EUR/ }),
  ).toBeVisible();
  await expect(
    analysis.getByRole("img", { name: /Weekly conversations, line chart/ }),
  ).toBeVisible();
  const filtered = await page.request.get(
    `/api/report-views/${view.id}/runs/${runId}/analysis.csv`,
  );
  expect(filtered.ok(), await filtered.text()).toBeTruthy();
  const csv = await filtered.text();
  expect(csv).toContain("Synthetic support conversation");
  expect(csv).toContain("Synthetic engineering conversation");
  expect(csv).not.toContain("Synthetic undocumented conversation");
  const chartUrl = await analysis
    .getByRole("article", { name: "Monthly departments", exact: true })
    .getByRole("link", { name: "Export chart CSV" })
    .getAttribute("href");
  const chartCsv = await page.request.get(chartUrl!);
  expect(chartCsv.ok(), await chartCsv.text()).toBeTruthy();
  expect(await chartCsv.text()).toContain("Support");
  await page.reload();
  await expect(
    analysis.getByRole("heading", { name: "Monthly departments", exact: true }),
  ).toBeVisible();
  await expect(
    reports.getByText(/2 of 3 available conversations match/),
  ).toBeVisible();
  await reports.getByRole("tab", { name: "Charts", exact: true }).click();
  await expect(
    reports.getByRole("heading", { name: "Quick chart", exact: true }),
  ).toBeVisible();
  await reports
    .getByRole("button", { name: "Configure result filters and charts" })
    .click();
  await expect(analysis.getByLabel("Chart 3 date interval")).toHaveValue(
    "week",
  );
  const result = await (
    await page.request.get(`/api/report-views/${view.id}`)
  ).json();
  expect(result.item.revision).toBe(1);
  expect(result.item.analysisRevision).toBe(3);
  expect(result.runs).toHaveLength(1);
  expect(extractions).toBe(0);
  await analysis
    .getByRole("button", { name: "Remove result filter 2" })
    .click();
  await analysis
    .getByRole("button", { name: "Remove result filter 1" })
    .click();
  await analysis
    .getByRole("button", { name: "Save analysis", exact: true })
    .click();
  await expect(
    reports.getByText(/3 of 3 available conversations match/),
  ).toBeVisible();
  const weekly = analysis.getByRole("img", {
    name: /Weekly conversations, line chart/,
  });
  await expect(weekly.locator("circle")).toHaveCount(3);
  // September 28 and October 5 are adjacent weeks; October 26 follows two missing buckets.
  // The plot leaves a visible time gap instead of inventing intervening counts.
  await expect(weekly.locator("polyline")).toHaveCount(2);
  const positions = await weekly
    .locator("circle")
    .evaluateAll((circles) =>
      circles.map((circle) => Number(circle.getAttribute("cx"))),
    );
  expect(positions[1] - positions[0]).toBeLessThan(
    (positions[2] - positions[1]) / 2,
  );
  await analysis
    .getByRole("button", { name: "Hide analysis settings", exact: true })
    .click();
  await analysis
    .getByRole("article", { name: "Monthly departments", exact: true })
    .screenshot({
      path: testInfo.outputPath("advanced-report-analysis.png"),
    });
});

test("typed result filters, stale save conflicts and revoked sources keep evidence and exports consistent", async ({
  page,
  baseURL,
}, testInfo) => {
  const { view, runId, historyRunId, sources, headers } = await createReport(
    page,
    baseURL!,
    testInfo,
    true,
  );
  const analysis = page.getByRole("region", {
      name: "Advanced report analysis",
    }),
    evidence = page.getByRole("table", {
      name: "Report evidence",
      exact: true,
    });
  await analysis
    .getByRole("button", { name: "Configure analysis", exact: true })
    .click();
  await analysis.getByRole("button", { name: "Add result filter" }).click();
  await analysis.getByLabel("Result filter 1 field").selectOption("comp");
  await analysis.getByLabel("Result filter 1 value").fill("100");
  await analysis.getByLabel("Result filter 1 currency").fill("usd");
  await expect(analysis.getByLabel("Result filter 1 currency")).toHaveValue(
    "USD",
  );
  await analysis.getByRole("button", { name: "Add result filter" }).click();
  await analysis.getByLabel("Result filter 2 field").selectOption("remote");
  await analysis.getByLabel("Result filter 2 value").selectOption("true");
  await analysis.getByRole("button", { name: "Add result filter" }).click();
  await analysis
    .getByLabel("Result filter 3 field")
    .selectOption("$conversationDate");
  await analysis.getByLabel("Result filter 3 condition").selectOption("gte");
  await analysis.getByLabel("Result filter 3 value").fill("2026-10-01");
  await analysis
    .getByRole("button", { name: "Save analysis", exact: true })
    .click();
  await expect(evidence).toContainText("Synthetic support conversation");
  await expect(evidence).not.toContainText(
    "Synthetic engineering conversation",
  );
  const current = await (
    await page.request.get(`/api/report-views/${view.id}`)
  ).json();
  await analysis.getByLabel("Result filter 1 value").fill("200");
  await page.getByLabel("Report run history").selectOption(historyRunId!);
  await expect(analysis.getByLabel("Result filter 1 value")).toHaveValue("200");
  await page.getByLabel("Report run history").selectOption(runId);
  await expect(analysis.getByLabel("Result filter 1 value")).toHaveValue("200");
  const simultaneous = await page.request.patch(
    `/api/report-views/${view.id}/analysis`,
    {
      headers,
      data: {
        revision: current.item.analysisRevision,
        runId,
        analysis: current.item.analysis,
      },
    },
  );
  expect(simultaneous.ok(), await simultaneous.text()).toBeTruthy();
  await page
    .getByRole("button", { name: "Add to favorites", exact: true })
    .click();
  await expect(analysis.getByLabel("Result filter 1 value")).toHaveValue("200");
  await expect(
    analysis.getByText(
      /Your draft is preserved; saving requires the latest revision/,
    ),
  ).toBeVisible();
  await analysis
    .getByRole("button", { name: "Save analysis", exact: true })
    .click();
  await expect(
    analysis
      .getByRole("alert")
      .filter({ hasText: "unsaved settings are preserved" }),
  ).toBeVisible();
  await expect(analysis.getByLabel("Result filter 1 value")).toHaveValue("200");
  await page.reload();
  const revoked = await page.request.delete(
    `/api/conversations/${sources[0].id}`,
    { headers },
  );
  expect(revoked.ok(), await revoked.text()).toBeTruthy();
  await page.getByRole("button", { name: "Refresh report results" }).click();
  await expect(evidence).toContainText("Source unavailable or changed");
  await expect(evidence).not.toContainText("Synthetic support conversation");
  await expect(
    page.getByText(/0 of 2 available conversations match.*1 unavailable/),
  ).toBeVisible();
  const csv = await page.request.get(
    `/api/report-views/${view.id}/runs/${runId}/analysis.csv`,
  );
  expect(csv.ok(), await csv.text()).toBeTruthy();
  expect(await csv.text()).not.toContain("Synthetic support conversation");
  // A later definition can have a saved filter that does not exist in this historical run.
  const latest = (
    await (await page.request.get(`/api/report-views/${view.id}`)).json()
  ).item;
  const changedDefinition = await page.request.patch(
    `/api/report-views/${view.id}`,
    {
      headers,
      data: {
        revision: latest.revision,
        definition: {
          name: latest.name,
          question: latest.question,
          sourceIds: sources.slice(1).map((source) => source.id),
          columns: [
            {
              id: "new_value",
              name: "New extracted value",
              instruction: "Extract this new value",
              type: "number",
            },
          ],
          filters: latest.filters,
        },
      },
    },
  );
  expect(changedDefinition.ok(), await changedDefinition.text()).toBeTruthy();
  const changedFilter = await page.request.patch(
    `/api/report-views/${view.id}/analysis`,
    {
      headers,
      data: {
        revision: latest.analysisRevision,
        analysis: {
          filters: {
            logic: "all",
            conditions: [
              {
                id: "new_condition",
                field: "new_value",
                operator: "gte",
                value: 1,
              },
            ],
          },
          charts: [],
        },
      },
    },
  );
  expect(changedFilter.ok(), await changedFilter.text()).toBeTruthy();
  await page.reload();
  await expect(analysis.getByRole("alert")).toContainText(
    "Filtered evidence is unavailable",
  );
  await expect(evidence).not.toContainText(
    "Synthetic engineering conversation",
  );
  await expect(
    page.getByRole("link", { name: "Export filtered CSV", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Show all available results").check();
  await expect(evidence).toContainText("Synthetic engineering conversation");
  await expect(evidence).not.toContainText("Synthetic support conversation");
  expect(
    (
      await page.request.get(
        `/api/report-views/${view.id}/runs/${runId}/analysis.csv`,
      )
    ).status(),
  ).toBe(409);
});

test("large finite chart values fall back to exact results when a stacked axis overflows", async ({
  page,
  baseURL,
}, testInfo) => {
  const { view, runId, headers } = await createReport(page, baseURL!, testInfo);
  const directory = testInfo.config.webServer?.env?.DATA_DIR;
  expect(directory).toMatch(/^\/tmp\/arkoffer-e2e-\d+$/);
  const db = new DatabaseSync(join(directory!, "arkoffer.sqlite"));
  try {
    db.prepare(
      "UPDATE ai_report_cells SET value_json=? WHERE run_id=? AND column_id='comp' AND status='complete'",
    ).run(JSON.stringify({ amount: 1e308, currency: "USD" }), runId);
  } finally {
    db.close();
  }
  const response = await page.request.patch(
    `/api/report-views/${view.id}/analysis`,
    {
      headers,
      data: {
        revision: 1,
        runId,
        analysis: {
          filters: { logic: "all", conditions: [] },
          charts: [
            {
              id: "large_values",
              name: "Large documented values",
              mode: "stacked",
              groupBy: "$conversationDate",
              bucket: "month",
              splitBy: "department",
              operation: "sum",
              metric: "comp",
            },
          ],
        },
      },
    },
  );
  expect(response.ok(), await response.text()).toBeTruthy();
  await page.reload();
  const chart = page.getByRole("article", {
    name: "Large documented values",
    exact: true,
  });
  await expect(
    chart.getByText(
      "Values exceed chart display range. Use the exact values in the table or CSV.",
    ),
  ).toBeVisible();
  await expect(
    chart.getByRole("table", { name: "Large documented values values" }),
  ).toContainText("Support");
  await expect(
    chart.getByRole("link", { name: "Export chart CSV" }),
  ).toBeVisible();
  expect(
    await chart
      .locator("svg")
      .evaluateAll((elements) =>
        elements.every((svg) => !/NaN|Infinity/.test(svg.outerHTML)),
      ),
  ).toBeTruthy();
});
