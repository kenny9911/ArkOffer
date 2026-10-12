import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { readFile } from "node:fs/promises";

async function signup(page: Page, baseURL: string | undefined) {
  if (!baseURL)
    throw new Error("The business tests require a configured baseURL.");
  const response = await page.request.post("/api/auth/signup", {
    headers: { Origin: new URL(baseURL).origin },
    data: {
      name: "Business Test",
      email: `business-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
      password: "LocalTestPass987!",
      workspaceName: "Business test workspace",
      seedDemo: false,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function seed(
  page: Page,
  baseURL: string | undefined,
  resource: string,
  data: Record<string, unknown>,
) {
  const response = await page.request.post(`/api/${resource}`, {
    headers: { Origin: new URL(baseURL!).origin },
    data,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()).item;
}

test.beforeEach(async ({ page, baseURL }) => {
  await signup(page, baseURL);
});

test("candidate creation, quoted CSV import, saved searches and manual review persist", async ({
  page,
}) => {
  await page.goto("/app/candidates");
  await page
    .getByRole("button", { name: "Add candidate", exact: true })
    .first()
    .click();
  await page.getByLabel("Full name").fill("Jamie Example");
  await page.getByLabel("Email", { exact: true }).fill("jamie@example.com");
  await page.getByLabel("Current role").fill("Software engineer");
  await page.getByLabel("Company", { exact: true }).fill("Example Labs");
  await page.getByLabel("Location", { exact: true }).fill("Singapore");
  await page.getByLabel("Skills").fill("TypeScript, React");
  await page
    .getByRole("button", { name: "Save candidate", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Jamie Example jamie@example.com" }),
  ).toBeVisible();
  await page.getByLabel("Review status for Jamie Example").selectOption("yes");
  await page.locator('input[type="file"]').setInputFiles({
    name: "candidates.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      'name,email,role,company,location,skills,notes\r\n"Lee, Example",lee@example.com,Designer,"Example, Inc.",Singapore,"Research, Figma","A quoted ""detail""\nand another line"\r\nJamie Duplicate,jamie@example.com,Engineer,Example,Singapore,React,Duplicate email\r\n',
    ),
  });
  await expect(page.getByRole("dialog")).toContainText("Lee, Example");
  await page
    .getByRole("button", { name: "Import candidates", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Imported 1 candidates; skipped 1 existing email addresses.",
  );
  await page
    .getByLabel("Search your candidate library")
    .fill("Software engineer in Singapore");
  await expect(
    page.getByRole("button", { name: "Jamie Example jamie@example.com" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Lee, Example lee@example.com" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Save search", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Singapore engineering");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await page.reload();
  await page
    .getByRole("button", { name: "Singapore engineering", exact: true })
    .click();
  await expect(page.getByLabel("Review status for Jamie Example")).toHaveValue(
    "yes",
  );
  await page.getByLabel("Search your candidate library").fill("");
  await page
    .getByRole("button", { name: "Lee, Example lee@example.com" })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    'A quoted "detail"\nand another line',
  );
  await page.getByLabel("Close dialog").click();
  await page
    .getByRole("button", { name: "Delete Lee, Example", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Lee, Example lee@example.com" }),
  ).toHaveCount(0);
});

test("draft sequences save multiple steps and candidate enrollment without sending", async ({
  page,
  baseURL,
}) => {
  await seed(page, baseURL, "candidates", {
    name: "Avery Example",
    email: "avery@example.com",
  });
  await page.goto("/app/sequences");
  await page
    .getByRole("link", { name: "New sequence", exact: true })
    .first()
    .click();
  await page.getByLabel("Sequence title").fill("Engineering introduction");
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  await page
    .getByLabel("Description", { exact: true })
    .fill("Personal outreach draft");
  await page.getByRole("tab", { name: "Steps", exact: true }).click();
  await page
    .getByLabel("Step 1 subject", { exact: true })
    .fill("An introduction");
  await page
    .getByLabel("Step 1 body", { exact: true })
    .fill("Hello Avery, I would love to introduce our team.");
  await page.getByRole("button", { name: "New step", exact: true }).click();
  await page.getByLabel("Step 2 subject", { exact: true }).fill("Following up");
  await page
    .getByLabel("Step 2 body", { exact: true })
    .fill("A short follow-up with more context.");
  await page.getByLabel("Step 2 delay").selectOption("5");
  await page
    .getByRole("button", { name: "Candidates (0)", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: "Avery Example avery@example.com" })
    .check();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Done", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Save sequence", exact: true })
    .click();
  await expect(page).toHaveURL(/\/app\/sequences\/[a-f0-9-]+$/);
  await page.reload();
  await expect(page.getByLabel("Step 2 delay")).toHaveValue("5");
  await expect(page.getByLabel("Step 2 body", { exact: true })).toHaveValue(
    "A short follow-up with more context.",
  );
  await expect(
    page.getByRole("button", { name: "Candidates (1)", exact: true }),
  ).toBeVisible();
  const items = (await (await page.request.get("/api/sequences")).json()).items;
  expect(items[0].steps).toHaveLength(2);
  expect(items[0].enrolledCandidateIds).toHaveLength(1);
  const activity = await (
    await page.request.get(`/api/sequences/${items[0].id}/delivery`)
  ).json();
  expect(activity.enrollments).toHaveLength(0);
});

test("job descriptions and manual application decisions are editable and persistent", async ({
  page,
  baseURL,
}) => {
  await seed(page, baseURL, "candidates", {
    name: "Morgan Example",
    email: "morgan@example.com",
  });
  await page.goto("/app/job-posts");
  await page
    .getByRole("button", { name: "Create job post", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: /Start from scratch/ }).click();
  await page.getByLabel("Job title", { exact: true }).fill("Product Designer");
  await page.getByLabel("Department", { exact: true }).fill("Design");
  await page.getByLabel("Location", { exact: true }).fill("Singapore");
  await page.getByLabel("Status", { exact: true }).selectOption("open");
  await page
    .getByLabel("Job description", { exact: false })
    .fill(
      "About the role\n\nDesign accessible, thoughtful product experiences.",
    );
  await page
    .getByRole("button", { name: "Save job post", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Product Designer", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "Design accessible, thoughtful product experiences.",
  );
  await page.getByLabel("Close dialog").click();
  await page.goto("/app/applications");
  await page
    .getByRole("button", { name: "Add application", exact: true })
    .first()
    .click();
  await page
    .getByLabel("Use an existing candidate")
    .selectOption({ label: "Morgan Example" });
  await page
    .getByLabel("Job", { exact: true })
    .selectOption({ label: "Product Designer" });
  await page.getByLabel("Your decision").selectOption("shortlisted");
  await page
    .getByLabel("Review notes", { exact: false })
    .fill("Portfolio demonstrates the required product design experience.");
  await page.getByRole("button", { name: "Save review", exact: true }).click();
  await page.reload();
  await page
    .getByLabel("Filter by application status")
    .selectOption("shortlisted");
  await expect(
    page.getByRole("row").filter({ hasText: "Morgan Example" }),
  ).toContainText("Product Designer");
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.getByLabel("Review notes", { exact: false })).toHaveValue(
    "Portfolio demonstrates the required product design experience.",
  );
  await page.getByLabel("Your decision").selectOption("hired");
  await page.getByRole("button", { name: "Save review", exact: true }).click();
  await page.getByLabel("Filter by application status").selectOption("hired");
  await expect(
    page.getByRole("row").filter({ hasText: "Morgan Example" }),
  ).toContainText("hired");
});

test("screening draft builder and candidate preview preserve questions without collecting responses", async ({
  page,
}) => {
  await page.goto("/app/screening/new");
  await page
    .getByRole("button", { name: "Start from scratch", exact: true })
    .click();
  await page.getByRole("tab", { name: "Setup", exact: true }).click();
  await page.getByLabel("Screening title").fill("Designer introduction");
  await page
    .getByLabel("Introduction for candidates")
    .fill("Tell us about your relevant experience.");
  await page.getByRole("tab", { name: "Interview", exact: true }).click();
  await page.getByRole("button", { name: "Add question", exact: true }).click();
  await page
    .getByLabel("Question text")
    .fill("What product work are you proud of?");
  await page.getByRole("button", { name: "Add question", exact: true }).click();
  await page
    .getByLabel("Question text")
    .nth(1)
    .fill("Which design tool do you use most?");
  await page.getByLabel("Answer type").nth(1).selectOption("multiple-choice");
  await page
    .getByLabel("Answer options", { exact: false })
    .fill("Figma\nSketch\nOther");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page).toHaveURL(
    /\/app\/screening\/[a-f0-9-]+(?:\?tab=builder)?$/,
  );
  await expect(page.getByRole("status")).toHaveText("Draft saved");
  await page.reload();
  await page
    .getByRole("button", { name: "Try candidate preview", exact: true })
    .click();
  const preview = page.getByRole("dialog", { name: "Candidate preview" });
  await preview
    .getByLabel("1. What product work are you proud of?", { exact: true })
    .fill("A thoughtful redesign of an onboarding experience.");
  await preview
    .getByLabel("2. Which design tool do you use most?", { exact: true })
    .selectOption("Figma");
  await preview
    .getByRole("button", { name: "Finish preview", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "These responses have not been collected or saved.",
  );
  await page.getByLabel("Close dialog").click();
  await page.getByRole("tab", { name: "Interview", exact: true }).click();
  await expect(page.getByLabel("Answer options", { exact: false })).toHaveValue(
    "Figma\nSketch\nOther",
  );
  await page.getByRole("tab", { name: "Setup", exact: true }).click();
  await page
    .getByLabel("Screening title")
    .fill("Updated designer introduction");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Draft saved");
  await page.reload();
  await page.getByRole("tab", { name: "Setup", exact: true }).click();
  await expect(page.getByLabel("Screening title", { exact: true })).toHaveValue(
    "Updated designer introduction",
  );
});

test("reports aggregate actual records, save filters and export safely escaped CSV", async ({
  page,
  baseURL,
}) => {
  const job = await seed(page, baseURL, "jobs", {
    title: "Engineering",
    status: "open",
  });
  const candidate = await seed(page, baseURL, "candidates", {
    name: "Casey, Example",
    email: "casey@example.com",
    status: "yes",
  });
  await seed(page, baseURL, "applications", {
    name: "Casey, Example",
    email: "casey@example.com",
    candidateId: candidate.id,
    jobId: job.id,
    jobTitle: "Engineering",
    status: "hired",
    notes: '=FORMULA()\nQuoted "note"',
  });
  await page.goto("/app/reports/analytics");
  await expect(
    page.locator(".business-stat").filter({ hasText: "Hiring conversion" }),
  ).toContainText("100%");
  await expect(
    page.getByRole("img", {
      name: "Application pipeline: applied: 0, in review: 0, shortlisted: 0, rejected: 0, hired: 1",
    }),
  ).toBeVisible();
  await page.getByLabel("Job", { exact: true }).selectOption(job.id);
  await page.getByRole("button", { name: "Save report", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Engineering hiring");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await page.reload();
  await page
    .getByRole("button", { name: "Engineering hiring", exact: true })
    .click();
  await expect(page.getByLabel("Job", { exact: true })).toHaveValue(job.id);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("arkoffer-applications.csv");
  const path = await download.path();
  expect(path).toBeTruthy();
  const csv = await readFile(path!, "utf8");
  expect(csv).toContain('"Casey, Example"');
  expect(csv).toContain('"\'=FORMULA()\nQuoted ""note"""');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "Export CSV", exact: true }),
  ).toBeVisible();
  const mobileDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV", exact: true }).click();
  expect((await mobileDownload).suggestedFilename()).toBe(
    "arkoffer-applications.csv",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
});

test("published screening links collect one anonymous response and support private review and revocation", async ({
  page,
  browser,
  baseURL,
}) => {
  const screening = await seed(page, baseURL, "screenings", {
    name: "Engineering introduction",
    title: "Engineering introduction",
    description: "Tell our team about your relevant experience.",
    privateCandidateData: "PRIVATE_SENTINEL_NOT_FOR_CANDIDATES",
    questions: [
      {
        prompt: "Describe a project you contributed to.",
        type: "text",
        required: true,
        options: [],
      },
      {
        prompt: "Which language do you use most?",
        type: "multiple-choice",
        required: true,
        options: ["TypeScript", "Python", "Other"],
      },
    ],
  });
  await page.goto(`/app/screening/${screening.id}`);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Later edits do not change existing links.",
  );
  await page
    .getByRole("button", { name: "Create candidate link", exact: true })
    .click();
  const candidateUrl = await page
    .getByLabel("Candidate link", { exact: true })
    .inputValue();
  expect(candidateUrl).toMatch(/\/interviews\/[a-f0-9]{64}$/);
  await expect(page.getByRole("dialog")).toContainText(
    "Anyone who holds this link",
  );
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const edited = await page.request.patch(`/api/screenings/${screening.id}`, {
    headers: { Origin: new URL(baseURL!).origin },
    data: {
      title: "Edited questionnaire",
      questions: [
        {
          prompt: "New draft question",
          type: "text",
          required: true,
          options: [],
        },
      ],
    },
  });
  expect(edited.ok()).toBeTruthy();
  const candidateContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  try {
    const candidate = await candidateContext.newPage();
    await candidate.goto(candidateUrl);
    const anonymous = await candidate.request.get(
      `${new URL(candidateUrl).origin}/api/auth/me`,
    );
    expect((await anonymous.json()).user).toBeNull();
    await expect(
      candidate.getByRole("heading", {
        name: "Engineering introduction",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      candidate.getByText("New draft question", { exact: true }),
    ).toHaveCount(0);
    await expect(
      candidate.getByText("PRIVATE_SENTINEL_NOT_FOR_CANDIDATES", {
        exact: true,
      }),
    ).toHaveCount(0);
    await candidate
      .getByLabel("Full name", { exact: true })
      .fill("Taylor Example");
    await candidate
      .getByLabel("Email address", { exact: true })
      .fill("taylor@example.com");
    await candidate
      .getByLabel("Describe a project you contributed to.", { exact: false })
      .fill(
        "I implemented accessible forms and tested the end-to-end workflow.",
      );
    await candidate
      .getByLabel("Which language do you use most?", { exact: false })
      .selectOption("TypeScript");
    await candidate.getByRole("checkbox", { name: /I agree to share/ }).check();
    await candidate
      .getByRole("button", { name: "Submit responses", exact: true })
      .click();
    await expect(
      candidate.getByRole("heading", {
        name: "Thank you for sharing your experience.",
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await candidate.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBeTruthy();
    await candidate.reload();
    await expect(
      candidate.getByRole("heading", {
        name: "This questionnaire is complete.",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      candidate.getByText("taylor@example.com", { exact: true }),
    ).toHaveCount(0);
    await page.getByRole("tab", { name: "Candidates", exact: true }).click();
    await page.getByText("Taylor Example", { exact: true }).click();
    await expect(
      page.getByRole("complementary", { name: "Review Taylor Example" }),
    ).toContainText(
      "I implemented accessible forms and tested the end-to-end workflow.",
    );
    await expect(
      page.getByRole("complementary", { name: "Review Taylor Example" }),
    ).toContainText("Candidate consented on");
    await page.getByRole("tab", { name: /Candidate links/ }).click();
    await page
      .getByRole("button", { name: "Revoke link", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Confirm revoke", exact: true })
      .click();
    await expect(
      page.getByRole("cell", { name: "revoked", exact: true }),
    ).toBeVisible();
    await candidate.reload();
    await expect(
      candidate.getByRole("heading", {
        name: "This link is unavailable",
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("tab", { name: /All candidates/ }).click();
    await expect(
      page.getByRole("button", { name: "Taylor Example", exact: true }),
    ).toBeVisible();
  } finally {
    await candidateContext.close();
  }
});
