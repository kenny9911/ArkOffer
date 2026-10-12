import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
async function signup(page: Page, baseURL: string | undefined) {
  const headers = { Origin: new URL(baseURL!).origin };
  const response = await page.request.post("/api/auth/signup", {
    headers,
    data: {
      name: "Job Draft Tester",
      email: `jobdraft-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
      password: "JobDraftTests987!",
      workspaceName: "Synthetic job drafting",
      seedDemo: false,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return headers;
}
test("job AI drafting explains missing provider setup and leaves manual job creation available", async ({
  page,
  baseURL,
}) => {
  await signup(page, baseURL);
  await page.goto("/app/job-posts");
  await page
    .getByRole("button", { name: "AI job drafts", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "AI job drafts" });
  await expect(dialog).toContainText(
    "Text AI is not enabled for this workspace",
  );
  await expect(
    dialog.getByRole("button", { name: "Generate private draft" }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await page
    .getByRole("button", { name: "Create job post", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: /Start from scratch/ }).click();
  await page.getByLabel("Job title", { exact: true }).fill("Manual role");
  await page
    .getByLabel("Job description", { exact: true })
    .fill("Manual description remains available.");
  await page
    .getByRole("button", { name: "Save job post", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Manual role", exact: true }),
  ).toBeVisible();
});
test("private job draft preview requires approval, preserves reviewed edits and creates a persistent draft job", async ({
  page,
  baseURL,
}) => {
  const headers = await signup(page, baseURL);
  const draft = {
    id: "dfeea9c4-cb7d-49ba-866d-4955c1709451",
    jobId: null,
    title: "Platform Engineer",
    status: "ready",
    sourceCurrent: true,
    error: null,
    model: "synthetic-test-model",
    createdAt: new Date().toISOString(),
    result: {
      description: "Build reliable services.",
      suggestions: ["Clarify the interview process."],
      missingDetails: ["Confirm working hours."],
    },
  };
  let generated = false;
  await page.route("**/api/job-drafts", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      expect(body.details.title).toBe("Platform Engineer");
      expect(body.brief).toContain("TypeScript");
      generated = true;
      await route.fulfill({ status: 201, json: { item: draft } });
    } else
      await route.fulfill({
        json: { available: true, items: generated ? [draft] : [] },
      });
  });
  await page.route(`**/api/job-drafts/${draft.id}/apply`, async (route) => {
    const body = route.request().postDataJSON();
    expect(body.confirm).toBe(true);
    const response = await page.request.post("/api/jobs", {
      headers,
      data: {
        title: draft.title,
        description: body.description,
        status: "draft",
      },
    });
    expect(response.ok()).toBeTruthy();
    await route.fulfill({ json: await response.json() });
  });
  await page.goto("/app/job-posts");
  await page
    .getByRole("button", { name: "AI job drafts", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "AI job drafts" });
  await dialog
    .getByLabel("Draft job title", { exact: true })
    .fill("Platform Engineer");
  await dialog
    .getByLabel("Role brief", { exact: true })
    .fill("Build TypeScript services.");
  await dialog.getByRole("button", { name: "Generate private draft" }).click();
  const preview = dialog.getByRole("region", { name: "Job draft preview" });
  await expect(preview.getByLabel("Proposed job description")).toHaveValue(
    "Build reliable services.",
  );
  expect(
    (await (await page.request.get("/api/jobs")).json()).items,
  ).toHaveLength(0);
  await expect(
    preview.getByRole("button", { name: "Create workspace draft job" }),
  ).toBeDisabled();
  await preview
    .getByLabel("Proposed job description")
    .fill("Reviewed TypeScript services role.");
  await preview.getByLabel(/I reviewed this description/).check();
  await preview
    .getByRole("button", { name: "Create workspace draft job" })
    .click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: "Platform Engineer", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Job post preview" }),
  ).toContainText("Reviewed TypeScript services role.");
  const jobs = (await (await page.request.get("/api/jobs")).json()).items;
  expect(jobs).toHaveLength(1);
  expect(jobs[0].status).toBe("draft");
});

test("job drafting retries keep one request ID while a lost-response draft is running", async ({
  page,
  baseURL,
}) => {
  await signup(page, baseURL);
  const draft = {
    id: crypto.randomUUID(),
    jobId: null,
    title: "Retry role",
    status: "running",
    sourceCurrent: true,
    error: null,
    model: "synthetic",
    createdAt: new Date().toISOString(),
    result: null as null | {
      description: string;
      suggestions: string[];
      missingDetails: string[];
    },
  };
  const ids: string[] = [];
  await page.route("**/api/job-drafts", async (route) => {
    if (route.request().method() === "POST") {
      ids.push(route.request().postDataJSON().requestId);
      if (ids.length === 1) {
        await route.abort("connectionfailed");
        return;
      }
      if (ids.length === 2) {
        await route.fulfill({
          status: 502,
          contentType: "text/html",
          body: "<h1>Gateway unavailable</h1>",
        });
        return;
      }
      if (ids.length === 4) {
        draft.status = "ready";
        draft.result = {
          description: "Reviewed retry draft",
          suggestions: [],
          missingDetails: [],
        };
      }
      await route.fulfill({ json: { item: draft, reused: true } });
    } else
      await route.fulfill({
        json: { available: true, items: ids.length ? [draft] : [] },
      });
  });
  await page.goto("/app/job-posts");
  await page
    .getByRole("button", { name: "AI job drafts", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "AI job drafts" });
  await dialog
    .getByLabel("Draft job title", { exact: true })
    .fill("Retry role");
  await dialog
    .getByLabel("Role brief", { exact: true })
    .fill("Build reliable APIs");
  const generate = dialog.getByRole("button", {
    name: "Generate private draft",
  });
  await generate.click();
  await expect.poll(() => ids.length).toBe(1);
  await expect(generate).toBeEnabled();
  await generate.click();
  await expect(dialog).toContainText("The server response could not be read");
  await expect(generate).toBeEnabled();
  await generate.click();
  await expect(dialog).toContainText("This draft is still running");
  await expect(generate).toBeEnabled();
  await generate.click();
  await expect(dialog.getByLabel("Proposed job description")).toHaveValue(
    "Reviewed retry draft",
  );
  expect(ids).toHaveLength(4);
  expect(new Set(ids).size).toBe(1);
});

test("a confirmed job AI timeout offers one explicit new attempt without replaying the failed request", async ({
  page,
  baseURL,
}) => {
  await signup(page, baseURL);
  const draft = {
    id: crypto.randomUUID(),
    jobId: null,
    title: "Timeout role",
    status: "failed",
    sourceCurrent: true,
    error: "The AI provider took too long to respond. Please try again.",
    model: "synthetic",
    createdAt: new Date().toISOString(),
    result: null as null | {
      description: string;
      suggestions: string[];
      missingDetails: string[];
    },
  };
  const ids: string[] = [];
  await page.route("**/api/job-drafts", async (route) => {
    if (route.request().method() === "POST") {
      ids.push(route.request().postDataJSON().requestId);
      if (ids.length === 1) {
        await route.fulfill({
          status: 502,
          json: {
            error: draft.error,
            requestId: ids[0],
            generationStatus: "failed",
          },
        });
        return;
      }
      draft.id = crypto.randomUUID();
      draft.status = "ready";
      draft.result = {
        description: "A fresh, explicitly requested draft.",
        suggestions: [],
        missingDetails: [],
      };
      await route.fulfill({ status: 201, json: { item: draft } });
    } else
      await route.fulfill({
        json: { available: true, items: ids.length ? [draft] : [] },
      });
  });
  await page.goto("/app/job-posts");
  await page
    .getByRole("button", { name: "AI job drafts", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "AI job drafts" });
  await dialog.getByLabel("Draft job title", { exact: true }).fill(draft.title);
  await dialog
    .getByLabel("Role brief", { exact: true })
    .fill("Build reliable APIs");
  await dialog.getByRole("button", { name: "Generate private draft" }).click();
  await expect(dialog).toContainText("The AI provider took too long");
  const retry = dialog.getByRole("button", { name: "Try a new AI draft" });
  await expect(retry).toBeEnabled();
  expect(ids).toHaveLength(1);
  await retry.click();
  await expect(dialog.getByLabel("Proposed job description")).toHaveValue(
    "A fresh, explicitly requested draft.",
  );
  expect(ids).toHaveLength(2);
  expect(ids[0]).not.toBe(ids[1]);
  expect(
    (await (await page.request.get("/api/jobs")).json()).items,
  ).toHaveLength(0);
});
