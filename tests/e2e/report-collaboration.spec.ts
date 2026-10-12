import { test, expect } from "./fixtures";
import type { APIRequestContext } from "@playwright/test";
const definition = (id: string) => ({
  name: "Team recruiting report",
  question: "What experiences are documented?",
  sourceIds: [id],
  columns: [
    {
      id: "evidence",
      name: "Experience",
      instruction: "Extract documented experience",
      type: "text",
    },
  ],
  filters: { title: "", from: "", to: "" },
});
async function signup(
  request: APIRequestContext,
  origin: string,
  name: string,
  email: string,
) {
  const response = await request.post("/api/auth/signup", {
    headers: { Origin: origin },
    data: {
      name,
      email,
      password: "ReportTestPass987!",
      workspaceName: `${name}'s team`,
      seedDemo: false,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()).user;
}
test("report sharing honors read-only membership, separate source grants and revocation", async ({
  page,
  browser,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin,
    suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await signup(
    page.request,
    origin,
    "Report Owner",
    `owner-${suffix}@example.com`,
  );
  const created = await page.request.post("/api/conversations", {
    headers: { Origin: origin },
    data: {
      title: "Private engineering conversation",
      transcript: "Candidate: I led a team of engineers.",
      archived: false,
    },
  });
  expect(created.ok()).toBeTruthy();
  const source = (await created.json()).item;
  const response = await page.request.post("/api/report-views", {
    headers: { Origin: origin },
    data: definition(source.id),
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const view = (await response.json()).item;
  const memberContext = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { "X-Forwarded-For": "127.51.42.39" },
  });
  try {
    const memberEmail = `member-${suffix}@example.com`,
      memberUser = await signup(
        memberContext.request,
        origin,
        "Report Reader",
        memberEmail,
      );
    const invite = await page.request.post("/api/team/invitations", {
      headers: { Origin: origin },
      data: { email: memberEmail, role: "member", name: "Report Reader" },
    });
    expect(invite.ok()).toBeTruthy();
    const token = (await invite.json()).item.url.split("/").pop();
    const accepted = await memberContext.request.post(
      `/api/invitations/${token}/accept`,
      { headers: { Origin: origin } },
    );
    expect(accepted.ok(), await accepted.text()).toBeTruthy();
    await page.goto(`/app/reports/${view.id}`);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await expect
      .poll(() =>
        page
          .locator(".report-inspector-body")
          .evaluate((element) => element.scrollTop),
      )
      .toBeGreaterThan(0);
    expect(
      (await page.locator(".reports-topbar").boundingBox())!.y,
    ).toBeGreaterThanOrEqual(0);
    expect(
      (await page.locator(".sidebar-brand").boundingBox())!.y,
    ).toBeGreaterThanOrEqual(0);
    await expect(
      page.getByRole("link", {
        name: "Private engineering conversation",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByLabel("Report access for Report Reader")
      .selectOption("viewer");
    await page
      .getByRole("button", { name: "Save sharing", exact: true })
      .click();
    await expect(
      page.getByText(
        "Report sharing saved. Source conversation access has not changed.",
      ),
    ).toBeVisible();
    const member = await memberContext.newPage();
    await member.goto("/app/reports");
    await member.getByLabel("Report list filter").selectOption("shared");
    await member.getByRole("link", { name: /Team recruiting report/ }).click();
    await expect(
      member.getByText(
        "You can view this report and export currently accessible results.",
        { exact: false },
      ),
    ).toBeVisible();
    await expect(
      member.getByLabel("Report name", { exact: true }),
    ).toBeDisabled();
    await expect(
      member.getByRole("button", { name: "Save report", exact: true }),
    ).toBeDisabled();
    await expect(
      member.getByRole("tab", { name: "Agent", exact: true }),
    ).toBeDisabled();
    await expect(
      member.getByText("Some source conversations are unavailable.", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      member.getByRole("link", {
        name: "Private engineering conversation",
        exact: true,
      }),
    ).toHaveCount(0);
    const grant = await page.request.put(
      `/api/conversations/${source.id}/access/${memberUser.id}`,
      { headers: { Origin: origin }, data: { permission: "viewer" } },
    );
    expect(grant.ok(), await grant.text()).toBeTruthy();
    await member.reload();
    await expect(
      member.getByRole("link", {
        name: "Private engineering conversation",
        exact: true,
      }),
    ).toBeVisible();
    await member.getByRole("tab", { name: "Charts", exact: true }).click();
    await expect(
      member.getByRole("combobox", { name: "Display", exact: true }),
    ).toBeDisabled();
    await page
      .getByLabel("Report access for Report Reader")
      .selectOption("none");
    await page
      .getByRole("button", { name: "Save sharing", exact: true })
      .click();
    await expect
      .poll(async () =>
        (
          await memberContext.request.get(`/api/report-views/${view.id}`)
        ).status(),
      )
      .toBe(404);
    await member.goto("/app/reports");
    await expect(
      member.getByRole("link", { name: /Team recruiting report/ }),
    ).toHaveCount(0);
    await page.screenshot({
      path: "test-results/report-sharing-desktop.png",
      fullPage: true,
    });
  } finally {
    await memberContext.close();
  }
});

test("upcoming report subscriptions persist scheduling, preview outbox email and unsubscribe", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  await signup(
    page.request,
    origin,
    "Digest Reviewer",
    `digest-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
  );
  const sourceResponse = await page.request.post("/api/conversations", {
    headers: { Origin: origin },
    data: {
      title: "Upcoming design interview",
      transcript: "",
      status: "upcoming",
      date: new Date(Date.now() + 20 * 60000).toISOString(),
      archived: false,
    },
  });
  expect(sourceResponse.ok(), await sourceResponse.text()).toBeTruthy();
  const source = (await sourceResponse.json()).item;
  const created = await page.request.post("/api/report-views", {
    headers: { Origin: origin },
    data: definition(source.id),
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const view = (await created.json()).item;
  await page.goto(`/app/reports/${view.id}`);
  const collaboration = page.getByRole("region", {
    name: "Sharing and subscriptions",
  });
  await collaboration.locator("summary", { hasText: "Email updates" }).click();
  await expect(
    collaboration.getByText(
      "Outbox mode: emails are saved for review and are not sent.",
    ),
  ).toBeVisible();
  await collaboration
    .getByLabel("Email updates enabled", { exact: true })
    .check();
  await collaboration
    .getByLabel("Upcoming conversations, about 30 minutes before")
    .check();
  await collaboration
    .getByLabel("Result email frequency")
    .selectOption("weekly");
  await collaboration.getByLabel("Digest hour (UTC)").selectOption("14");
  await collaboration.getByLabel("Digest weekday (UTC)").selectOption("4");
  await collaboration
    .getByRole("button", { name: "Save email updates", exact: true })
    .click();
  await expect(
    collaboration.getByText(
      "Email update settings saved. Only future matching events will be included.",
    ),
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(`/api/report-views/${view.id}/subscription`)
          ).json()
        ).deliveries.length,
    )
    .toBe(1);
  await collaboration
    .getByRole("button", { name: "Refresh email status" })
    .click();
  await collaboration
    .getByRole("button", { name: "Preview email", exact: true })
    .click();
  const preview = page.getByRole("region", { name: "Report email preview" });
  await expect(preview).toContainText("Upcoming design interview");
  await expect(preview).toContainText("0 newly completed report runs");
  await page.reload();
  await page
    .getByRole("region", { name: "Sharing and subscriptions" })
    .locator("summary", { hasText: "Email updates" })
    .click();
  await expect(collaboration.getByLabel("Result email frequency")).toHaveValue(
    "weekly",
  );
  await expect(collaboration.getByLabel("Digest hour (UTC)")).toHaveValue("14");
  await collaboration
    .getByLabel("Email updates enabled", { exact: true })
    .uncheck();
  await collaboration
    .getByRole("button", { name: "Save email updates", exact: true })
    .click();
  await expect(
    collaboration.getByText(
      "Unsubscribed. Pending emails have been cancelled.",
    ),
  ).toBeVisible();
  await expect(
    collaboration.getByText("cancelled", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/report-subscription-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBeTruthy();
});
