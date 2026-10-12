import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

async function setup(page: Page, baseURL: string | undefined) {
  const headers = { Origin: new URL(baseURL!).origin };
  const signup = await page.request.post("/api/auth/signup", {
    headers,
    data: {
      name: "Enrichment Tester",
      email: `enrichment-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
      password: "EnrichmentTest987!",
      workspaceName: "Enrichment fixture workspace",
      seedDemo: false,
    },
  });
  expect(signup.ok(), await signup.text()).toBeTruthy();
  const created = await page.request.post("/api/candidates", {
    headers,
    data: {
      name: "Jamie Enrichment",
      role: "Engineer",
      company: "Synthetic Labs",
      profile: "https://www.linkedin.com/in/jamie-enrichment-fixture",
      email: "jamie@synthetic.example",
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  return { candidate: (await created.json()).item, headers };
}

async function openCandidate(page: Page) {
  await page.goto("/app/candidates");
  await page
    .getByRole("button", { name: "Jamie Enrichment jamie@synthetic.example" })
    .click();
  await expect(
    page.getByRole("region", { name: "Candidate enrichment" }),
  ).toBeVisible();
}

test("unconfigured enrichment explains setup and cannot make a paid lookup", async ({
  page,
  baseURL,
}) => {
  const { candidate } = await setup(page, baseURL);
  await openCandidate(page);
  const panel = page.getByRole("region", { name: "Candidate enrichment" });
  await expect(
    panel.getByText("Provider setup required", { exact: true }),
  ).toBeVisible();
  await expect(panel).toContainText("PDL_API_KEY");
  await panel.getByLabel(/I confirm this candidate supplied/).check();
  await expect(
    panel.getByRole("button", { name: "Look up professional profile" }),
  ).toBeDisabled();
  const stored = await page.request.get(`/api/candidates/${candidate.id}`);
  expect((await stored.json()).item.role).toBe("Engineer");
});

test("synthetic proposal requires identity review and selected fields; conflicts stay protected", async ({
  page,
  baseURL,
}) => {
  const { candidate, headers } = await setup(page, baseURL);
  const path = `/api/candidates/${candidate.id}/enrichment`;
  let lookups = 0,
    applied: string[] = [];
  const run = {
    id: "de7e040f-5c74-4d28-bfb2-cfc124924773",
    status: "proposed",
    identifier: "profile",
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    appliedAt: null as string | null,
    appliedFields: [] as string[],
    error: null,
    candidateVersion: candidate.updatedAt,
    identityChanged: false,
    provenance: {
      providerName: "People Data Labs",
      likelihood: 8,
      matched: ["profile"],
      identity: {
        name: "Jamie Enrichment",
        role: "Staff Engineer",
        company: "Synthetic Labs",
        profile: candidate.profile,
      },
    },
    diff: [
      {
        field: "role",
        before: "Engineer",
        proposed: "Staff Engineer",
        conflict: false,
      },
      {
        field: "skills",
        before: "Locally reviewed skills",
        proposed: "TypeScript, React",
        conflict: true,
      },
    ],
  };
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() === "GET")
      await route.fulfill({
        json: {
          setup: {
            configured: true,
            canManage: true,
            missing: [],
            workspaceId: "synthetic-test-workspace",
          },
          candidateVersion: candidate.updatedAt,
          identifiers: [
            {
              id: "profile",
              available: true,
              inputs: { profile: candidate.profile },
            },
            { id: "workEmail", available: false, inputs: {} },
            {
              id: "nameCompany",
              available: true,
              inputs: { name: candidate.name, company: candidate.company },
            },
          ],
          items: lookups ? [run] : [],
        },
      });
    else {
      const body = route.request().postDataJSON();
      expect(body.consent).toBe(true);
      expect(body.identifier).toBe("profile");
      expect(body.candidateVersion).toBe(candidate.updatedAt);
      lookups++;
      await route.fulfill({ status: 201, json: { item: run, reused: false } });
    }
  });
  await page.route(`**${path}/${run.id}/apply`, async (route) => {
    const body = route.request().postDataJSON();
    applied = body.fields;
    expect(body.confirm).toBe(true);
    expect(applied).toEqual(["role"]);
    const changed = await page.request.patch(
      `/api/candidates/${candidate.id}`,
      { headers, data: { role: "Staff Engineer" } },
    );
    expect(changed.ok()).toBeTruthy();
    run.status = "applied";
    run.appliedAt = new Date().toISOString();
    run.appliedFields = applied;
    await route.fulfill({ json: await changed.json() });
  });
  await openCandidate(page);
  const panel = page.getByRole("region", { name: "Candidate enrichment" });
  await expect(
    panel.getByRole("button", { name: "Look up professional profile" }),
  ).toBeDisabled();
  await panel.getByLabel(/I confirm this candidate supplied/).check();
  await panel
    .getByRole("button", { name: "Look up professional profile" })
    .click();
  await expect(
    panel.getByText("Ready for review", { exact: true }),
  ).toBeVisible();
  await expect(panel).toContainText("Match confidence: 8/10");
  await expect(
    panel.getByLabel("Apply Skills", { exact: true }),
  ).toBeDisabled();
  await expect(
    panel.getByRole("button", { name: "Apply selected fields" }),
  ).toBeDisabled();
  await panel.getByLabel("Apply Current role", { exact: true }).check();
  await expect(
    panel.getByRole("button", { name: "Apply 1 fields" }),
  ).toBeDisabled();
  await panel
    .getByLabel("I reviewed the matched identity and selected field changes.")
    .check();
  await panel.getByRole("button", { name: "Apply 1 fields" }).click();
  await expect(
    panel.getByText("Selected fields applied", { exact: true }),
  ).toBeVisible();
  expect(lookups).toBe(1);
  expect(applied).toEqual(["role"]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    panel.getByRole("heading", { name: "Professional enrichment" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
});
