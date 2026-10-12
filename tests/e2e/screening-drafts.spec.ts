import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
async function signup(page: Page, baseURL: string | undefined) {
  const response = await page.request.post("/api/auth/signup", {
    headers: { Origin: new URL(baseURL!).origin },
    data: {
      name: "Screening Draft Tester",
      email: `screening-draft-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
      password: "ScreeningDraftTest987!",
      workspaceName: "Synthetic screening drafts",
      seedDemo: false,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

test("screening prompt drafting explains unavailable AI and keeps the manual editor accessible", async ({
  page,
  baseURL,
}) => {
  await signup(page, baseURL);
  await page.goto("/app/screening");
  await page
    .getByRole("button", { name: "Draft screening with AI", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Build a screening",
    exact: true,
  });
  await expect(dialog).toContainText(
    "Text AI is not enabled for this workspace",
  );
  await expect(
    dialog.getByRole("button", { name: "Draft screening", exact: true }),
  ).toBeDisabled();
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Create screening", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("dialog", { name: "Create screening", exact: true }),
  ).toBeVisible();
});

test("private screening proposal preserves its request through running replays and requires review before save; rubric stays private", async ({
  page,
  baseURL,
}) => {
  await signup(page, baseURL);
  const result = {
    title: "Backend engineering screen",
    description: "Tell us about your experience building services.",
    questions: [
      {
        prompt: "Describe a service you built.",
        type: "text",
        options: [],
        required: true,
        rubric: "Look for specific professional examples.",
      },
      {
        prompt: "Have you used TypeScript professionally?",
        type: "yes-no",
        options: [],
        required: true,
        rubric: "Use the response to plan the next conversation.",
      },
      {
        prompt: "Which topic would you like to discuss?",
        type: "multiple-choice",
        options: ["Reliability", "API design"],
        required: false,
        rubric: "Follow the candidate's selected topic.",
      },
    ],
    notes: ["Confirm the expected screening length."],
  };
  const draft = {
    id: "0dc38f64-fbc0-4a85-acd0-44f98ef66007",
    title: result.title,
    status: "ready",
    sourceCurrent: true,
    error: null,
    model: "synthetic-test-model",
    createdAt: new Date().toISOString(),
    result,
  };
  let generated = false,
    postCount = 0,
    requestId = "";
  await page.route("**/api/screening-drafts", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fulfill({
        json: {
          available: true,
          items: generated
            ? [
                postCount < 4
                  ? { ...draft, status: "running", result: null }
                  : draft,
              ]
            : [],
        },
      });
      return;
    }
    const input = route.request().postDataJSON();
    expect(input.consent).toBe(true);
    expect(input.questionCount).toBe(3);
    expect(input.brief).toContain("TypeScript");
    postCount++;
    if (postCount === 1) {
      requestId = input.requestId;
      await route.abort("failed");
      return;
    }
    expect(input.requestId).toBe(requestId);
    generated = true;
    await route.fulfill({
      status: postCount < 4 ? 200 : 201,
      json: {
        item:
          postCount < 4 ? { ...draft, status: "running", result: null } : draft,
        reused: postCount < 4,
      },
    });
  });
  await page.route(
    `**/api/screening-drafts/${draft.id}/apply`,
    async (route) => {
      expect(route.request().postDataJSON()).toEqual({ confirm: true });
      await route.fulfill({
        json: {
          item: {
            title: result.title,
            name: result.title,
            description: result.description,
            jobId: "",
            questions: result.questions,
            status: "draft",
          },
        },
      });
    },
  );
  await page.goto("/app/screening");
  await page
    .getByRole("button", { name: "Draft screening with AI", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Build a screening",
    exact: true,
  });
  await dialog
    .getByLabel("Describe the role", { exact: true })
    .fill(
      "Draft a role-specific screen for a backend engineer building TypeScript services.",
    );
  await dialog
    .getByLabel("Number of questions", { exact: true })
    .selectOption("3");
  const generate = dialog.getByRole("button", {
    name: "Draft screening",
    exact: true,
  });
  await expect(generate).toBeDisabled();
  await dialog.getByLabel(/Send this role brief/).check();
  await generate.click();
  await expect(dialog).toContainText(/Failed to fetch|Load failed|fetch/);
  await generate.click();
  const preview = dialog.getByRole("region", {
    name: "Screening draft preview",
  });
  await expect(preview.getByRole("status")).toContainText(
    "This request is still generating",
  );
  await generate.click();
  await expect(preview.getByRole("status")).toContainText(
    "This request is still generating",
  );
  await expect(generate).toBeEnabled();
  expect(postCount).toBe(3);
  await generate.click();
  await expect(
    preview.getByRole("heading", { name: result.title, exact: true }),
  ).toBeVisible();
  await expect(preview).toContainText(
    "Look for specific professional examples.",
  );
  expect(
    (await (await page.request.get("/api/screenings")).json()).items,
  ).toHaveLength(0);
  const useDraft = preview.getByRole("button", {
    name: "Use in screening editor",
    exact: true,
  });
  await expect(useDraft).toBeDisabled();
  await preview.getByLabel(/I reviewed the questions/).check();
  await useDraft.click();
  const editor = page.getByRole("dialog", {
    name: "Create screening",
    exact: true,
  });
  await expect(
    editor.getByLabel("Screening title", { exact: true }),
  ).toHaveValue(result.title);
  await editor
    .getByLabel("Question text", { exact: true })
    .first()
    .fill("Tell us about a production reliability improvement you led.");
  await editor
    .getByLabel("Review rubric", { exact: true })
    .first()
    .fill("Private reviewer guidance: inspect concrete project evidence.");
  await editor.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(editor).not.toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const savedEditor = page.getByRole("dialog", {
    name: "Edit screening",
    exact: true,
  });
  await expect(
    savedEditor.getByLabel("Question text", { exact: true }).first(),
  ).toHaveValue("Tell us about a production reliability improvement you led.");
  await expect(
    savedEditor.getByLabel("Review rubric", { exact: true }).first(),
  ).toHaveValue(
    "Private reviewer guidance: inspect concrete project evidence.",
  );
  await savedEditor
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const publish = page.getByRole("dialog", {
    name: `Publish ${result.title}`,
    exact: true,
  });
  await publish
    .getByRole("button", { name: "Create candidate link", exact: true })
    .click();
  const url = await publish
    .getByLabel("Candidate link", { exact: true })
    .inputValue();
  const token = new URL(url).pathname.split("/").pop();
  const response = await page.request.get(`/api/interviews/${token}`);
  expect(response.ok()).toBeTruthy();
  const candidate = await response.json();
  expect(candidate.item.questions).toHaveLength(3);
  expect(JSON.stringify(candidate)).not.toContain("rubric");
  expect(JSON.stringify(candidate)).not.toContain("Private reviewer guidance");
  expect(candidate.item.questions[0].prompt).toContain(
    "production reliability improvement",
  );
  expect(postCount).toBe(4);
});
