import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { docxFixture } from "../server/document-fixtures";
async function signup(page: Page, baseURL: string | undefined) {
  const headers = { Origin: new URL(baseURL!).origin };
  const response = await page.request.post("/api/auth/signup", {
    headers,
    data: {
      name: "Job Source Tester",
      email: `jobsource-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: "JobSourceTests987!",
      workspaceName: "Synthetic job sources",
      seedDemo: false,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return headers;
}
async function chooser(page: Page) {
  await page.goto("/app/job-posts");
  await page
    .getByRole("button", { name: "Create job post", exact: true })
    .first()
    .click();
  return page.getByRole("dialog", { name: "Create job post", exact: true });
}
test("template creation works without AI and saves only the reviewed description", async ({
  page,
  baseURL,
}) => {
  await signup(page, baseURL);
  const dialog = await chooser(page);
  await expect(dialog).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("job-creation.png"),
    fullPage: true,
  });
  await dialog.getByRole("button", { name: /Use a template/ }).click();
  await dialog.getByLabel("Search templates").fill("Standard");
  await dialog
    .getByRole("button", { name: /Standard job description/ })
    .click();
  const source = dialog.getByRole("region", { name: "Job source preview" });
  await expect(source).toContainText(
    "[Describe the purpose of this role and the team.]",
  );
  await source.getByRole("button", { name: "Use selected source" }).click();
  const drafting = page.getByRole("dialog", { name: "Create job from source" });
  await drafting
    .getByLabel("Draft job title", { exact: true })
    .fill("Template platform role");
  await expect(
    drafting.getByRole("button", { name: "Generate private draft" }),
  ).toBeDisabled();
  await drafting
    .getByRole("button", { name: "Use template without AI" })
    .click();
  const preview = drafting.getByRole("region", { name: "Job draft preview" });
  await expect(preview.getByLabel("Proposed job description")).toContainText(
    "About the role",
  );
  expect(
    (await (await page.request.get("/api/jobs")).json()).items,
  ).toHaveLength(0);
  await preview
    .getByLabel("Proposed job description")
    .fill("Reviewed platform engineering responsibilities.");
  await preview.getByLabel(/I reviewed this description/).check();
  await preview
    .getByRole("button", { name: "Create workspace draft job" })
    .click();
  await expect(drafting).not.toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: "Template platform role", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Job post preview" }),
  ).toContainText("Reviewed platform engineering responsibilities.");
  const job = (await (await page.request.get("/api/jobs")).json()).items[0];
  expect(job.status).toBe("draft");
  expect(job.description).not.toContain("[Describe");
});
test("DOCX uploads preview private text and deleted sources hide saved drafts", async ({
  page,
  baseURL,
}) => {
  await signup(page, baseURL);
  const dialog = await chooser(page);
  await dialog
    .getByRole("button", { name: /Upload a job description/ })
    .click();
  await dialog.getByLabel("Job description document").setInputFiles({
    name: "Engineering role.docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: docxFixture([
      "Build reliable APIs and collaborate with product teams.",
    ]),
  });
  await dialog.getByRole("button", { name: "Extract document text" }).click();
  const preview = dialog.getByRole("region", { name: "Job source preview" });
  await expect(preview).toContainText("Build reliable APIs");
  expect(
    (await (await page.request.get("/api/conversations")).json()).items,
  ).toHaveLength(0);
  await preview.getByRole("button", { name: "Use selected source" }).click();
  const drafting = page.getByRole("dialog", { name: "Create job from source" });
  await drafting
    .getByLabel("Draft job title", { exact: true })
    .fill("Uploaded engineering role");
  await drafting
    .getByRole("button", { name: "Copy source into editable draft" })
    .click();
  await expect(
    drafting.getByRole("region", { name: "Job draft preview" }),
  ).toContainText("Copied from your selected source.");
  await drafting.getByRole("button", { name: "Close dialog" }).click();
  await page
    .getByRole("button", { name: "Create job post", exact: true })
    .first()
    .click();
  await dialog
    .getByRole("button", { name: /Upload a job description/ })
    .click();
  await dialog
    .getByRole("button", { name: "Delete source Engineering role.docx" })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Delete source Engineering role.docx" }),
  ).not.toBeVisible();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await page
    .getByRole("button", { name: "AI job drafts", exact: true })
    .click();
  const history = page.getByRole("dialog", { name: "AI job drafts" });
  await history
    .getByRole("button", { name: "Source unavailable · stale", exact: true })
    .click();
  await expect(
    history.getByRole("region", { name: "Job draft preview" }),
  ).toContainText("The source changed or access was removed");
  await expect(
    history.getByLabel("Proposed job description"),
  ).not.toBeVisible();
  expect(
    (await (await page.request.get("/api/jobs")).json()).items,
  ).toHaveLength(0);
});
test("intake selection passes an immutable source reference to AI drafting", async ({
  page,
  baseURL,
}) => {
  const headers = await signup(page, baseURL);
  const conversation = await page.request.post("/api/conversations", {
    headers,
    data: {
      title: "Platform hiring intake",
      transcript: "Manager: Build reliable TypeScript APIs.",
      date: new Date().toISOString(),
      status: "ready",
    },
  });
  expect(conversation.ok()).toBeTruthy();
  const item = (await conversation.json()).item;
  const draft = {
    id: crypto.randomUUID(),
    jobId: null,
    title: "Intake engineering role",
    status: "ready",
    sourceCurrent: true,
    error: null,
    model: "synthetic",
    createdAt: new Date().toISOString(),
    result: {
      description: "Build reliable TypeScript APIs.",
      suggestions: [],
      missingDetails: [],
    },
  };
  let generated = false;
  await page.route("**/api/job-drafts", async (route) => {
    if (route.request().method() === "POST") {
      const input = route.request().postDataJSON();
      expect(input.source.kind).toBe("conversation");
      expect(input.source.id).toBe(item.id);
      expect(input.source.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(input.source.text).toBeUndefined();
      generated = true;
      await route.fulfill({ status: 201, json: { item: draft } });
    } else
      await route.fulfill({
        json: { available: true, items: generated ? [draft] : [] },
      });
  });
  const dialog = await chooser(page);
  await dialog.getByRole("button", { name: /From an intake call/ }).click();
  await dialog.getByRole("button", { name: /Platform hiring intake/ }).click();
  await expect(
    dialog.getByRole("region", { name: "Job source preview" }),
  ).toContainText("Manager: Build reliable TypeScript APIs.");
  await dialog.getByRole("button", { name: "Use selected source" }).click();
  const drafting = page.getByRole("dialog", { name: "Create job from source" });
  await drafting
    .getByLabel("Draft job title", { exact: true })
    .fill("Intake engineering role");
  await drafting
    .getByRole("button", { name: "Generate private draft" })
    .click();
  await expect(drafting.getByLabel("Proposed job description")).toHaveValue(
    "Build reliable TypeScript APIs.",
  );
  expect(
    (await (await page.request.get("/api/jobs")).json()).items,
  ).toHaveLength(0);
});
