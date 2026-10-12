import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
async function signup(page: Page, baseURL: string | undefined) {
  const headers = { Origin: new URL(baseURL!).origin };
  const response = await page.request.post("/api/auth/signup", {
    headers,
    data: {
      name: "Sourcing Tester",
      email: `sourcing-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
      password: "SourcingTest987!",
      workspaceName: "Synthetic sourcing",
      seedDemo: false,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return headers;
}
async function candidate(
  page: Page,
  headers: Record<string, string>,
  name: string,
  location = "Singapore",
) {
  const response = await page.request.post("/api/candidates", {
    headers,
    data: {
      name,
      role: "Platform Engineer",
      company: "Example Studio",
      skills: "TypeScript, Kubernetes",
      location,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()).item;
}
test("sourcing prompt home leads to persistent criteria, evidence packs and private reviews", async ({
  page,
  baseURL,
}) => {
  const headers = await signup(page, baseURL);
  await candidate(page, headers, "Synthetic Avery");
  await candidate(page, headers, "Synthetic Blake", "London");
  await page.goto("/app/sourcing");
  await expect(
    page.getByRole("heading", { name: "How can we help you hire today?" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Build search plan", exact: true }),
  ).toBeDisabled();
  if (process.env.ARKOFFER_CAPTURE_REVIEW === "1") {
    const viewport = page.viewportSize()!;
    await page.setViewportSize({ width: 1664, height: 1490 });
    await page.screenshot({
      path: "/tmp/arkoffer-final-sourcing.png",
      fullPage: true,
    });
    await page.setViewportSize(viewport);
  }
  await page
    .getByLabel("Describe who you want to hire")
    .fill("Find platform engineers in Singapore");
  await page
    .getByRole("button", { name: "Create a manual search", exact: true })
    .click();
  await page
    .getByLabel("Search name", { exact: true })
    .fill("Singapore platform search");
  await page
    .getByLabel("Job titles", { exact: true })
    .pressSequentially("Platform Engineer, Software Engineer");
  await expect(page.getByLabel("Job titles", { exact: true })).toHaveValue(
    "Platform Engineer, Software Engineer",
  );
  await page.getByLabel("Locations", { exact: true }).fill("Singapore");
  await page.getByLabel("Skills", { exact: true }).fill("TypeScript");
  await page
    .getByRole("button", { name: "Search candidate library", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Synthetic Avery", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Synthetic Blake", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Synthetic Avery", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Review Synthetic Avery" });
  await dialog.getByLabel("Your review", { exact: true }).selectOption("yes");
  await dialog
    .getByLabel("Private review notes", { exact: true })
    .fill("Discuss infrastructure experience.");
  await dialog
    .getByRole("button", { name: "Save review", exact: true })
    .click();
  await expect(
    page.getByText("Private review saved.", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.getByRole("button", { name: /Singapore platform search/ }).click();
  await page
    .getByRole("button", { name: "Synthetic Avery", exact: true })
    .click();
  await expect(
    page.getByLabel("Private review notes", { exact: true }),
  ).toHaveValue("Discuss infrastructure experience.");
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Export CSV", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Search mode", { exact: true }).selectOption("market");
  await expect(
    page.getByRole("heading", { name: "Companies in this result pack" }),
  ).toBeVisible();
  await expect(page.getByText("Counts describe this pack only.")).toBeVisible();
  await page
    .getByRole("button", { name: "Candidate library", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Add candidate", exact: true }).first(),
  ).toBeVisible();
});
test("AI sourcing preserves retry identity and presents unconnected discovery honestly", async ({
  page,
  baseURL,
}) => {
  const headers = await signup(page, baseURL);
  await candidate(page, headers, "Synthetic Riley");
  await page.route("**/api/sourcing", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: { ...data, aiAvailable: true } });
  });
  let requestId = "",
    calls = 0;
  await page.route("**/api/sourcing/sessions", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const input = route.request().postDataJSON();
    calls++;
    if (calls === 1) {
      requestId = input.requestId;
      await route.fulfill({
        status: 502,
        json: {
          error: "Synthetic connection interrupted. Retry this request.",
        },
      });
      return;
    }
    expect(input.requestId).toBe(requestId);
    const response = await page.request.post("/api/sourcing/sessions", {
      headers,
      data: { ...input, manual: true },
    });
    const body = await response.json();
    await route.fulfill({ status: 201, json: body });
  });
  await page.goto("/app/sourcing");
  await page
    .getByLabel("Describe who you want to hire")
    .fill("Find TypeScript engineers");
  await page
    .getByRole("button", { name: "Build search plan", exact: true })
    .click();
  await expect(
    page.getByText("Synthetic connection interrupted. Retry this request."),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Build search plan", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Search plan", exact: true }),
  ).toBeVisible();
  expect(calls).toBe(2);
  await page.getByLabel("Search source", { exact: true }).selectOption("pdl");
  await expect(
    page.getByRole("button", {
      name: "Discover up to 20 profiles",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    page.getByText(/Professional discovery is not connected/),
  ).toBeVisible();
});
test("look-alike mode requires a reference and starts with professional criteria", async ({
  page,
  baseURL,
}) => {
  const headers = await signup(page, baseURL);
  await candidate(page, headers, "Synthetic Reference");
  await page.goto("/app/sourcing");
  await page.getByRole("button", { name: "Look-alikes", exact: true }).click();
  const modal = page.getByRole("dialog", {
    name: "Look-alikes Prompt",
    exact: true,
  });
  await expect(
    modal.getByRole("button", { name: "Use prompt", exact: true }),
  ).toBeDisabled();
  await modal
    .getByLabel("Or choose a saved reference candidate", { exact: true })
    .selectOption({ label: "Synthetic Reference · Platform Engineer" });
  await modal.getByRole("button", { name: "Use prompt", exact: true }).click();
  await page
    .getByRole("button", { name: "Create a manual search", exact: true })
    .click();
  await expect(page.getByLabel("Job titles", { exact: true })).toHaveValue(
    "Platform Engineer",
  );
  await expect(page.getByLabel("Skills", { exact: true })).toHaveValue(
    "TypeScript, Kubernetes",
  );
  await page
    .getByRole("button", { name: "Search candidate library", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "No candidates match", exact: true }),
  ).toBeVisible();
});

test("guided Sourcing Prompt keeps its generated text editable before planning", async ({
  page,
  baseURL,
}) => {
  await signup(page, baseURL);
  await page.goto("/app/sourcing");
  await page
    .getByRole("button", { name: "Sourcing", exact: true })
    .last()
    .click();
  const modal = page.getByRole("dialog", {
    name: "Sourcing Prompt",
    exact: true,
  });
  await expect(
    modal.getByText("Fill in the placeholders, or edit the actual prompt."),
  ).toBeVisible();
  await modal.getByLabel("Role", { exact: true }).fill("Solutions Architect");
  await modal.getByLabel("Location", { exact: true }).fill("London");
  await modal.getByLabel("Years of experience", { exact: true }).fill("7+");
  await modal
    .getByLabel("Industry", { exact: true })
    .fill("enterprise software");
  await modal.getByLabel("Skills", { exact: true }).fill("AWS and Terraform");
  await expect(modal.getByLabel("Actual prompt", { exact: true })).toHaveValue(
    /Find Solutions Architect in London with 7\+ years/,
  );
  await modal
    .getByLabel("Actual prompt", { exact: true })
    .fill("Find architects in London. Prefer AWS experience.");
  await modal.getByRole("button", { name: "Use prompt", exact: true }).click();
  await expect(
    page.getByLabel("Describe who you want to hire", { exact: true }),
  ).toHaveValue("Find architects in London. Prefer AWS experience.");
});

test("sourcing exclusions persist and never pretend recent job-change dates are known", async ({
  page,
  baseURL,
}) => {
  const headers = await signup(page, baseURL),
    past = await candidate(page, headers, "Past designer");
  await page.request.patch(`/api/candidates/${past.id}`, {
    headers,
    data: { role: "Designer" },
  });
  await candidate(page, headers, "Fresh engineer");
  const created = await page.request.post("/api/sourcing/sessions", {
    headers,
    data: {
      requestId: crypto.randomUUID(),
      prompt: "Earlier designer search",
      manual: true,
    },
  });
  const search = (await created.json()).item;
  const patched = await page.request.patch(
    `/api/sourcing/sessions/${search.id}`,
    {
      headers,
      data: {
        revision: search.revision,
        title: search.title,
        criteria: { titles: ["Designer"] },
        source: "workspace",
        mode: "sourcing",
      },
    },
  );
  const saved = (await patched.json()).item;
  await page.request.post(`/api/sourcing/sessions/${search.id}/runs`, {
    headers,
    data: {
      requestId: crypto.randomUUID(),
      revision: saved.revision,
      consent: true,
    },
  });
  await page.goto("/app/sourcing");
  await page
    .getByRole("button", { name: "Search exclusions", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: /Exclude past search results/ })
    .check();
  await expect(
    page.getByRole("checkbox", { name: /Exclude recent job changers/ }),
  ).toBeDisabled();
  await page
    .getByLabel("Describe who you want to hire")
    .fill("Exclude old profiles");
  await page
    .getByRole("button", { name: "Create a manual search", exact: true })
    .click();
  await page.getByLabel("Companies", { exact: true }).fill("Example Studio");
  await page
    .getByRole("button", { name: "Search candidate library", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Fresh engineer", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Past designer", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText(/1 profiles excluded before pagination/),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.getByRole("button", { name: /Exclude old profiles/ }).click();
  await page.locator("summary").filter({ hasText: "Exclusions" }).click();
  await expect(
    page.getByRole("checkbox", { name: /Exclude past search results/ }),
  ).toBeChecked();
});

test("a running sourcing replay cannot start a duplicate paid request", async ({
  page,
  baseURL,
}) => {
  await signup(page, baseURL);
  await page.goto("/app/sourcing");
  await page
    .getByRole("button", { name: "Create a manual search", exact: true })
    .click();
  await page.getByLabel("Job titles", { exact: true }).fill("Engineer");
  let initialRequestId = "",
    calls = 0,
    finished = false;
  await page.route("**/api/sourcing/sessions/*/runs", async (route) => {
    const input = route.request().postDataJSON();
    calls++;
    const response = await route.fetch();
    const body = await response.json();
    if (calls === 1) {
      initialRequestId = input.requestId;
      await route.fulfill({
        status: 502,
        json: { error: "Synthetic lost search response" },
      });
    } else if (calls === 2) {
      expect(input.requestId).toBe(initialRequestId);
      await route.fulfill({
        response,
        json: { item: { ...body.item, status: "running" } },
      });
    } else {
      expect(input.requestId).not.toBe(initialRequestId);
      await route.fulfill({ response, json: body });
    }
  });
  await page.route(/\/api\/sourcing\/sessions\/[^/]+$/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (
      route.request().method() === "GET" &&
      !finished &&
      body.item?.runs?.length
    )
      body.item.runs = body.item.runs.map((pack: { status: string }) => ({
        ...pack,
        status: "running",
      }));
    await route.fulfill({ response, json: body });
  });
  const run = page.getByRole("button", {
    name: "Search candidate library",
    exact: true,
  });
  await run.click();
  await expect(
    page.getByText("Synthetic lost search response", { exact: true }),
  ).toBeVisible();
  await run.click();
  await expect(run).toBeDisabled();
  expect(calls).toBe(2);
  finished = true;
  await expect(run).toBeEnabled();
  await run.click();
  await expect(run).toBeEnabled();
  expect(calls).toBe(3);
});
