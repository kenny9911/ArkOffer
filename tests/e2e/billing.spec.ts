import { test, expect } from "./fixtures";

test("billing and external-provider settings show truthful setup status without creating paid services", async ({
  page,
  baseURL,
}) => {
  const response = await page.request.post("/api/auth/signup", {
    headers: { Origin: new URL(baseURL!).origin },
    data: {
      name: "Billing Owner",
      email: `billing-${Date.now()}@example.com`,
      password: "LocalTestPass987!",
      workspaceName: "Billing Test",
      seedDemo: false,
    },
  });
  expect(response.ok()).toBeTruthy();
  await page.goto("/app/settings?tab=billing");
  await expect(
    page.getByRole("heading", { name: "Plans & billing", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("No confirmed paid subscription", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("1 active members", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Stripe checkout is not enabled for this workspace.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue to Stripe", exact: false }),
  ).toHaveCount(0);
  const state = await (await page.request.get("/api/billing")).json();
  expect(state.subscription).toBeNull();
  expect(state.pendingCheckout).toBeNull();
  expect(state.enabled).toBe(false);
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Integrations", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Greenhouse ATS", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Recall.ai meeting capture",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sync Greenhouse", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Create recording capture", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Billing", exact: true })
    .click();
  await expect(
    page.getByText("No confirmed paid subscription", { exact: true }),
  ).toBeVisible();
});
