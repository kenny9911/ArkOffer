import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
async function signup(page: Page, baseURL: string | undefined) {
  const response = await page.request.post("/api/auth/signup", {
    headers: { Origin: new URL(baseURL!).origin },
    data: {
      name: "Sequence Tester",
      email: `sequence-${Date.now()}-${Math.random()}@example.com`,
      password: "SequenceTests987!",
      workspaceName: "Synthetic sequences",
      seedDemo: false,
    },
  });
  expect(response.ok()).toBeTruthy();
}

test("sequence editor persists manual channels and schedule settings, previews personalization, and fits mobile", async ({
  page,
  baseURL,
}) => {
  await signup(page, baseURL);
  await page.goto("/app/sequences/new");
  await expect(
    page.getByRole("heading", { name: "Ready to engage your candidates?" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Generate sequence draft" }),
  ).toBeDisabled();
  if (process.env.ARKOFFER_CAPTURE_REVIEW === "1") {
    const viewport = page.viewportSize()!;
    await page.setViewportSize({ width: 1664, height: 1490 });
    await page.screenshot({
      path: "/tmp/arkoffer-final-sequence.png",
      fullPage: true,
    });
    await page.setViewportSize(viewport);
  }
  await page.getByLabel("Sequence title").fill("Engineering connection");
  await page.getByLabel("Step 1 type").selectOption("linkedin_connection");
  await page
    .getByLabel("Step 1 subject", { exact: true })
    .fill("Connect with an engineer");
  await page.getByLabel("Step 1 body", { exact: true }).fill("Hello ");
  await page
    .getByRole("button", { name: "Candidate first name", exact: true })
    .click();
  await expect(page.getByLabel("Step 1 body", { exact: true })).toHaveValue(
    "Hello {{firstName}}",
  );
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(
    page.getByText("Hello [Candidate first name]", { exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  await page.getByLabel("Time zone").fill("Asia/Singapore");
  await page.getByLabel("Start hour").fill("10");
  await page.getByLabel("End hour").fill("16");
  await page
    .getByRole("button", { name: "Save sequence", exact: true })
    .click();
  await expect(page).toHaveURL(/\/app\/sequences\/[a-f0-9-]+$/);
  await page.reload();
  await expect(page.getByLabel("Step 1 type")).toHaveValue(
    "linkedin_connection",
  );
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  await expect(page.getByLabel("Time zone")).toHaveValue("Asia/Singapore");
  await expect(page.getByLabel("Start hour")).toHaveValue("10");
  const sequences = (await (await page.request.get("/api/sequences")).json())
    .items;
  expect(sequences[0].settings).toMatchObject({
    timezone: "Asia/Singapore",
    startHour: 10,
    endHour: 16,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: "Steps", exact: true }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
});

test("agent suggestions require explicit apply and save; edits made during generation block replacement", async ({
  page,
  baseURL,
}) => {
  await signup(page, baseURL);
  await page.route("**/api/sequence-workspace", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ json: { ...data, aiAvailable: true } });
  });
  let resolveGeneration: (() => void) | undefined;
  const proposal = {
    id: "df11d014-d199-4972-aa0f-92e38522e9d1",
    status: "ready",
    sourceCurrent: true,
    error: null,
    createdAt: Date.now(),
    result: {
      name: "Agent outreach",
      description: "A synthetic draft",
      steps: [
        {
          kind: "linkedin_message",
          subject: "",
          body: "Hello {{firstName}}",
          delayDays: 0,
        },
        {
          kind: "email",
          subject: "Follow up",
          body: "Would you like to learn more?",
          delayDays: 3,
        },
      ],
      notes: ["Confirm details before launch."],
    },
  };
  await page.route("**/api/sequence-drafts", async (route) => {
    if (route.request().method() === "POST") {
      await new Promise<void>((resolve) => {
        resolveGeneration = resolve;
      });
      await route.fulfill({ json: { item: proposal }, status: 201 });
    } else await route.fulfill({ json: { available: true, items: [] } });
  });
  await page.goto("/app/sequences/new");
  await page.getByLabel("Sequence title").fill("Initial outreach");
  await page
    .getByLabel("Sequence agent instructions")
    .fill("Start with LinkedIn, then follow up by email.");
  await page.getByRole("button", { name: "Generate sequence draft" }).click();
  await expect.poll(() => !!resolveGeneration).toBeTruthy();
  await page
    .getByLabel("Step 1 body", { exact: true })
    .fill("Keep this human edit");
  resolveGeneration!();
  await expect(
    page.getByRole("button", { name: "Apply draft to editor" }),
  ).toBeDisabled();
  await expect(page.getByLabel("Step 1 body", { exact: true })).toHaveValue(
    "Keep this human edit",
  );
  resolveGeneration = undefined;
  await page.getByRole("button", { name: "Generate sequence draft" }).click();
  await expect.poll(() => !!resolveGeneration).toBeTruthy();
  resolveGeneration!();
  await expect(
    page.getByRole("button", { name: "Apply draft to editor" }),
  ).toBeEnabled();
  expect(
    (await (await page.request.get("/api/sequences")).json()).items,
  ).toHaveLength(0);
  await page.getByRole("button", { name: "Apply draft to editor" }).click();
  await expect(page.getByLabel("Step 1 type")).toHaveValue("linkedin_message");
  await expect(page.getByLabel("Step 1 subject", { exact: true })).toHaveValue(
    "",
  );
  await expect(
    page.getByText("Task title (optional)", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Step 2 body", { exact: true })).toHaveValue(
    "Would you like to learn more?",
  );
  expect(
    (await (await page.request.get("/api/sequences")).json()).items,
  ).toHaveLength(0);
  await page
    .getByRole("button", { name: "Save sequence", exact: true })
    .click();
  await expect(page).toHaveURL(/\/app\/sequences\/[a-f0-9-]+$/);
  await page.reload();
  await expect(page.getByLabel("Sequence title")).toHaveValue("Agent outreach");
});

test("formatted sequence body and Cc/Bcc persist, preview safely, and appear in delivery approval", async ({
  page,
  baseURL,
}) => {
  await signup(page, baseURL);
  const headers = { Origin: new URL(baseURL!).origin };
  const created = await page.request.post("/api/candidates", {
    headers,
    data: { name: "Alex Example", email: "alex@example.com" },
  });
  expect(created.ok()).toBeTruthy();
  await page.goto("/app/sequences/new");
  await expect(page.getByText("Unsaved draft", { exact: true })).toBeVisible();
  await page.getByLabel("Sequence title").fill("Formatted outreach");
  await page
    .getByLabel("Step 1 subject", { exact: true })
    .fill("An introduction");
  const body = page.getByLabel("Step 1 body", { exact: true });
  await body.fill("Hello {{firstName}}");
  // Reproduce a delayed animation frame arriving after the next keyboard action.
  // Formatting must restore selection in its commit, without overwriting that action.
  await page.evaluate(() => {
    const original = window.requestAnimationFrame;
    const callbacks: FrameRequestCallback[] = [];
    window.requestAnimationFrame = (callback) => {
      callbacks.push(callback);
      return -callbacks.length;
    };
    window.addEventListener(
      "release-sequence-test-frames",
      () => {
        window.requestAnimationFrame = original;
        for (const callback of callbacks) callback(performance.now());
      },
      { once: true },
    );
  });
  await body.press("ControlOrMeta+A");
  await page.getByRole("button", { name: "Bold step 1 selection" }).click();
  await expect(body).toHaveValue("**Hello {{firstName}}**");
  await body.press("ArrowRight");
  await page.evaluate(() =>
    window.dispatchEvent(new Event("release-sequence-test-frames")),
  );
  await page.getByRole("button", { name: "Add link to step 1" }).click();
  const link = page.getByRole("dialog", { name: "Insert secure link" });
  await link.getByLabel("Link text").fill("Read the role");
  await link.getByLabel("HTTPS address").fill("javascript:alert(1)");
  await expect(
    link.getByRole("button", { name: "Insert link", exact: true }),
  ).toBeDisabled();
  await link.getByLabel("HTTPS address").fill("https://example.com/role");
  await link.getByRole("button", { name: "Insert link", exact: true }).click();
  await expect(body).toHaveValue(
    "**Hello {{firstName}}**[Read the role](https://example.com/role)",
  );
  await page.getByLabel("Step 1 Cc", { exact: true }).fill("team@example.com");
  await page
    .getByLabel("Step 1 Bcc", { exact: true })
    .fill("private@example.com");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page
    .getByLabel("Preview as candidate")
    .selectOption({ label: "Alex Example" });
  await expect(page.locator(".sequence-formatted-preview strong")).toHaveText(
    "Hello Alex",
  );
  await expect(
    page.getByRole("link", { name: "Read the role" }),
  ).toHaveAttribute("href", "https://example.com/role");
  await page
    .getByRole("button", { name: "Candidates (0)", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: "Alex Example alex@example.com" })
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
  await expect(page.getByLabel("Step 1 Cc", { exact: true })).toHaveValue(
    "team@example.com",
  );
  await expect(page.getByLabel("Step 1 Bcc", { exact: true })).toHaveValue(
    "private@example.com",
  );
  await expect(page.getByLabel("Step 1 message format")).toHaveValue(
    "formatted",
  );
  await page
    .getByRole("button", { name: "Review delivery", exact: true })
    .click();
  const delivery = page.getByRole("dialog");
  await delivery.getByText("Alex Example", { exact: true }).click();
  await expect(delivery).toContainText("3 distinct addresses including copies");
  await expect(delivery).toContainText("team@example.com");
  await expect(delivery).toContainText("private@example.com");
  await expect(
    delivery.getByRole("button", {
      name: "Queue in local outbox",
      exact: true,
    }),
  ).toBeDisabled();
  // This test stops at the review screen; it never launches or contacts anyone.
  await delivery.getByRole("button", { name: "Close dialog" }).click();
  await page.getByLabel("Step 1 type").selectOption("linkedin_message");
  await page
    .getByRole("button", { name: "Save sequence", exact: true })
    .click();
  await expect(
    page.getByText("Sequence saved. Nothing has been sent.", { exact: true }),
  ).toBeVisible();
  const sequences = (await (await page.request.get("/api/sequences")).json())
    .items;
  expect(sequences[0].steps[0].cc).toEqual([]);
  expect(sequences[0].steps[0].bcc).toEqual([]);
});
