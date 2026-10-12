import { test, expect } from "./fixtures";
const transcript =
  "Interviewer: What have you built recently?\nRiley: I built a TypeScript recruiting dashboard and integrated a calendar service.\nInterviewer: What are you looking for next?\nRiley: I want to work on accessible products with a small collaborative team.\nInterviewer: When can you join?\nRiley: I can start in four weeks.\nInterviewer: We will arrange a design interview next week.";
async function signUp(page: any) {
  await page.goto("/signup");
  await page.getByLabel("Your name", { exact: true }).fill("Workspace Tester");
  await page
    .getByLabel("Workspace name", { exact: true })
    .fill("Test workspace");
  await page
    .getByLabel("Work email")
    .fill(
      `workspace-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    );
  await page
    .getByLabel("Password", { exact: true })
    .fill("Strong-test-password-47");
  await page
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "My conversations", exact: true }),
  ).toBeVisible();
}
test("signup, transcript summary, editing, versions, sharing, collection and archive persist", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signUp(page);
  await page.screenshot({
    path: "test-results/notes-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Upload conversation", exact: true })
    .first()
    .click();
  await page
    .getByLabel("Conversation title", { exact: true })
    .fill("Riley interview");
  await page.getByLabel("Candidate", { exact: true }).fill("Riley");
  await page.getByLabel("Transcript", { exact: true }).fill(transcript);
  await page
    .getByRole("button", { name: "Save conversation", exact: true })
    .click();
  await expect(
    page.getByLabel("Conversation title", { exact: true }),
  ).toHaveValue("Riley interview");
  await expect(
    page.getByRole("button", { name: "Add section", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add section", exact: true }).click();
  const titles = page.getByRole("textbox", { name: /Section \d+ title/ });
  await titles.last().fill("Follow-up");
  await titles.last().blur();
  await page
    .getByLabel("Follow-up notes", { exact: true })
    .fill("Send the interview brief tomorrow.");
  await page.getByLabel("Follow-up notes", { exact: true }).blur();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Follow-up notes", { exact: true })).toHaveValue(
    "Send the interview brief tomorrow.",
  );
  await page
    .getByRole("button", { name: "Ask AI", exact: true })
    .first()
    .click();
  await page
    .getByRole("textbox", { name: "Ask about this conversation" })
    .fill("When can Riley start?");
  await page.getByRole("button", { name: "Send question" }).click();
  await expect(page.locator(".chat-message.assistant")).toContainText(
    "four weeks",
  );
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  await page
    .getByRole("button", { name: "Share & export", exact: true })
    .click();
  await page.getByRole("button", { name: "Create 7-day share link" }).click();
  const shareURL = await page
    .getByLabel("Your share link (copy before closing)")
    .inputValue();
  const reader = await context.newPage();
  await reader.goto(shareURL);
  await expect(
    reader.getByRole("heading", { name: "Riley interview" }),
  ).toBeVisible();
  await expect(
    reader.getByText("Send the interview brief tomorrow."),
  ).toBeVisible();
  await reader.close();
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  const revoked = await context.request.get(
    new URL(shareURL).pathname.replace("/shared/", "/api/shared/"),
  );
  expect(revoked.status()).toBe(404);
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page
    .getByRole("button", { name: "Version history", exact: true })
    .last()
    .click();
  await expect(
    page.getByRole("button", { name: "Restore", exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("link", { name: "Back to conversations" }).click();
  await page
    .getByRole("button", { name: "New collection", exact: true })
    .click();
  await page.getByLabel("Collection name").fill("Design interviews");
  await page
    .getByRole("button", { name: "Create collection", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Design interviews", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "My conversations", exact: true })
    .click();
  await page.getByRole("link").filter({ hasText: "Riley interview" }).click();
  await page
    .getByRole("button", { name: "Add to collection", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("checkbox")
    .filter({ visible: true })
    .last()
    .check();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page
    .getByRole("button", { name: "Archive conversation", exact: true })
    .click();
  await page.getByRole("link", { name: "Back to conversations" }).click();
  await expect(
    page.getByRole("link").filter({ hasText: "Riley interview" }),
  ).toHaveCount(0);
  await page.getByRole("switch", { name: "Show archive" }).check();
  await expect(
    page.getByRole("link").filter({ hasText: "Riley interview" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test("template create, edit and duplicate persist; settings save", async ({
  page,
}) => {
  await signUp(page);
  await page.getByRole("link", { name: "Templates", exact: true }).click();
  await page
    .getByRole("button", { name: "New template", exact: true })
    .first()
    .click();
  await page.getByLabel("Template name").fill("Engineering intake");
  await page
    .getByLabel("Description", { exact: true })
    .fill("Capture role context.");
  await page
    .getByRole("button", { name: "Create template", exact: true })
    .click();
  await page.getByLabel("Section title").fill("Role requirements");
  await page
    .getByLabel("Instructions")
    .fill("Extract the skills and responsibilities mentioned explicitly.");
  let releaseSave!: () => void;
  const delayedSave = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route("**/api/templates/*", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const response = await route.fetch();
    await delayedSave;
    await route.fulfill({ response });
  });
  await page
    .getByRole("button", { name: "Save template", exact: true })
    .click();
  try {
    await expect(page.getByLabel("Instructions")).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Engineering intake", exact: true }),
    ).toBeDisabled();
  } finally {
    releaseSave();
  }
  await expect(page.getByRole("status")).toContainText("Template saved");
  await page.unroute("**/api/templates/*");
  await page.reload();
  await page
    .getByRole("button", { name: "Engineering intake", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Role requirements" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Duplicate template" }).click();
  await expect(
    page.getByRole("textbox", { name: "Template name" }),
  ).toHaveValue("Engineering intake (copy)");
  await page.goto("/app/settings");
  await page.getByLabel("Your name", { exact: true }).fill("Updated Tester");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.reload();
  await expect(page.getByLabel("Your name", { exact: true })).toHaveValue(
    "Updated Tester",
  );
});
test("public navigation and mobile workspace stay usable", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.screenshot({
    path: "test-results/marketing-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: "test-results/marketing-mobile.png",
    fullPage: true,
  });
  await signUp(page);
  await expect(
    page.getByRole("button", { name: "Toggle navigation" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await page.getByRole("link", { name: "Templates", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "New template", exact: true }).first(),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await expect(page.locator(".workspace")).not.toHaveClass(/mobile-open/);
  await page.screenshot({
    path: "test-results/workspace-mobile.png",
    fullPage: true,
  });
});

test("generation failures preserve a saved conversation and settings tabs keep separate values", async ({
  page,
}) => {
  await signUp(page);
  await page.goto("/app/settings");
  await page
    .getByLabel("Your name", { exact: true })
    .fill("Unsaved personal name");
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(page.getByLabel("Workspace name", { exact: true })).toHaveValue(
    "Test workspace",
  );
  await page.getByLabel("Default note format").selectOption("Paragraphs");
  await page.getByLabel("Default note length").selectOption("concise");
  await page.getByRole("button", { name: "Save workspace settings" }).click();
  await expect(page.getByRole("status")).toContainText("Settings saved");
  await page.getByRole("button", { name: "Personal", exact: true }).click();
  await expect(page.getByLabel("Your name", { exact: true })).toHaveValue(
    "Workspace Tester",
  );
  await page.goto("/notes");
  await page.route("**/api/conversations/*/generate", (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({
        error: "Test provider unavailable. Your existing notes were preserved.",
      }),
    }),
  );
  await page
    .getByRole("button", { name: "Upload conversation", exact: true })
    .first()
    .click();
  await page
    .getByLabel("Conversation title", { exact: true })
    .fill("Saved despite provider failure");
  await page.getByLabel("Transcript", { exact: true }).fill(transcript);
  await page
    .getByRole("button", { name: "Save conversation", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByLabel("Conversation title", { exact: true }),
  ).toHaveValue("Saved despite provider failure");
  await expect(page.getByLabel("Note format")).toHaveValue("paragraphs");
  await expect(page.getByLabel("Note length")).toHaveValue("concise");
  const list = await (await page.request.get("/api/conversations")).json();
  expect(
    list.items.filter(
      (item: any) => item.title === "Saved despite provider failure",
    ),
  ).toHaveLength(1);
  await page.unroute("**/api/conversations/*/generate");
  await page.getByRole("button", { name: "Regenerate", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Add section", exact: true }),
  ).toBeVisible();
  const content = await page
    .locator(".note-section textarea")
    .first()
    .inputValue();
  await page.getByLabel("Translate notes").selectOption("French");
  await page.getByRole("button", { name: "Regenerate", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("require an AI provider");
  await expect(page.locator(".note-section textarea").first()).toHaveValue(
    content,
  );
});

test("late microphone permission cannot start recording after the dialog closes", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = window as any;
    state.testMicrophoneStopped = false;
    navigator.mediaDevices.getUserMedia = () =>
      new Promise((resolve) => {
        state.resolveTestMicrophone = () =>
          resolve({
            getTracks: () => [
              {
                stop: () => {
                  state.testMicrophoneStopped = true;
                },
              },
            ],
          } as unknown as MediaStream);
      });
  });
  await signUp(page);
  await page
    .getByRole("button", { name: "Upload conversation", exact: true })
    .first()
    .click();
  await page.getByRole("tab", { name: "Record", exact: true }).click();
  await page
    .getByRole("button", { name: "Start recording", exact: true })
    .click();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.evaluate(() => (window as any).resolveTestMicrophone());
  await expect
    .poll(() => page.evaluate(() => (window as any).testMicrophoneStopped))
    .toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
