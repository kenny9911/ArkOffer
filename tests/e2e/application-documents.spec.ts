import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { pdfFixture, docxFixture } from "../server/document-fixtures";

async function seed(page: Page, baseURL: string) {
  const headers = { Origin: new URL(baseURL).origin };
  const signup = await page.request.post("/api/auth/signup", {
    headers,
    data: {
      name: "CV Reviewer",
      email: `cv-${randomUUID()}@example.com`,
      password: "LocalTestPass987!",
      workspaceName: "CV review tests",
      seedDemo: false,
    },
  });
  expect(signup.ok(), await signup.text()).toBeTruthy();
  const create = async (kind: string, data: Record<string, unknown>) => {
    const response = await page.request.post(`/api/${kind}`, { headers, data });
    expect(response.ok(), await response.text()).toBeTruthy();
    return (await response.json()).item;
  };
  const job = await create("jobs", {
    title: "API engineer",
    description: "Build TypeScript APIs",
    status: "open",
  });
  const application = await create("applications", {
    name: "Alex Applicant",
    jobId: job.id,
    jobTitle: job.title,
    status: "in_review",
  });
  const criterion = {
    id: randomUUID(),
    text: "TypeScript API experience",
    importance: "required",
  };
  const saved = await page.request.put(`/api/jobs/${job.id}/review-criteria`, {
    headers,
    data: { revision: 0, criteria: [criterion], approved: true },
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  return { headers, application, criterion };
}

test("private CVs upload, preview, persist, select and delete without AI or changing application status", async ({
  page,
  baseURL,
}) => {
  const { application } = await seed(page, baseURL!);
  await page.goto("/app/applications");
  const review = page.getByRole("region", {
      name: "Application evidence review",
    }),
    cvs = page.getByRole("region", { name: "Private CV evidence" });
  await expect(
    cvs.getByText("No private CVs uploaded for this application."),
  ).toBeVisible();
  await cvs.getByLabel("Upload a CV").setInputFiles({
    name: "Alex CV.pdf",
    mimeType: "application/pdf",
    buffer: pdfFixture([
      "Built TypeScript APIs",
      "Led a four-person engineering team",
    ]),
  });
  await expect(
    cvs.getByRole("heading", { name: "Extracted text: Alex CV.pdf" }),
  ).toBeVisible();
  await expect(cvs.locator("pre")).toContainText("Built TypeScript APIs");
  await expect(
    cvs.getByRole("checkbox", { name: /Alex CV.pdf/ }),
  ).not.toBeChecked();
  await cvs.getByRole("checkbox", { name: /Alex CV.pdf/ }).check();
  await expect(
    review.getByRole("button", { name: "Analyze selected evidence" }),
  ).toBeDisabled();
  await page.reload();
  await cvs.getByRole("button", { name: "Preview Alex CV.pdf" }).click();
  await expect(cvs.locator("pre")).toContainText(
    "Led a four-person engineering team",
  );
  await cvs.getByLabel("Upload a CV").setInputFiles({
    name: "Updated CV.docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: docxFixture([
      "Built TypeScript APIs",
      "Relevant professional experience",
    ]),
  });
  await expect(
    cvs.getByRole("heading", { name: "Extracted text: Updated CV.docx" }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("private-cv-evidence.png"),
    fullPage: true,
  });
  await cvs.getByRole("button", { name: "Delete Updated CV.docx" }).click();
  await cvs.getByRole("button", { name: "Keep CV" }).click();
  await expect(
    cvs.getByRole("checkbox", { name: /Updated CV.docx/ }),
  ).toBeVisible();
  await cvs.getByRole("button", { name: "Delete Updated CV.docx" }).click();
  await cvs.getByRole("button", { name: "Delete CV", exact: true }).click();
  await expect(
    cvs.getByRole("checkbox", { name: /Updated CV.docx/ }),
  ).toHaveCount(0);
  await cvs.getByLabel("Upload a CV").setInputFiles({
    name: "Broken.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("not a PDF"),
  });
  await expect(cvs.getByRole("alert")).toContainText("not a valid PDF");
  const state = await (
    await page.request.get(`/api/applications/${application.id}`)
  ).json();
  expect(state.item.status).toBe("in_review");
  const notes = await (await page.request.get("/api/conversations")).json();
  expect(notes.items).toHaveLength(0);
});

test("explicit CV consent sends a source fingerprint and deletion hides a cached AI review", async ({
  page,
  baseURL,
}) => {
  const { application, criterion } = await seed(page, baseURL!);
  let saved: Record<string, unknown> | null = null,
    submitted: any;
  const path = `/api/applications/${application.id}/review-assistance`;
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() === "GET") {
      const response = await route.fetch(),
        data = await response.json();
      const documents = await (
        await page.request.get(`/api/applications/${application.id}/documents`)
      ).json();
      await route.fulfill({
        json: {
          ...data,
          setup: { enabled: true },
          items: saved
            ? documents.items.length
              ? [saved]
              : [
                  {
                    id: saved.id,
                    status: "stale",
                    createdAt: new Date().toISOString(),
                    error:
                      "Evidence, criteria, or access changed. Generate a fresh review.",
                  },
                ]
            : [],
        },
      });
    } else {
      submitted = route.request().postDataJSON();
      const document = (
        await (
          await page.request.get(
            `/api/applications/${application.id}/documents/${submitted.documents[0].id}`,
          )
        ).json()
      ).item;
      saved = {
        id: randomUUID(),
        status: "complete",
        createdAt: new Date().toISOString(),
        notes: "",
        output: {
          provider: "test",
          model: "fixture",
          approvedCriteria: [criterion],
          sources: [
            {
              id: `document:${document.id}`,
              title: document.title,
              text: document.text,
            },
          ],
          criteria: [
            {
              criterionId: criterion.id,
              evidence: [
                {
                  sourceId: `document:${document.id}`,
                  quote: "Built TypeScript APIs",
                },
              ],
              missingInformation: "Scope is not established.",
              followUp: "What was the project scope?",
            },
          ],
        },
      };
      await route.fulfill({ status: 201, json: { item: saved } });
    }
  });
  await page.goto("/app/applications");
  const review = page.getByRole("region", {
      name: "Application evidence review",
    }),
    cvs = page.getByRole("region", { name: "Private CV evidence" });
  await cvs.getByLabel("Upload a CV").setInputFiles({
    name: "Alex CV.pdf",
    mimeType: "application/pdf",
    buffer: pdfFixture(["Built TypeScript APIs"]),
  });
  await cvs.getByRole("checkbox", { name: /Alex CV.pdf/ }).check();
  await expect(
    review.getByRole("button", { name: "Analyze selected evidence" }),
  ).toBeDisabled();
  await review
    .getByRole("checkbox", { name: /I verified these sources belong/ })
    .check();
  await review
    .getByRole("button", { name: "Analyze selected evidence" })
    .click();
  await expect(review.locator("blockquote")).toHaveText(
    "Built TypeScript APIs",
  );
  expect(submitted.documents).toHaveLength(1);
  expect(submitted.documents[0].fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(submitted.consent).toBe(true);
  await cvs.getByRole("button", { name: "Delete Alex CV.pdf" }).click();
  await cvs.getByRole("button", { name: "Delete CV", exact: true }).click();
  await expect(review.locator("blockquote")).toHaveCount(0);
  await expect(
    review.getByText(
      "Evidence, criteria, or access changed. Generate a fresh review.",
    ),
  ).toBeVisible();
  await expect(
    review.getByRole("checkbox", { name: /I verified these sources belong/ }),
  ).not.toBeChecked();
});
