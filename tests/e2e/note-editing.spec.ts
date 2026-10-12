import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
const origin = "http://127.0.0.1:3412";
async function setup(page: Page) {
  const signup = await page.request.post("/api/auth/signup", {
    headers: { Origin: origin },
    data: {
      name: "Note reviewer",
      email: `note-edits-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
      password: "Local-test-password-2026",
    },
  });
  expect(signup.status()).toBe(201);
  const response = await page.request.post("/api/conversations", {
    headers: { Origin: origin },
    data: {
      title: "Alex interview",
      candidate: "Alex",
      transcript: "Alex: I shipped a product.",
      tldr: "Alex shipped a product.",
      sections: [
        {
          id: "experience",
          title: "Experience",
          content: "Alex shipped a product.",
        },
        { id: "skills", title: "Skills", content: "Alex uses TypeScript." },
      ],
    },
  });
  expect(response.status()).toBe(201);
  const item = (await response.json()).item;
  await page.goto(`/notes/${item.id}`);
  await expect(
    page.getByLabel("Experience notes", { exact: true }),
  ).toBeVisible();
  return item;
}
async function replacement(page: Page, scope?: string) {
  await page
    .getByRole("button", { name: "Edit Experience with a draft" })
    .click();
  if (scope)
    await page.getByLabel("Edit scope", { exact: true }).selectOption(scope);
  await page.getByLabel("Exact term", { exact: true }).fill("Alex");
  await page.getByLabel("Replace with", { exact: true }).fill("[redacted]");
  await page
    .getByRole("button", { name: "Create preview", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Note edit preview" }),
  ).toBeVisible();
  await expect(
    page.getByText("Preview saved. Your notes have not changed."),
  ).toBeVisible();
}
test("note preview waits for saved typing, persists through reload, applies only after review and retains version history", async ({
  page,
}) => {
  const item = await setup(page);
  await page
    .getByLabel("Experience notes", { exact: true })
    .fill("Alex shipped a product. Alex mentored two colleagues.");
  await replacement(page);
  const preview = page.getByRole("region", { name: "Note edit preview" });
  await expect(
    preview.getByText(
      "[redacted] shipped a product. [redacted] mentored two colleagues.",
      { exact: true },
    ),
  ).toBeVisible();
  const before = (
    await (await page.request.get(`/api/conversations/${item.id}`)).json()
  ).item;
  expect(before.sections[0].content).toBe(
    "Alex shipped a product. Alex mentored two colleagues.",
  );
  await page.reload();
  await page.getByRole("button", { name: "Edit drafts", exact: true }).click();
  await page
    .getByRole("region", { name: "Note edit history" })
    .getByRole("button", { name: /replace · Experience/ })
    .click();
  await page
    .getByRole("button", { name: "Apply this draft", exact: true })
    .click();
  await expect(
    page.getByText("Edit applied. The previous notes are in Version history."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(
    page.getByLabel("Experience notes", { exact: true }),
  ).toHaveValue(
    "[redacted] shipped a product. [redacted] mentored two colleagues.",
  );
  await expect(page.getByLabel("Skills notes", { exact: true })).toHaveValue(
    "Alex uses TypeScript.",
  );
  const versions = await (
    await page.request.get(`/api/conversations/${item.id}/versions`)
  ).json();
  expect(versions.items[0].data.sections[0].content).toContain(
    "Alex mentored two colleagues.",
  );
});

test("whole-note replacement discloses scope, detects a concurrent edit, and preserves it", async ({
  page,
}) => {
  const item = await setup(page);
  await replacement(page, "summary-and-transcript");
  await expect(
    page.getByText("4 fields will change in the chosen scope."),
  ).toBeVisible();
  await expect(
    page.getByText(/This is a text edit, not complete data erasure/),
  ).toBeVisible();
  const patch = await page.request.patch(`/api/conversations/${item.id}`, {
    headers: { Origin: origin },
    data: { tldr: "A colleague added a correction." },
  });
  expect(patch.ok()).toBeTruthy();
  await page
    .getByRole("button", { name: "Apply this draft", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Your edits were kept");
  await expect(
    page.getByRole("button", { name: "Apply this draft", exact: true }),
  ).toBeDisabled();
  const current = (
    await (await page.request.get(`/api/conversations/${item.id}`)).json()
  ).item;
  expect(current.tldr).toBe("A colleague added a correction.");
  expect(current.transcript).toBe(item.transcript);
  await page
    .getByRole("button", { name: "Discard draft", exact: true })
    .click();
  await expect(
    page.getByText("Draft discarded. Your notes have not changed."),
  ).toBeVisible();
});

test("literal redaction works without an AI provider and never changes metadata or retained originals", async ({
  page,
}) => {
  const item = await setup(page);
  await replacement(page, "summary-and-transcript");
  await expect(
    page.getByText(
      "AI edits are not enabled for this workspace. Exact-term replacement is available.",
    ),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Apply this draft", exact: true })
    .click();
  await expect(
    page.getByText("Edit applied. The previous notes are in Version history."),
  ).toBeVisible();
  const current = (
    await (await page.request.get(`/api/conversations/${item.id}`)).json()
  ).item;
  expect(current.transcript).toBe("[redacted]: I shipped a product.");
  expect(current.sections[0].content).toBe("[redacted] shipped a product.");
  expect(current.tldr).toBe("[redacted] shipped a product.");
  expect(current.candidate).toBe("Alex");
  expect(current.title).toBe("Alex interview");
  const history = await (
    await page.request.get(`/api/conversations/${item.id}/versions`)
  ).json();
  expect(history.items[0].data.transcript).toBe("Alex: I shipped a product.");
});
