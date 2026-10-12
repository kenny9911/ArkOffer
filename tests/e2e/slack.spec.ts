import { test, expect } from "./fixtures";

async function signup(page: any, baseURL: string) {
  const response = await page.request.post("/api/auth/signup", {
    headers: { Origin: new URL(baseURL).origin },
    data: {
      name: "Slack Owner",
      email: `slack-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
      password: "LocalTestPass987!",
      workspaceName: "Slack Team",
      seedDemo: false,
    },
  });
  expect(response.ok()).toBeTruthy();
}

test("Slack settings show truthful setup requirements and disable installation without credentials", async ({
  page,
  baseURL,
}) => {
  await signup(page, baseURL!);
  await page.goto("/app/settings?tab=integrations");
  const slack = page.getByRole("region", {
    name: "Slack assistant",
    exact: true,
  });
  await expect(
    slack.getByText("Setup required", { exact: true }),
  ).toBeVisible();
  await expect(
    slack.getByRole("button", { name: "Install Slack app" }),
  ).toBeDisabled();
  await slack.getByText("Slack app setup", { exact: true }).click();
  await expect(slack).toContainText("SLACK_CLIENT_ID");
  await expect(slack).toContainText("publicly reachable HTTPS endpoint");
  await expect(slack).toContainText("private DM");
  await expect(
    slack.getByRole("button", { name: "Generate link code" }),
  ).toHaveCount(0);
});

test("Slack personal update controls require explicit schedule selection and exact draft approval", async ({
  page,
  baseURL,
}) => {
  await signup(page, baseURL!);
  const state: any = {
    configured: true,
    missing: [],
    canManage: true,
    connected: true,
    linked: true,
    teamName: "Acme Slack",
    slackUserId: "USENDER",
    redirectUri: "https://arkoffer.example/api/slack/callback",
    commandUrl: "https://arkoffer.example/api/slack/commands",
    eventsUrl: "https://arkoffer.example/api/slack/events",
    scopes: ["commands", "chat:write", "im:write"],
    schedules: [],
    jobs: [],
  };
  const mutations: { path: string; body: any }[] = [];
  await page.route("**/api/slack**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (req.method() === "GET") {
      await route.fulfill({ json: state });
      return;
    }
    const body = req.postDataJSON();
    mutations.push({ path, body });
    if (path === "/api/slack/schedule")
      state.schedules = [
        {
          ...body,
          enabled: Number(body.enabled),
          nextAt: Date.now() + 86400000,
        },
      ];
    if (path === "/api/slack/drafts")
      state.jobs = [
        {
          id: "test-draft",
          kind: "digest",
          status: "draft",
          body: "Your interview activity\n• Frontend interview",
          revision: "exact-reviewed-revision",
          error: "",
          createdAt: Date.now(),
        },
      ];
    if (path.endsWith("/approve")) state.jobs[0].status = "queued";
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto("/app/settings?tab=integrations");
  const slack = page.getByRole("region", {
    name: "Slack assistant",
    exact: true,
  });
  await expect(
    slack.getByLabel("Enable activity digest", { exact: true }),
  ).not.toBeChecked();
  await expect(
    slack.getByLabel("Activity digest delivery", { exact: true }),
  ).toHaveValue("draft");
  expect(mutations).toHaveLength(0);
  await slack.getByLabel("Enable activity digest", { exact: true }).check();
  await slack.getByLabel("Activity digest time (UTC)").selectOption("10");
  await slack
    .getByRole("button", { name: "Save activity digest", exact: true })
    .click();
  expect(mutations[0]).toEqual({
    path: "/api/slack/schedule",
    body: { kind: "digest", enabled: true, hourUtc: 10, delivery: "draft" },
  });
  await slack
    .getByRole("button", { name: "Draft activity digest now", exact: true })
    .click();
  await expect(slack).toContainText("Frontend interview");
  expect(mutations.some((m) => m.path.endsWith("/approve"))).toBeFalsy();
  await slack
    .getByRole("button", { name: "Approve and send to my DM", exact: true })
    .click();
  await expect(slack.getByText("queued", { exact: true })).toBeVisible();
  expect(mutations.at(-1)).toEqual({
    path: "/api/slack/jobs/test-draft/approve",
    body: { revision: "exact-reviewed-revision" },
  });
});
