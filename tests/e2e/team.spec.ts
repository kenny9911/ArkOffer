import { test, expect } from "./fixtures";

test("invite a new teammate, accept with a matching account, change roles and switch isolated workspaces", async ({
  page,
  browser,
  baseURL,
}) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const ownerEmail = `team-owner-${suffix}@example.com`,
    memberEmail = `team-member-${suffix}@example.com`;
  await page.goto("/signup");
  await page.getByLabel("Your name", { exact: true }).fill("Team Owner");
  await page
    .getByLabel("Workspace name", { exact: true })
    .fill("Shared hiring workspace");
  await page.getByLabel("Work email").fill(ownerEmail);
  await page
    .getByLabel("Password", { exact: true })
    .fill("Team-test-password-2026");
  await page.getByRole("checkbox").uncheck();
  await page
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await expect(page).toHaveURL(/\/notes$/);
  await page.goto("/app/settings?tab=team");
  await expect(
    page.getByRole("heading", { name: "Team & workspaces" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Invite member", exact: true })
    .click();
  await page.getByLabel("Name (optional)").fill("Invited Recruiter");
  await page.getByLabel("Email address", { exact: true }).fill(memberEmail);
  await page.getByRole("button", { name: "Create invitation link" }).click();
  await expect(
    page.getByLabel("Invitation link", { exact: true }),
  ).toBeVisible();
  const url = await page
    .getByLabel("Invitation link", { exact: true })
    .inputValue();
  const memberContext = await browser.newContext({ baseURL });
  const member = await memberContext.newPage();
  try {
    await member.goto(url);
    await expect(
      member.getByRole("heading", { name: "Join Shared hiring workspace" }),
    ).toBeVisible();
    await member.getByRole("link", { name: "Create an account" }).click();
    await member
      .getByLabel("Your name", { exact: true })
      .fill("Invited Recruiter");
    await member
      .getByLabel("Workspace name", { exact: true })
      .fill("Recruiter personal workspace");
    await member.getByLabel("Work email").fill(memberEmail);
    await member
      .getByLabel("Password", { exact: true })
      .fill("Team-test-password-2026");
    await member.getByRole("checkbox").uncheck();
    await member
      .getByRole("button", { name: "Create workspace", exact: true })
      .click();
    await expect(
      member.getByRole("button", { name: "Accept invitation", exact: true }),
    ).toBeVisible();
    await member
      .getByRole("button", { name: "Accept invitation", exact: true })
      .click();
    await expect(member).toHaveURL(/\/notes$/);
    await member.goto("/app/settings?tab=team");
    await expect(
      member.getByText("Manage who can access Shared hiring workspace."),
    ).toBeVisible();
    await expect(
      member.getByRole("button", { name: "Invite member", exact: true }),
    ).toHaveCount(0);
    await page.reload();
    await page.getByLabel(`Role for ${memberEmail}`).selectOption("admin");
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(page.getByLabel(`Role for ${memberEmail}`)).toHaveValue(
      "admin",
    );
    await member.reload();
    await expect(
      member.getByRole("button", { name: "Invite member", exact: true }),
    ).toBeVisible();
    await member
      .getByLabel("Active workspace")
      .selectOption({ label: "Recruiter personal workspace · owner" });
    await expect(member).toHaveURL(/\/notes$/);
    await member.goto("/app/settings?tab=team");
    await expect(
      member.getByText("Manage who can access Recruiter personal workspace."),
    ).toBeVisible();
    await expect(member.locator(".team-member")).toHaveCount(1);
    await member
      .getByLabel("Active workspace")
      .selectOption({ label: "Shared hiring workspace · admin" });
    await expect(member).toHaveURL(/\/notes$/);
    await page.screenshot({
      path: "test-results/team-settings.png",
      fullPage: true,
    });
  } finally {
    await memberContext.close();
  }
});
