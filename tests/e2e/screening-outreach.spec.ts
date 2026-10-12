import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { newScreeningConfig } from "../../shared/screening";
async function setup(page: Page, baseURL: string | undefined) {
  const origin = new URL(baseURL!).origin;
  const signup = await page.request.post("/api/auth/signup", {
    headers: { Origin: origin },
    data: {
      name: "Outreach Reviewer",
      email: `screen-outreach-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: "ScreenOutreach987!",
      workspaceName: "Example Hiring",
      seedDemo: false,
    },
  });
  expect(signup.ok(), await signup.text()).toBeTruthy();
  const config = newScreeningConfig();
  config.sections[0].questions = [
    {
      id: crypto.randomUUID(),
      prompt: "Describe your professional experience.",
      type: "text",
      options: [],
      required: true,
      rubric: "Private reviewer notes",
      followUp: false,
    },
  ];
  const created = await page.request.post("/api/screening-workspaces", {
    headers: { Origin: origin },
    data: {
      title: "Engineering invitation test",
      description: "Share professional experience.",
      jobId: "",
      screeningConfig: config,
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  return { item: (await created.json()).item, origin };
}

test("screening owner reviews personalized recipients, queues private invitations, inspects outbox and cancels", async ({
  page,
  baseURL,
}, testInfo) => {
  const { item } = await setup(page, baseURL);
  await page.goto(`/app/screening/${item.id}`);
  await page.getByRole("tab", { name: "Outreach", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Invitations & reminders" }),
  ).toBeVisible();
  await expect(
    page.getByText("Local outbox — no email is delivered", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Additional recipients", { exact: true })
    .fill(
      "Alex Example <alex@example.test>\nTaylor Example <taylor@example.test>",
    );
  await page
    .getByLabel("Invitation subject", { exact: true })
    .fill("{{candidate_first_name}}, engineering screening invitation");
  await page
    .getByRole("button", { name: "Review invitations", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("2 recipients", { exact: true })).toBeVisible();
  await expect(
    dialog.getByRole("heading", {
      name: "Alex, engineering screening invitation",
    }),
  ).toBeVisible();
  await dialog
    .getByLabel("Review recipient", { exact: true })
    .selectOption("1");
  await expect(
    dialog.getByRole("heading", {
      name: "Taylor, engineering screening invitation",
    }),
  ).toBeVisible();
  const queue = dialog.getByRole("button", {
    name: "Queue in local outbox",
    exact: true,
  });
  await expect(queue).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await queue.click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Screening invitations and reminders" })
      .getByRole("status"),
  ).toContainText("2 invitations queued for the local outbox");
  const history = page.getByRole("table");
  await expect(history.getByRole("row")).toHaveCount(3);
  await page.screenshot({
    path: testInfo.outputPath("screening-invitation-history.png"),
    fullPage: true,
  });
  const alex = history
    .getByRole("row")
    .filter({ hasText: "alex@example.test" });
  await alex.getByRole("button", { name: "View message", exact: true }).click();
  await expect(
    page
      .getByRole("dialog")
      .getByText("To: alex@example.test", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog").locator("pre")).toContainText(
    "/interviews/",
  );
  await expect(page.getByRole("dialog").locator("pre")).toContainText(
    "/api/screening-outreach/unsubscribe/",
  );
  await page.getByRole("dialog").getByLabel("Close dialog").click();
  await alex
    .getByRole("button", { name: "Cancel invitation", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm cancellation", exact: true })
    .click();
  await expect(alex).toContainText("cancelled");
  await expect(
    alex.getByRole("button", { name: "Cancel invitation", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await page.getByRole("tab", { name: "Outreach", exact: true }).click();
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(3);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "Invitations & reminders" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: testInfo.outputPath("screening-outreach-mobile.png"),
    fullPage: true,
  });
});

test("screening invitation preview rejects changed drafts without silently sending and preserves composer", async ({
  page,
  baseURL,
}) => {
  const { item, origin } = await setup(page, baseURL);
  await page.goto(`/app/screening/${item.id}`);
  await page.getByRole("tab", { name: "Outreach", exact: true }).click();
  await page
    .getByLabel("Additional recipients", { exact: true })
    .fill("Review Person <review@example.test>");
  await page
    .getByRole("button", { name: "Review invitations", exact: true })
    .click();
  const changed = await page.request.patch(
    `/api/screening-workspaces/${item.id}`,
    {
      headers: { Origin: origin },
      data: {
        title: "Changed by collaborator",
        description: item.description,
        jobId: "",
        screeningConfig: item.screeningConfig,
        revision: item.updatedAt,
      },
    },
  );
  expect(changed.ok(), await changed.text()).toBeTruthy();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox").check();
  await dialog
    .getByRole("button", { name: "Queue in local outbox", exact: true })
    .click();
  await expect(dialog).toContainText("The screening changed after the preview");
  await dialog.getByLabel("Close dialog").click();
  await expect(
    page.getByLabel("Additional recipients", { exact: true }),
  ).toHaveValue("Review Person <review@example.test>");
  await expect(
    page.getByText("No invitations queued yet.", { exact: true }),
  ).toBeVisible();
  const response = await page.request.get(
    `/api/screenings/${item.id}/outreach`,
  );
  expect((await response.json()).items).toHaveLength(0);
  await page
    .getByRole("button", { name: "Discard invitation edits", exact: true })
    .click();
  await expect(
    page.getByLabel("Additional recipients", { exact: true }),
  ).toHaveValue("");
});
