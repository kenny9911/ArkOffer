import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
const origin = "http://127.0.0.1:3412";
async function signup(page: Page, name: string) {
  const result = await page.request.post("/api/auth/signup", {
    headers: { Origin: origin },
    data: {
      name,
      email: `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
      password: "Local-test-password-2026",
    },
  });
  expect(result.status()).toBe(201);
  return (await result.json()).user;
}
const createNote = async (page: Page, title: string, transcript: string) =>
  (
    await (
      await page.request.post("/api/conversations", {
        headers: { Origin: origin },
        data: {
          title,
          transcript,
          sections: [
            {
              id: crypto.randomUUID(),
              title: "Experience",
              content: "Source notes",
            },
          ],
        },
      })
    ).json()
  ).item;
test("named sharing enforces readonly editing, supports discussion and revocation", async ({
  page,
  browser,
  baseURL,
}) => {
  await signup(page, "Sharing-owner");
  const context = await browser.newContext({ baseURL }),
    member = await context.newPage();
  try {
    const colleague = await signup(member, "Sharing-member");
    const invitation = await (
      await page.request.post("/api/team/invitations", {
        headers: { Origin: origin },
        data: { email: colleague.email, role: "member" },
      })
    ).json();
    expect(
      (
        await member.request.post(`/api${invitation.item.url}/accept`, {
          headers: { Origin: origin },
          data: {},
        })
      ).ok(),
    ).toBeTruthy();
    const note = await createNote(
      page,
      "Shared platform interview",
      "Candidate: I built accessible TypeScript interfaces.",
    );
    await page.goto(`/notes/${note.id}`);
    await page
      .getByRole("button", { name: "Team access", exact: true })
      .click();
    await page
      .getByLabel("Teammate", { exact: true })
      .selectOption(colleague.id);
    await page.getByRole("button", { name: "Share with teammate" }).click();
    await expect(page.getByText(`${colleague.email} · viewer`)).toBeVisible();
    await member.goto("/notes/shared");
    await member
      .getByText("Shared platform interview", { exact: true })
      .click();
    await expect(
      member.getByLabel("Conversation title", { exact: true }),
    ).toHaveAttribute("readonly", "");
    await expect(
      member.getByRole("button", { name: "Add section", exact: true }),
    ).toBeDisabled();
    await member
      .getByRole("button", { name: "Discussion", exact: true })
      .click();
    await member
      .getByLabel("Your comment")
      .fill("Please ask about accessibility testing next.");
    await member.getByRole("button", { name: "Post comment" }).click();
    await expect(
      member.getByText("Please ask about accessibility testing next.", {
        exact: true,
      }),
    ).toBeVisible();
    await member.reload();
    await member
      .getByRole("button", { name: "Discussion", exact: true })
      .click();
    await expect(
      member.getByText("Please ask about accessibility testing next.", {
        exact: true,
      }),
    ).toBeVisible();
    await page.getByLabel("Permission", { exact: true }).selectOption("editor");
    await page.getByRole("button", { name: "Share with teammate" }).click();
    await expect(page.getByText(`${colleague.email} · editor`)).toBeVisible();
    await member.reload();
    await member
      .getByLabel("Conversation title", { exact: true })
      .fill("Teammate updated interview");
    await member.getByLabel("Conversation title", { exact: true }).blur();
    await expect(member.getByText("Saved", { exact: true })).toBeVisible();
    await member.reload();
    await expect(
      member.getByLabel("Conversation title", { exact: true }),
    ).toHaveValue("Teammate updated interview");
    await page
      .getByRole("button", { name: "Remove access", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Remove access", exact: true }),
    ).toHaveCount(0);
    await member.reload();
    await expect(member.getByRole("alert")).toContainText("not found");
  } finally {
    await context.close();
  }
});
test("workspace assistant searches multiple sources and preserves cited history across reloads", async ({
  page,
}) => {
  await signup(page, "Assistant-owner");
  await createNote(
    page,
    "Platform interview",
    "Candidate: TypeScript services supported a large platform.",
  );
  await createNote(
    page,
    "Frontend interview",
    "Candidate: TypeScript helped improve accessibility.",
  );
  await createNote(page, "Upcoming interview", "");
  await page.goto("/app/fillmore");
  await expect(
    page.getByRole("heading", { name: "Ask your conversations." }),
  ).toBeVisible();
  await page.getByLabel("Your question").fill("TypeScript");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.locator(".assistant-answer")).toContainText(
    "Platform interview",
  );
  await expect(page.locator(".assistant-answer")).toContainText(
    "Frontend interview",
  );
  await page.reload();
  await page
    .locator(".assistant-thread")
    .getByRole("button", { name: "TypeScript", exact: true })
    .click();
  await expect(page.locator(".assistant-answer")).toContainText(
    "accessibility",
  );
  await page.getByText("Sources · 2", { exact: true }).click();
  await expect(
    page.getByRole("link", { name: /Platform interview/ }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page.locator(".assistant-workspace").evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(
    page
      .locator(".assistant-history")
      .getByRole("button", { name: "New", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await page.screenshot({
    path: "test-results/workspace-assistant-mobile.png",
    fullPage: true,
  });
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Delete TypeScript", exact: true })
    .click();
  await expect(page.locator(".assistant-thread")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".assistant-thread")).toHaveCount(0);
});
