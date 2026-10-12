import { randomUUID } from "node:crypto";
import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures";

async function seed(page: Page, baseURL: string) {
  const headers = { Origin: new URL(baseURL).origin };
  const signup = await page.request.post("/api/auth/signup", {
    headers,
    data: {
      name: "Application Reviewer",
      email: `review-${randomUUID()}@example.com`,
      password: "LocalTestPass987!",
      workspaceName: "Review tests",
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
    title: "TypeScript engineer",
    description: "Build TypeScript applications.",
    status: "open",
  });
  const candidate = await create("candidates", {
    name: "Alex Applicant",
    role: "TypeScript engineer",
    skills: "TypeScript",
  });
  const application = await create("applications", {
    name: "Alex Applicant",
    jobId: job.id,
    jobTitle: job.title,
    candidateId: candidate.id,
    status: "in_review",
  });
  const note = await create("conversations", {
    title: "Verified technical interview",
    transcript: "Candidate: I built TypeScript applications.",
    sections: [],
  });
  return { headers, job, candidate, application, note };
}

test("application review offers manual criteria when AI setup is unavailable", async ({
  page,
  baseURL,
}) => {
  const { application } = await seed(page, baseURL!);
  await page.goto("/app/applications");
  const review = page.getByRole("region", {
    name: "Application evidence review",
  });
  await expect(
    review.getByText("AI application review is unavailable.", { exact: false }),
  ).toBeVisible();
  await expect(
    review.getByRole("button", { name: "Draft criteria with AI" }),
  ).toBeDisabled();
  await review
    .getByRole("button", { name: "Add criterion", exact: true })
    .click();
  await review
    .getByRole("textbox", { name: "Criterion 1", exact: true })
    .fill("TypeScript project experience");
  await review
    .getByRole("button", { name: "Approve criteria for this job" })
    .click();
  await expect(
    review.getByText("Approved criteria · revision 1"),
  ).toBeVisible();
  await page.reload();
  await expect(
    review.getByRole("textbox", { name: "Criterion 1", exact: true }),
  ).toHaveValue("TypeScript project experience");
  await expect(
    review.getByRole("button", { name: "Analyze selected evidence" }),
  ).toBeDisabled();
  const app = await (
    await page.request.get(`/api/applications/${application.id}`)
  ).json();
  expect(app.item.status).toBe("in_review");
});

test("mocked grounded review requires criteria approval, source consent, and preserves private reviewer notes", async ({
  page,
  baseURL,
}) => {
  const { job, application, note } = await seed(page, baseURL!);
  const criterion = {
    id: randomUUID(),
    text: "TypeScript project experience",
    importance: "required",
  };
  let saved: Record<string, any> | null = null,
    submitted: Record<string, unknown> | null = null;
  await page.route(`**/api/jobs/${job.id}/review-criteria/draft`, (route) =>
    route.fulfill({
      json: {
        item: {
          id: randomUUID(),
          status: "complete",
          output: { criteria: [criterion] },
        },
      },
    }),
  );
  await page.route(
    `**/api/applications/${application.id}/review-assistance`,
    async (route) => {
      if (route.request().method() === "GET") {
        const response = await route.fetch(),
          data = await response.json();
        await route.fulfill({
          json: {
            ...data,
            setup: { enabled: true },
            items: saved ? [saved] : [],
          },
        });
      } else {
        submitted = route.request().postDataJSON();
        saved = {
          id: randomUUID(),
          status: "complete",
          createdAt: new Date().toISOString(),
          notes: "",
          reviewedAt: null,
          output: {
            provider: "test",
            model: "fixture",
            approvedCriteria: [criterion],
            sources: [
              {
                id: `conversation:${note.id}`,
                title: note.title,
                text: note.transcript,
              },
            ],
            criteria: [
              {
                criterionId: criterion.id,
                evidence: [
                  {
                    sourceId: `conversation:${note.id}`,
                    quote: "I built TypeScript applications.",
                  },
                ],
                missingInformation: "The project scope is not established.",
                followUp: "What was the scope of this project?",
              },
            ],
          },
        };
        await route.fulfill({ status: 201, json: { item: saved } });
      }
    },
  );
  await page.route(
    `**/api/applications/${application.id}/review-assistance/*`,
    async (route) => {
      const data = route.request().postDataJSON();
      saved = {
        ...saved!,
        notes: data.notes,
        reviewedAt: data.reviewed ? new Date().toISOString() : null,
      };
      await route.fulfill({ json: { item: saved } });
    },
  );
  await page.goto("/app/applications");
  const review = page.getByRole("region", {
    name: "Application evidence review",
  });
  await review.getByRole("button", { name: "Draft criteria with AI" }).click();
  await expect(
    review.getByRole("textbox", { name: "Criterion 1", exact: true }),
  ).toHaveValue(criterion.text);
  await expect(
    review.getByText(
      "Unsaved draft — approve these criteria before analyzing.",
    ),
  ).toBeVisible();
  await expect(
    review.getByRole("button", { name: "Analyze selected evidence" }),
  ).toBeDisabled();
  await review
    .getByRole("button", { name: "Approve criteria for this job" })
    .click();
  await expect(
    review.getByText("Approved criteria · revision 1"),
  ).toBeVisible();
  await review
    .getByRole("checkbox", {
      name: "Verified technical interview",
      exact: false,
    })
    .check();
  await expect(
    review.getByRole("button", { name: "Analyze selected evidence" }),
  ).toBeDisabled();
  await review
    .getByRole("checkbox", {
      name: "I verified these sources belong to this application",
      exact: false,
    })
    .check();
  await review
    .getByRole("button", { name: "Analyze selected evidence" })
    .click();
  await expect(
    review.getByText("I built TypeScript applications.", { exact: true }),
  ).toBeVisible();
  expect(submitted).toMatchObject({
    criteriaRevision: 1,
    conversationIds: [note.id],
    consent: true,
  });
  await review
    .getByText(`Inspect source: ${note.title}`, { exact: true })
    .click();
  await expect(
    review.locator("pre").filter({ hasText: note.transcript }),
  ).toBeVisible();
  await review
    .getByRole("textbox", { name: "Your private reviewer notes", exact: true })
    .fill("Ask about project scope at the next interview.");
  await review
    .getByRole("checkbox", {
      name: "I inspected every criterion",
      exact: false,
    })
    .check();
  await review
    .getByRole("button", { name: "Save private review notes" })
    .click();
  await expect(review.getByRole("status")).toContainText(
    "Your private review notes were saved.",
  );
  await page.reload();
  await expect(
    review.getByRole("textbox", {
      name: "Your private reviewer notes",
      exact: true,
    }),
  ).toHaveValue("Ask about project scope at the next interview.");
  await expect(
    review.getByRole("checkbox", {
      name: "I inspected every criterion",
      exact: false,
    }),
  ).toBeChecked();
  const app = await (
    await page.request.get(`/api/applications/${application.id}`)
  ).json();
  expect(app.item.status).toBe("in_review");
  expect(app.item.notes || "").toBe("");
});
