import { test, expect } from "./fixtures";

const routes = [
  "sourcing",
  "application-review",
  "screening",
  "interview-notes",
  "reports",
  "outreach",
  "job-posts",
  "fillmore",
];

test("public product pages have distinct layouts, working FAQs and responsive navigation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const route of routes) {
    await page.goto(`/${route}`);
    await expect(page.locator(`.mk-detail-${route}`)).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(
      page.locator(".mk-detail-hero .mk-button").first(),
    ).toHaveAttribute("href", route === "sourcing" ? "/signup" : "/demo");
    const questions = page.locator(".mk-detail-faq button");
    await questions.nth(1).click();
    await expect(questions.nth(1)).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#product-answer-1")).toBeVisible();
    await questions.nth(1).click();
    await expect(page.locator("#product-answer-1")).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
    await page.getByRole("button", { name: "Platform", exact: true }).click();
    await expect(
      page.locator(".mk-dropdown").getByRole("link", { name: /Job Posts/ }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "Open navigation", exact: true }),
    ).toHaveAttribute("aria-expanded", "false");
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  expect(errors).toEqual([]);
});

test("public sourcing inputs and coworker tour support keyboard review without side effects", async ({
  page,
}) => {
  await page.goto("/sourcing");
  const describe = page.getByRole("tab", { name: "Describe it", exact: true });
  await describe.focus();
  await describe.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Bring the role", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("tabpanel", { name: "Bring the role" }),
  ).toContainText("Role brief");
  await page
    .getByRole("tab", { name: "Bring the role", exact: true })
    .press("End");
  await expect(
    page.getByRole("tabpanel", { name: "Use examples" }),
  ).toContainText("Example profile");
  await page.goto("/fillmore");
  await page.getByRole("tab", { name: "review the plan", exact: true }).click();
  await expect(
    page.getByRole("tabpanel", { name: "review the plan" }),
  ).toContainText("The brief is ready");
  await page
    .getByRole("tab", { name: "review the plan", exact: true })
    .press("ArrowLeft");
  await expect(
    page.getByRole("tabpanel", { name: "you brief your coworker" }),
  ).toContainText("senior backend engineer");
});

test("homepage platform explorer links each product and retains source-inspired sections", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  const sourcing = page.getByRole("tab", { name: "Sourcing", exact: true });
  await sourcing.focus();
  await sourcing.press("ArrowRight");
  await expect(
    page.getByRole("tabpanel", { name: "Application Review" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Explore application review", exact: true }),
  ).toHaveAttribute("href", "/application-review");
  await expect(
    page.getByRole("heading", { name: "Meet your recruiting coworker." }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Shared context. Clear access and control.",
    }),
  ).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath("marketing-parity-home-desktop.png"),
    fullPage: false,
  });
  await page.goto("/sourcing");
  await expect(page.locator(".mk-detail-sourcing h1")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("marketing-parity-sourcing-desktop.png"),
    fullPage: false,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath("marketing-parity-sourcing-mobile.png"),
    fullPage: false,
  });
});
