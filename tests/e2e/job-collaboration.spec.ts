import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

async function fixture(page: Page, baseURL: string | undefined) {
  const headers = { Origin: new URL(baseURL!).origin };
  const account = await page.request.post("/api/auth/signup", {
    headers,
    data: {
      name: "Job Review Tester",
      email: `jobreview-${crypto.randomUUID()}@example.test`,
      password: "JobReviewTests987!",
      workspaceName: "Synthetic job discussion",
      seedDemo: false,
    },
  });
  expect(account.ok(), await account.text()).toBeTruthy();
  const response = await page.request.post("/api/jobs", {
    headers,
    data: {
      title: "Platform engineering role",
      description: "Build reliable APIs with the platform team.",
      status: "draft",
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const job = (await response.json()).item;
  await page.goto("/app/job-posts");
  await page.getByRole("button", { name: job.title, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Job post preview" });
  const discussion = dialog.getByRole("region", { name: "Job collaboration" });
  await expect(
    discussion.getByRole("button", { name: "Mark as reviewed", exact: true }),
  ).toBeEnabled();
  return { headers, job, dialog, discussion };
}

test("workspace job comments and human review checks persist, with old checks invalidated by job edits", async ({
  page,
  baseURL,
}) => {
  const { headers, job, dialog, discussion } = await fixture(page, baseURL);
  await discussion
    .getByRole("button", { name: "Mark as reviewed", exact: true })
    .click();
  await expect(discussion).toContainText("1 person has reviewed this version");
  await discussion
    .getByLabel("Add a comment", { exact: true })
    .fill("Please confirm the on-call rotation.");
  await discussion
    .getByRole("button", { name: "Post comment", exact: true })
    .click();
  const comments = discussion.getByRole("list", { name: "Job comments" });
  await expect(comments).toContainText("Job Review Tester (you)");
  await expect(comments).toContainText("Please confirm the on-call rotation.");
  await comments
    .getByRole("button", { name: "Edit comment", exact: true })
    .click();
  await comments
    .getByLabel("Edit comment", { exact: true })
    .fill("The rotation is confirmed.");
  await comments
    .getByRole("button", { name: "Cancel edit", exact: true })
    .click();
  await expect(comments).toContainText("Please confirm the on-call rotation.");
  await expect(comments).not.toContainText("The rotation is confirmed.");
  await comments
    .getByRole("button", { name: "Edit comment", exact: true })
    .click();
  await comments
    .getByLabel("Edit comment", { exact: true })
    .fill("The rotation is confirmed.");
  await comments
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  await expect(comments).toContainText("The rotation is confirmed.");
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  const row = page.locator(".business-job-row").filter({ hasText: job.title });
  await expect(row).toContainText("1 comment");
  await expect(row).toContainText("1 reviewed");
  const updated = await page.request.patch(`/api/jobs/${job.id}`, {
    headers,
    data: {
      ...job,
      description: "Build reliable APIs. Join the confirmed on-call rotation.",
    },
  });
  expect(updated.ok(), await updated.text()).toBeTruthy();
  await page.reload();
  await expect(row).toContainText("0 reviewed");
  await page.getByRole("button", { name: job.title, exact: true }).click();
  await expect(
    discussion.getByRole("list", { name: "Reviewer status" }),
  ).toContainText("Needs review after changes");
  await discussion.getByText("Review history (1)", { exact: true }).click();
  await expect(discussion).toContainText("earlier version");
  await discussion
    .getByRole("button", { name: "Mark as reviewed", exact: true })
    .click();
  await expect(discussion).toContainText("1 person has reviewed this version");
  await discussion
    .getByRole("button", { name: "Withdraw my review", exact: true })
    .click();
  await expect(discussion).toContainText("0 people have reviewed this version");
  await comments
    .getByRole("button", { name: "Delete comment", exact: true })
    .click();
  await comments
    .getByRole("button", { name: "Confirm delete", exact: true })
    .click();
  await expect(discussion).toContainText(
    "No comments yet. Start the discussion.",
  );
  await expect(discussion).toContainText("Review history (3)");
});

test("stale comment edits preserve user text and stale job previews cannot acquire a new review check", async ({
  page,
  baseURL,
}) => {
  const { headers, job, discussion } = await fixture(page, baseURL);
  await discussion
    .getByLabel("Add a comment", { exact: true })
    .fill("Initial feedback");
  await discussion
    .getByRole("button", { name: "Post comment", exact: true })
    .click();
  const comments = discussion.getByRole("list", { name: "Job comments" });
  await comments
    .getByRole("button", { name: "Edit comment", exact: true })
    .click();
  await comments
    .getByLabel("Edit comment", { exact: true })
    .fill("My unsaved review text");
  const data = await (
    await page.request.get(`/api/jobs/${job.id}/collaboration`)
  ).json();
  const concurrent = await page.request.patch(
    `/api/jobs/${job.id}/comments/${data.comments[0].id}`,
    { headers, data: { body: "Changed in another tab", revision: 1 } },
  );
  expect(concurrent.ok()).toBeTruthy();
  await comments
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  await expect(discussion).toContainText(
    "This comment changed. Refresh the discussion before editing it.",
  );
  await expect(
    comments.getByLabel("Edit comment", { exact: true }),
  ).toHaveValue("My unsaved review text");
  await comments
    .getByRole("button", { name: "Cancel edit", exact: true })
    .click();
  await discussion
    .getByRole("button", { name: "Refresh job discussion", exact: true })
    .click();
  await expect(comments).toContainText("Changed in another tab");
  const updated = await page.request.patch(`/api/jobs/${job.id}`, {
    headers,
    data: { ...job, salary: "A newly confirmed salary range" },
  });
  expect(updated.ok()).toBeTruthy();
  await discussion
    .getByRole("button", { name: "Mark as reviewed", exact: true })
    .click();
  await expect(discussion).toContainText(
    "This job changed. Reopen its latest preview before marking it reviewed.",
  );
  await discussion
    .getByRole("button", { name: "Refresh job discussion", exact: true })
    .click();
  await expect(discussion).toContainText(
    "This job changed since you opened the preview.",
  );
  await expect(
    discussion.getByRole("button", { name: "Mark as reviewed", exact: true }),
  ).toBeDisabled();
  const final = await (
    await page.request.get(`/api/jobs/${job.id}/collaboration`)
  ).json();
  expect(final.reviewedCount).toBe(0);
  expect(final.comments[0].body).toBe("Changed in another tab");
});

test("acknowledged job comment changes close editors even when the discussion refresh fails", async ({
  page,
  baseURL,
}) => {
  const { job, discussion } = await fixture(page, baseURL);
  let failNextRead = false;
  await page.route(`**/api/jobs/${job.id}/collaboration`, async (route) => {
    if (failNextRead) {
      failNextRead = false;
      await route.fulfill({
        status: 503,
        json: { error: "Temporary read failure" },
      });
    } else await route.continue();
  });
  const savedNotice =
    "Your change was saved, but the discussion could not be refreshed.";
  const read = async () =>
    await (await page.request.get(`/api/jobs/${job.id}/collaboration`)).json();
  const refresh = async () =>
    discussion
      .getByRole("button", { name: "Refresh job discussion", exact: true })
      .click();
  await discussion
    .getByLabel("Add a comment", { exact: true })
    .fill("Only one saved comment");
  failNextRead = true;
  await discussion
    .getByRole("button", { name: "Post comment", exact: true })
    .click();
  await expect(discussion).toContainText(savedNotice);
  await expect(
    discussion.getByLabel("Add a comment", { exact: true }),
  ).toHaveValue("");
  await expect(
    discussion.getByRole("button", { name: "Post comment", exact: true }),
  ).toBeDisabled();
  expect((await read()).comments).toHaveLength(1);

  await refresh();
  const comments = discussion.getByRole("list", { name: "Job comments" });
  await comments
    .getByRole("button", { name: "Edit comment", exact: true })
    .click();
  await comments
    .getByLabel("Edit comment", { exact: true })
    .fill("The acknowledged edit");
  failNextRead = true;
  await comments
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  await expect(discussion).toContainText(savedNotice);
  await expect(
    comments.getByLabel("Edit comment", { exact: true }),
  ).not.toBeVisible();
  expect((await read()).comments[0].body).toBe("The acknowledged edit");

  await refresh();
  await expect(comments).toContainText("The acknowledged edit");
  await comments
    .getByRole("button", { name: "Delete comment", exact: true })
    .click();
  failNextRead = true;
  await comments
    .getByRole("button", { name: "Confirm delete", exact: true })
    .click();
  await expect(discussion).toContainText(savedNotice);
  await expect(
    comments.getByRole("button", { name: "Confirm delete", exact: true }),
  ).not.toBeVisible();
  expect((await read()).comments).toHaveLength(0);
  await refresh();
  await expect(discussion).toContainText(
    "No comments yet. Start the discussion.",
  );
});
