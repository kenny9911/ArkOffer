import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
async function signup(page: Page, baseURL: string | undefined) {
  const response = await page.request.post("/api/auth/signup", {
    headers: { Origin: new URL(baseURL!).origin },
    data: {
      name: "Screening Workspace Tester",
      email: `screen-workspace-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: "ScreeningWorkspace987!",
      workspaceName: "Synthetic screening team",
      seedDemo: false,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

test("routed screening builder persists setup, ordered sections, context and expiry through candidate publication", async ({
  page,
  baseURL,
}, testInfo) => {
  await signup(page, baseURL);
  await page.goto("/app/screening/new");
  await expect(
    page.getByRole("heading", {
      name: "Screen every candidate, without picking up the phone",
    }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("screening-new.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", {
      name: "Screen every candidate, without picking up the phone",
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: testInfo.outputPath("screening-new-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole("button", { name: "Start from scratch", exact: true })
    .click();
  await page
    .getByLabel("Screening title", { exact: true })
    .fill("Platform engineer screening");
  await page.getByRole("button", { name: "Add question", exact: true }).click();
  await page
    .getByLabel("Question text", { exact: true })
    .fill("Describe a service you maintained.");
  await page
    .getByLabel("Review rubric", { exact: true })
    .fill("Private rubric sentinel");
  await page
    .getByLabel("Allow one AI clarification", { exact: false })
    .uncheck();
  await page
    .getByRole("button", { name: "Duplicate question 1.1", exact: true })
    .click();
  await page
    .getByLabel("Question text", { exact: true })
    .nth(1)
    .fill("Describe an incident you resolved.");
  await page
    .getByRole("button", { name: "Move question 1.2 up", exact: true })
    .click();
  await expect(
    page.getByLabel("Question text", { exact: true }).first(),
  ).toHaveValue("Describe an incident you resolved.");
  await page.getByRole("button", { name: "Add section", exact: true }).click();
  await page
    .getByLabel("Section title", { exact: true })
    .nth(1)
    .fill("Motivation");
  await page
    .getByRole("button", { name: "Add question", exact: true })
    .nth(1)
    .click();
  await page
    .getByLabel("Question text", { exact: true })
    .nth(2)
    .fill("What interests you about this role?");
  await page.getByRole("tab", { name: "Setup", exact: true }).click();
  await page
    .getByLabel("Welcome message", { exact: true })
    .fill("Welcome to {{screening_title}} at {{company_name}}.");
  await page
    .getByLabel("Completion message", { exact: true })
    .fill("Thanks for your professional examples.");
  await page
    .getByLabel("Spoken prompt language", { exact: true })
    .selectOption("en-GB");
  await page.getByRole("tab", { name: "Context", exact: true }).click();
  await page
    .getByLabel("Role context", { exact: true })
    .fill("Private role context sentinel");
  await page
    .getByLabel("Company context", { exact: true })
    .fill("Private company context sentinel");
  await page
    .getByRole("button", { name: "Draft with this context", exact: true })
    .click();
  await page.getByText("Role context and options", { exact: true }).click();
  await expect(
    page.getByLabel("Additional role context", { exact: true }),
  ).toHaveValue(
    "Private role context sentinel\n\nPrivate company context sentinel",
  );
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await page.getByRole("tab", { name: "Outreach", exact: true }).click();
  await page
    .getByLabel("Candidate response deadline", { exact: true })
    .selectOption("3");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/screening\/[0-9a-f-]+\?tab=builder/);
  await page.reload();
  await expect(page.getByRole("status")).toContainText("Draft saved");
  await expect(
    page.getByLabel("Question text", { exact: true }).first(),
  ).toHaveValue("Describe an incident you resolved.");
  await page.screenshot({
    path: testInfo.outputPath("screening-builder.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("tab", { name: "Interview", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: testInfo.outputPath("screening-builder-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const publish = page.getByRole("dialog", {
    name: "Publish Platform engineer screening",
    exact: true,
  });
  await expect(publish).toContainText("Available for 3 days");
  await publish
    .getByRole("button", { name: "Create candidate link", exact: true })
    .click();
  const url = await publish
    .getByLabel("Candidate link", { exact: true })
    .inputValue();
  const data = await (
    await page.request.get(url.replace("/interviews/", "/api/interviews/"))
  ).json();
  expect(data.item.setup.language).toBe("en-GB");
  expect(data.item.questions[0].followUp).toBe(false);
  expect(JSON.stringify(data.item)).not.toMatch(/Private|rubric|goal|context/);
  expect(
    Math.abs(Date.parse(data.item.expiresAt) - Date.now() - 3 * 86400000),
  ).toBeLessThan(10000);
  await page.goto(url);
  await expect(
    page.getByText(
      "Welcome to Platform engineer screening at Synthetic screening team.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Motivation", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Full name", { exact: true })
    .fill("Synthetic Candidate");
  await page
    .getByLabel("Email address", { exact: true })
    .fill("synthetic@example.test");
  await page
    .getByLabel(/Describe an incident you resolved/)
    .fill("I restored the service and documented the cause.");
  await page
    .getByLabel(/Describe a service you maintained/)
    .fill("I maintained an API service.");
  await page
    .getByLabel(/What interests you about this role/)
    .fill("Reliable systems.");
  await page.getByLabel(/I agree to share my name/).check();
  await page
    .getByRole("button", { name: "Submit responses", exact: true })
    .click();
  await expect(
    page.getByText("Thanks for your professional examples.", { exact: true }),
  ).toBeVisible();
});

test("stale screening save keeps local edits and fails closed until the user reloads", async ({
  page,
  baseURL,
}) => {
  await signup(page, baseURL);
  await page.goto("/app/screening/new");
  await page
    .getByRole("button", { name: "Start from scratch", exact: true })
    .click();
  await page
    .getByLabel("Screening title", { exact: true })
    .fill("Original screening");
  // Creation redirects into an editor that fetches its saved revision. A
  // teammate change must happen after that fetch to exercise a stale save.
  const initialEditor = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.status() === 200 &&
      /\/api\/screening-workspaces\/[0-9a-f-]+$/.test(
        new URL(response.url()).pathname,
      ),
  );
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/screening\/[0-9a-f-]+/);
  expect((await (await initialEditor).json()).item.title).toBe(
    "Original screening",
  );
  await expect(page.getByLabel("Screening title", { exact: true })).toHaveValue(
    "Original screening",
  );
  const id = new URL(page.url()).pathname.split("/").pop();
  const original = (
    await (await page.request.get(`/api/screening-workspaces/${id}`)).json()
  ).item;
  const response = await page.request.patch(`/api/screening-workspaces/${id}`, {
    headers: { Origin: new URL(baseURL!).origin },
    data: {
      title: "Teammate changed the title",
      description: original.description,
      jobId: original.jobId,
      screeningConfig: original.screeningConfig,
      revision: original.updatedAt,
    },
  });
  expect(response.ok()).toBeTruthy();
  await page
    .getByLabel("Screening title", { exact: true })
    .fill("My local unsaved title");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "changed in another window",
  );
  await expect(page.getByLabel("Screening title", { exact: true })).toHaveValue(
    "My local unsaved title",
  );
  expect(
    (await (await page.request.get(`/api/screening-workspaces/${id}`)).json())
      .item.title,
  ).toBe("Teammate changed the title");
  page.on("dialog", (dialog) => dialog.accept());
  await page.reload();
  await expect(page.getByLabel("Screening title", { exact: true })).toHaveValue(
    "Teammate changed the title",
  );
});
