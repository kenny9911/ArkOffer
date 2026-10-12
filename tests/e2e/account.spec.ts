import { test, expect } from "./fixtures";

test("change a password, revoke another browser session, and show unconfigured recovery honestly", async ({
  page,
  browser,
  baseURL,
}) => {
  const address = `account-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
  const original = "Account-test-password-2026",
    changed = "Changed-account-password-2026";
  await page.goto("/signup");
  await page.getByLabel("Your name", { exact: true }).fill("Account Tester");
  await page
    .getByLabel("Workspace name", { exact: true })
    .fill("Account security workspace");
  await page.getByLabel("Work email").fill(address);
  await page.getByLabel("Password", { exact: true }).fill(original);
  await page.getByRole("checkbox").uncheck();
  await page
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await expect(page).toHaveURL(/\/notes$/);
  const secondContext = await browser.newContext({ baseURL });
  const second = await secondContext.newPage();
  try {
    await second.goto("/login");
    await second.getByLabel("Work email").fill(address);
    await second.getByLabel("Password", { exact: true }).fill(original);
    await second.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(second).toHaveURL(/\/notes$/);
    await page.goto("/app/settings?tab=security");
    await expect(
      page.getByRole("heading", { name: "Account security", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Other session", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Send verification email",
        exact: true,
      }),
    ).toBeDisabled();
    await page.getByLabel("Current password", { exact: true }).fill(original);
    await page.getByLabel("New password", { exact: true }).fill(changed);
    await page
      .getByLabel("Confirm new password", { exact: true })
      .fill(changed);
    await page
      .getByRole("button", { name: "Update password", exact: true })
      .click();
    await expect(
      page.getByText("Password updated. Other sessions have been signed out.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText("Other session", { exact: true })).toHaveCount(
      0,
    );
    await second.reload();
    await expect(second).toHaveURL(/\/login$/);
    await second.getByLabel("Work email").fill(address);
    await second.getByLabel("Password", { exact: true }).fill(original);
    await second.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(second.getByRole("alert")).toContainText(
      "Email or password is incorrect",
    );
    await second.getByLabel("Password", { exact: true }).fill(changed);
    await second.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(second).toHaveURL(/\/notes$/);
    await page.reload();
    await page
      .getByRole("button", { name: "Sign out other sessions", exact: true })
      .click();
    await expect(page.getByText("Other session", { exact: true })).toHaveCount(
      0,
    );
    await second.reload();
    await expect(second).toHaveURL(/\/login$/);
    await second
      .getByRole("link", { name: "Forgot password?", exact: true })
      .click();
    await second.getByLabel("Account email", { exact: true }).fill(address);
    await second
      .getByRole("button", { name: "Request reset link", exact: true })
      .click();
    await expect(second.getByRole("alert")).toContainText(
      "Account recovery email is not configured",
    );
    await page.screenshot({
      path: "test-results/account-security.png",
      fullPage: true,
    });
  } finally {
    await secondContext.close();
  }
});
