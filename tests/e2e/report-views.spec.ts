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
}) => {
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
  let runs = [run];
  let confirmed = false;
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
    reports.getByText("Led four engineers", { exact: true }),
  ).toBeVisible();
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
