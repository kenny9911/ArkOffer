import { test, expect } from "./fixtures";

test("private report definitions persist while unconfigured extraction remains gated", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const signup = await page.request.post("/api/auth/signup", {
    headers: { Origin: origin },
    data: {
      name: "Report Reviewer",
      email: `report-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
      password: "LocalTestPass987!",
      workspaceName: "Report view tests",
      seedDemo: false,
    },
  });
  expect(signup.ok(), await signup.text()).toBeTruthy();
  const created = await page.request.post("/api/conversations", {
    headers: { Origin: origin },
    data: {
      title: "Engineering leadership conversation",
      transcript: "Candidate: I led a team of four engineers.",
      archived: false,
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  await page.goto("/app/reports");
  const reports = page.getByRole("region", { name: "AI report views" });
  await expect(
    reports.getByText("Text AI is not enabled for this workspace"),
  ).toBeVisible();
  await reports
    .getByRole("button", { name: "New AI report", exact: true })
    .click();
  await reports
    .getByLabel("Report name", { exact: true })
    .fill("Leadership evidence");
  await reports
    .getByLabel("What do you want to learn?")
    .fill("What team leadership experience is documented?");
  await reports.getByLabel("Column 1 name").fill("Leadership example");
  await reports
    .getByLabel("Column 1 extraction instructions")
    .fill(
      "Summarize documented leadership experience with an exact transcript quote.",
    );
  await reports
    .getByRole("checkbox", { name: /Engineering leadership conversation/ })
    .check();
  await reports.getByRole("button", { name: "Add AI column" }).click();
  await reports.getByLabel("Column 2 name").fill("Team size");
  await reports.getByLabel("Column 2 type").selectOption("number");
  await reports
    .getByLabel("Column 2 extraction instructions")
    .fill("How many engineers did this person lead? Return null if absent.");
  await expect(
    reports.getByText(
      "1 matching conversations × 2 columns = 2 cells per run.",
    ),
  ).toBeVisible();
  await reports
    .getByRole("button", { name: "Save report view", exact: true })
    .click();
  await expect(
    reports.getByRole("heading", { name: "Leadership evidence" }),
  ).toBeVisible();
  await expect(
    reports.getByRole("button", { name: "Run extraction", exact: true }),
  ).toBeDisabled();
  await page.reload();
  await reports
    .getByRole("button", { name: /Leadership evidence 2 columns/ })
    .click();
  await reports.getByRole("button", { name: "Edit view", exact: true }).click();
  await expect(reports.getByLabel("Column 2 type")).toHaveValue("number");
  await reports
    .getByLabel("Report name", { exact: true })
    .fill("Reviewed leadership evidence");
  await reports
    .getByRole("button", { name: "Save report view", exact: true })
    .click();
  await expect(
    reports.getByRole("heading", { name: "Reviewed leadership evidence" }),
  ).toBeVisible();
  await reports
    .getByRole("button", { name: "Delete view", exact: true })
    .click();
  await reports
    .getByRole("button", { name: "Confirm delete report view" })
    .click();
  await expect(
    reports.getByText("No saved AI reports yet.", { exact: false }),
  ).toBeVisible();
});

test("report results expose evidence, distinct human annotations, CSV and cancellation", async ({
  page,
  baseURL,
}, testInfo) => {
  const signup = await page.request.post("/api/auth/signup", {
    headers: { Origin: new URL(baseURL!).origin },
    data: {
      name: "Report UI Reviewer",
      email: `report-ui-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
      password: "LocalTestPass987!",
      workspaceName: "Report UI tests",
      seedDemo: false,
    },
  });
  expect(signup.ok(), await signup.text()).toBeTruthy();
  const view = {
    id: "synthetic-view",
    revision: 1,
    presentationRevision: 1,
    presentation: {
      mode: "bar",
      groupBy: "leadership",
      operation: "count",
      metric: null,
    },
    name: "Leadership evidence",
    question: "What leadership experience is documented?",
    sourceIds: ["synthetic-source"],
    columns: [
      {
        id: "leadership",
        name: "Leadership example",
        type: "text",
        instruction: "Summarize a documented leadership example.",
      },
    ],
    filters: { title: "", from: "", to: "" },
  };
  const cell = {
    id: "synthetic-cell",
    columnId: "leadership",
    status: "complete",
    value: "Led four engineers",
    evidence: [
      {
        quote: "Candidate: I led a team of four engineers.",
        start: 0,
        end: 41,
      },
    ],
    annotation: "",
    error: null,
  };
  const run = {
    id: "synthetic-run",
    revision: 1,
    aggregation: {
      compatible: true,
      issue: null,
      presentation: view.presentation,
      counts: {
        available: 1,
        unavailable: 1,
        grouped: 1,
        groupNotDocumented: 0,
        groupPending: 0,
        groupFailed: 0,
      },
      groups: [
        {
          key: "leadership",
          label: "Led four engineers",
          unit: null,
          rows: 1,
          values: 1,
          notDocumented: 0,
          pending: 0,
          failed: 0,
          value: 1,
        },
      ],
    },
    status: "complete",
    model: "synthetic-ui-provider",
    createdAt: "2026-10-12T00:00:00.000Z",
    error: null,
    totalCells: 1,
    finishedCells: 1,
    columns: view.columns,
    rows: [
      {
        id: "synthetic-row",
        sourceId: "synthetic-source",
        title: "Leadership conversation",
        truncated: true,
        includedCharacters: 60000,
        totalCharacters: 70000,
        cells: [cell],
      },
    ],
  };
  // The definition has moved on, but historical results retain their original columns.
  view.columns = [
    {
      id: "new-size",
      name: "Current team size",
      type: "number",
      instruction: "Documented team size",
    },
  ];
  let runs = [run];
  let confirmed = false,
    presentationSaved = false;
  await page.route("**/api/report-views**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === "/api/report-views")
      return route.fulfill({
        json: {
          items: [view],
          sources: [
            {
              id: "synthetic-source",
              title: "Leadership conversation",
              createdAt: "2026-10-12T00:00:00Z",
              characters: 70000,
            },
          ],
          setup: { configured: true, model: "synthetic-ui-provider" },
          limits: {
            notes: 20,
            columns: 5,
            cells: 100,
            transcriptCharacters: 60000,
            userDailyCells: 500,
            workspaceDailyCells: 2000,
          },
        },
      });
    if (request.method() === "PATCH" && path.endsWith("/presentation")) {
      expect(request.postDataJSON().runId).toBe("synthetic-run");
      expect(request.postDataJSON().presentation.groupBy).toBe(null);
      presentationSaved = true;
      view.presentation = request.postDataJSON().presentation;
      view.presentationRevision++;
      return route.fulfill({ json: { item: view, runs } });
    }
    if (request.method() === "PATCH") {
      expect(request.postDataJSON()).toEqual({
        annotation: "Follow up on team size",
      });
      cell.annotation = "Follow up on team size";
      return route.fulfill({ json: { ok: true } });
    }
    if (path.endsWith("/cancel")) {
      runs[0].status = "cancelled";
      return route.fulfill({ json: { item: runs[0] } });
    }
    if (path.endsWith("/runs")) {
      confirmed = request.postDataJSON().consent === true;
      runs = [
        { ...run, id: "synthetic-new-run", status: "queued", finishedCells: 0 },
        run,
      ];
      return route.fulfill({ status: 202, json: { item: runs[0] } });
    }
    return route.fulfill({ json: { item: view, runs } });
  });
  await page.goto("/app/reports");
  const reports = page.getByRole("region", { name: "AI report views" });
  await reports
    .getByRole("button", { name: /Leadership evidence 1 columns/ })
    .click();
  await expect(
    reports
      .locator(".ai-report-value")
      .filter({ hasText: "Led four engineers" }),
  ).toBeVisible();
  await expect(
    reports.getByRole("img", { name: /Grouped report bar chart/ }),
  ).toBeVisible();
  await expect(
    reports.getByRole("table", { name: "Grouped report values" }),
  ).toContainText("Led four engineers");
  await expect(
    reports.getByText(/1 available conversations · 1 unavailable/),
  ).toBeVisible();
  await expect(
    reports.getByRole("link", { name: "Export grouped CSV" }),
  ).toHaveAttribute(
    "href",
    "/api/report-views/synthetic-view/runs/synthetic-run/grouped.csv",
  );
  const grouping = reports.getByRole("combobox", {
    name: "Group by",
    exact: true,
  });
  await expect(grouping).toHaveValue("leadership");
  await expect(grouping.locator("option")).toHaveText([
    "All conversations",
    "Leadership example",
  ]);
  await grouping.selectOption("");
  await reports.getByRole("button", { name: "Save presentation" }).click();
  await expect(
    reports.getByText("Presentation saved. No extraction was started."),
  ).toBeVisible();
  expect(presentationSaved).toBeTruthy();
  await reports.screenshot({ path: testInfo.outputPath("report-chart.png") });
  await reports.getByText("Review source quote", { exact: true }).click();
  await expect(
    reports.getByText("Candidate: I led a team of four engineers.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    reports.getByText(/Partial transcript: 60,000 of 70,000/),
  ).toBeVisible();
  await reports.getByText("Add human annotation", { exact: true }).click();
  await reports
    .getByLabel("Human annotation for Leadership example")
    .fill("Follow up on team size");
  await reports
    .getByRole("button", { name: "Save annotation", exact: true })
    .click();
  await expect(
    reports.getByText("Human annotation saved", { exact: true }),
  ).toBeVisible();
  await expect(
    reports.getByRole("link", { name: "Export CSV" }),
  ).toHaveAttribute(
    "href",
    "/api/report-views/synthetic-view/runs/synthetic-run/export.csv",
  );
  await expect(
    reports.getByRole("button", { name: "Run extraction again" }),
  ).toBeDisabled();
  await reports
    .getByRole("checkbox", { name: /I confirm this saved view/ })
    .check();
  await reports.getByRole("button", { name: "Run extraction again" }).click();
  await expect(
    reports.getByRole("button", { name: "Cancel extraction" }),
  ).toBeVisible();
  expect(confirmed).toBeTruthy();
  await reports.getByRole("button", { name: "Cancel extraction" }).click();
  await expect(
    reports.getByRole("heading", { name: "Cancelled", exact: true }),
  ).toBeVisible();
});

test("report agent proposals survive response retries, protect editor changes and require a separate save", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const signup = await page.request.post("/api/auth/signup", {
    headers: { Origin: origin },
    data: {
      name: "Report Agent Reviewer",
      email: `report-agent-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
      password: "LocalTestPass987!",
      workspaceName: "Report agent tests",
      seedDemo: false,
    },
  });
  expect(signup.ok()).toBeTruthy();
  const conversation = await page.request.post("/api/conversations", {
    headers: { Origin: origin },
    data: {
      title: "Synthetic engineering interview",
      transcript: "Candidate: I led four engineers.",
      archived: false,
    },
  });
  expect(conversation.ok()).toBeTruthy();
  const proposal = {
    id: "synthetic-proposal",
    viewId: null,
    revision: null,
    status: "ready",
    brief: "Compare documented engineering team sizes and leadership evidence.",
    sourceCurrent: true,
    error: null,
    result: {
      name: "Team sizes",
      question: "What team sizes are documented?",
      columns: [
        {
          id: "size",
          name: "Team size",
          instruction: "Return documented team size, else null.",
          type: "number",
        },
      ],
      filters: { title: "", from: "", to: "" },
      notes: ["Review professional evidence with a human."],
    },
  };
  const requestIds: string[] = [];
  let calls = 0,
    applies = 0;
  await page.route("**/api/report-views/drafts**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (
      path.endsWith("/synthetic-proposal") &&
      route.request().method() === "GET"
    ) {
      calls = 3;
      return route.fulfill({ json: { item: proposal } });
    }
    if (path.endsWith("/apply")) {
      applies++;
      return route.fulfill({
        json: {
          definition: { ...proposal.result, notes: undefined, sourceIds: [] },
        },
      });
    }
    if (route.request().method() === "POST") {
      requestIds.push(route.request().postDataJSON().requestId);
      calls++;
      if (calls === 1) return route.abort("failed");
      return route.fulfill({
        json: {
          item:
            calls === 2
              ? { ...proposal, status: "running", result: null }
              : proposal,
        },
      });
    }
    return route.fulfill({
      json: { available: true, items: calls >= 3 ? [proposal] : [] },
    });
  });
  await page.goto("/app/reports");
  const reports = page.getByRole("region", { name: "AI report views" });
  await reports
    .getByRole("button", { name: "New AI report", exact: true })
    .click();
  await reports
    .getByRole("checkbox", { name: /Synthetic engineering interview/ })
    .check();
  await reports.getByRole("button", { name: "Draft report with AI" }).click();
  await reports.getByLabel("Report brief").fill(proposal.brief);
  await reports
    .getByRole("checkbox", { name: /I agree to send this brief/ })
    .check();
  await reports
    .getByRole("button", { name: "Generate report proposal" })
    .click();
  await expect(reports.getByRole("alert")).toBeVisible();
  await reports
    .getByRole("button", { name: "Generate report proposal" })
    .click();
  await expect(reports.getByText(/This draft is still running/)).toBeVisible();
  await reports.getByRole("button", { name: "Check draft status" }).click();
  await expect(
    reports.getByRole("heading", { name: "Team sizes", exact: true }),
  ).toBeVisible();
  expect(new Set(requestIds).size).toBe(1);
  await reports
    .getByLabel("Report name", { exact: true })
    .fill("Unsaved manual edit");
  await reports.getByRole("button", { name: "Use proposal in editor" }).click();
  await expect(reports.getByRole("alert")).toContainText("The editor changed");
  expect(applies).toBe(0);
  await reports.getByLabel("Report proposal history").selectOption("");
  await reports.getByLabel("Report proposal history").selectOption(proposal.id);
  await reports.getByRole("button", { name: "Use proposal in editor" }).click();
  await expect(reports.getByLabel("Report name", { exact: true })).toHaveValue(
    "Team sizes",
  );
  expect(
    (await (await page.request.get("/api/report-views")).json()).items,
  ).toHaveLength(0);
  await reports
    .getByRole("button", { name: "Save report view", exact: true })
    .click();
  await expect(
    reports.getByRole("heading", { name: "Team sizes", exact: true }),
  ).toBeVisible();
  const saved = (await (await page.request.get("/api/report-views")).json())
    .items[0];
  expect(saved.sourceIds).toHaveLength(1);
  expect(
    (await (await page.request.get(`/api/report-views/${saved.id}`)).json())
      .runs,
  ).toHaveLength(0);
  await reports
    .getByRole("combobox", { name: "Display", exact: true })
    .selectOption("bar");
  await reports
    .getByRole("combobox", { name: "Group by", exact: true })
    .selectOption("size");
  await reports.getByRole("button", { name: "Save presentation" }).click();
  await expect(
    reports.getByText("Presentation saved. No extraction was started."),
  ).toBeVisible();
  await page.reload();
  await reports.getByRole("button", { name: /Team sizes 1 columns/ }).click();
  await expect(
    reports.getByRole("combobox", { name: "Display", exact: true }),
  ).toHaveValue("bar");
  await expect(
    reports.getByRole("combobox", { name: "Group by", exact: true }),
  ).toHaveValue("size");
  const detail = await (
    await page.request.get(`/api/report-views/${saved.id}`)
  ).json();
  expect(detail.item.revision).toBe(1);
  expect(detail.item.presentationRevision).toBe(2);
  expect(detail.runs).toHaveLength(0);
});
