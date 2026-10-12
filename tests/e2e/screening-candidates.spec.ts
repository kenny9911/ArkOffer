import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

async function fixture(page: Page, baseURL: string | undefined) {
  const headers = { Origin: new URL(baseURL!).origin };
  const account = await page.request.post("/api/auth/signup", {
    headers,
    data: {
      name: "Screening Review Tester",
      email: `screening-review-${crypto.randomUUID()}@example.test`,
      password: "ScreeningReviewTests987!",
      workspaceName: "Synthetic candidate reviews",
      seedDemo: false,
    },
  });
  expect(account.ok(), await account.text()).toBeTruthy();
  const created = await page.request.post("/api/screenings", {
    headers,
    data: {
      name: "Platform engineer screening",
      title: "Platform engineer screening",
      description: "Share an example from your professional experience.",
      status: "draft",
      questions: [
        {
          prompt: "Describe an API you built.",
          type: "text",
          required: true,
          options: [],
          rubric: "Private reviewer guidance.",
        },
      ],
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const screen = (await created.json()).item;
  async function publish() {
    const result = await page.request.post(
      `/api/screenings/${screen.id}/publish`,
      { headers, data: {} },
    );
    expect(result.ok(), await result.text()).toBeTruthy();
    return (await result.json()).item as { id: string; token: string };
  }
  for (const [candidateName, email] of [
    ["Alex Example", "alex@example.test"],
    ["=Jordan Example", "jordan@example.test"],
  ]) {
    const publication = await publish();
    const publicForm = await page.request.get(
      `/api/interviews/${publication.token}`,
    );
    expect(publicForm.ok()).toBeTruthy();
    const form = (await publicForm.json()).item;
    const response = await page.request.post(
      `/api/interviews/${publication.token}/responses`,
      {
        headers,
        data: {
          candidateName,
          email,
          consent: true,
          answers: [
            {
              questionId: form.questions[0].id,
              value:
                "I built a TypeScript scheduling API with pagination and integration tests.",
            },
          ],
        },
      },
    );
    expect(response.status(), await response.text()).toBe(201);
  }
  const activeLink = await publish();
  const responses = (
    await (
      await page.request.get(`/api/screenings/${screen.id}/responses`)
    ).json()
  ).items;
  const responseId = responses.find(
    (response: { candidateName: string }) =>
      response.candidateName === "Alex Example",
  ).id;
  await page.goto(`/app/screening/${screen.id}?tab=candidates`);
  const candidates = page.getByRole("region", {
    name: "Screening candidates",
    exact: true,
  });
  await expect(
    candidates.getByRole("tab", { name: /^Unreviewed/ }),
  ).toContainText("2");
  await expect(
    candidates.getByRole("button", { name: "Alex Example", exact: true }),
  ).toBeVisible();
  return { headers, screen, candidates, responseId, activeLink };
}

test("screening candidate outcomes and notes persist, filtered CSV is safe, and revoking a link preserves responses", async ({
  page,
  baseURL,
}, testInfo) => {
  const { headers, screen, candidates, activeLink } = await fixture(
    page,
    baseURL,
  );
  await expect(
    candidates.getByRole("tab", { name: /^All candidates/ }),
  ).toContainText("2");
  await candidates
    .getByRole("button", { name: "Alex Example", exact: true })
    .click();
  const review = candidates.getByRole("complementary", {
    name: "Review Alex Example",
    exact: true,
  });
  await expect(review).toContainText("TypeScript scheduling API");
  await review
    .getByLabel("Reviewer notes", { exact: true })
    .fill("Discuss the API's operational constraints in the next interview.");
  await review
    .getByLabel("Review status", { exact: true })
    .selectOption("progressed");
  await review
    .getByRole("button", { name: "Save review", exact: true })
    .click();
  await expect(review.getByRole("status")).toContainText(
    "Saved by Screening Review Tester",
  );
  await expect(
    candidates.getByRole("tab", { name: /^Unreviewed/ }),
  ).toContainText("1");
  await expect(
    candidates.getByRole("tab", { name: /^Progressed/ }),
  ).toContainText("1");
  await candidates.getByRole("tab", { name: /^Progressed/ }).click();
  await expect(
    candidates.getByRole("button", { name: "Alex Example", exact: true }),
  ).toBeVisible();
  await expect(
    candidates.getByRole("button", { name: "=Jordan Example", exact: true }),
  ).not.toBeVisible();
  await page.reload();
  await candidates.getByRole("tab", { name: /^Progressed/ }).click();
  await candidates
    .getByRole("button", { name: "Alex Example", exact: true })
    .click();
  await expect(
    review.getByLabel("Reviewer notes", { exact: true }),
  ).toHaveValue(
    "Discuss the API's operational constraints in the next interview.",
  );
  await expect(review.getByLabel("Review status", { exact: true })).toHaveValue(
    "progressed",
  );
  await candidates.screenshot({
    path: testInfo.outputPath("screening-candidate-review.png"),
  });
  await review
    .getByRole("button", { name: "Close candidate review", exact: true })
    .click();
  await candidates.getByRole("tab", { name: /^All candidates/ }).click();
  await candidates
    .getByLabel("Search screening candidates", { exact: true })
    .fill("jordan");
  await expect(
    candidates.getByRole("button", { name: "Alex Example", exact: true }),
  ).not.toBeVisible();
  await expect(
    candidates.getByRole("button", { name: "=Jordan Example", exact: true }),
  ).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await candidates
    .getByRole("button", { name: "Download candidate table", exact: true })
    .click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(
    "arkoffer-screening-candidates.csv",
  );
  const csv = await readFile((await download.path())!, "utf8");
  expect(csv).toContain('"\'=Jordan Example"');
  expect(csv).toContain('"Unreviewed"');
  expect(csv).not.toContain("Alex Example");
  expect(csv).not.toContain("operational constraints");
  await candidates
    .getByLabel("Search screening candidates", { exact: true })
    .fill("");
  await candidates.getByRole("tab", { name: /^Candidate links/ }).click();
  const linkRow = candidates
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: "active", exact: true }) });
  await linkRow
    .getByRole("button", { name: "Revoke link", exact: true })
    .click();
  await candidates
    .getByRole("button", { name: "Confirm revoke", exact: true })
    .click();
  await expect(
    candidates.getByRole("cell", { name: "revoked", exact: true }),
  ).toBeVisible();
  expect(
    (await page.request.get(`/api/interviews/${activeLink.token}`)).status(),
  ).toBe(404);
  const data = await (
    await page.request.get(`/api/screenings/${screen.id}/responses`, {
      headers,
    })
  ).json();
  expect(data.items).toHaveLength(2);
  expect(
    data.publications.find((link: { id: string }) => link.id === activeLink.id)
      .status,
  ).toBe("revoked");
  await candidates.getByRole("tab", { name: /^All candidates/ }).click();
  await expect(
    candidates.getByRole("button", { name: "Alex Example", exact: true }),
  ).toBeVisible();
});

test("unsaved candidate notes cannot be discarded by link navigation and conflicts preserve reviewer text", async ({
  page,
  baseURL,
}) => {
  const { headers, screen, candidates, responseId } = await fixture(
    page,
    baseURL,
  );
  await candidates
    .getByRole("button", { name: "Alex Example", exact: true })
    .click();
  const review = candidates.getByRole("complementary", {
    name: "Review Alex Example",
    exact: true,
  });
  await review
    .getByLabel("Reviewer notes", { exact: true })
    .fill("My unsaved review evidence.");
  await expect(
    candidates.getByRole("tab", { name: /^Candidate links/ }),
  ).toBeDisabled();
  await expect(
    page.getByRole("tab", { name: "Builder", exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(true);
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toBe(
      "Leave this screening without saving your changes?",
    );
    await dialog.dismiss();
  });
  await page
    .locator(".screen-header")
    .getByRole("link", { name: "Screening", exact: true })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/app/screening/${screen.id}\\?tab=candidates$`),
  );
  await expect(
    review.getByLabel("Reviewer notes", { exact: true }),
  ).toHaveValue("My unsaved review evidence.");
  await expect(
    candidates.getByRole("button", { name: "Refresh candidates", exact: true }),
  ).toBeDisabled();
  await expect(
    review.getByRole("button", { name: "Close candidate review", exact: true }),
  ).toBeDisabled();
  const concurrent = await page.request.patch(
    `/api/screenings/${screen.id}/responses/${responseId}/review`,
    {
      headers,
      data: {
        revision: 0,
        status: "reviewed",
        notes: "A teammate's saved review.",
      },
    },
  );
  expect(concurrent.ok(), await concurrent.text()).toBeTruthy();
  await review
    .getByRole("button", { name: "Save review", exact: true })
    .click();
  await expect(review.getByRole("alert")).toContainText(
    "Another teammate updated this review",
  );
  await expect(
    review.getByLabel("Reviewer notes", { exact: true }),
  ).toHaveValue("My unsaved review evidence.");
  const saved = await (
    await page.request.get(`/api/screenings/${screen.id}/reviews`)
  ).json();
  expect(saved.items[0].notes).toBe("A teammate's saved review.");
  expect(saved.items[0].revision).toBe(1);
  await review
    .getByRole("button", { name: "Discard edits", exact: true })
    .click();
  await expect(
    candidates.getByRole("tab", { name: /^Candidate links/ }),
  ).toBeEnabled();
  await expect(
    page.getByRole("tab", { name: "Builder", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(false);
  await candidates
    .getByRole("button", { name: "Refresh candidates", exact: true })
    .click();
  await expect(
    review.getByLabel("Reviewer notes", { exact: true }),
  ).toHaveValue("A teammate's saved review.");
  await expect(review.getByLabel("Review status", { exact: true })).toHaveValue(
    "reviewed",
  );
  await expect(
    candidates.getByRole("tab", { name: /^Reviewed/ }),
  ).toContainText("1");
  await candidates.getByRole("tab", { name: /^Candidate links/ }).click();
  await expect(candidates).toContainText("Each link accepts one response");
});

test("live review distinguishes original speech from corrected answers and retries transcript loading", async ({
  page,
  baseURL,
}) => {
  const { screen, candidates, responseId } = await fixture(page, baseURL);
  const now = new Date().toISOString();
  const sessionId = crypto.randomUUID();
  await page.route(
    `**/api/screenings/${screen.id}/responses`,
    async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      const candidate = data.items.find(
        (item: { id: string }) => item.id === responseId,
      );
      candidate.answers[0].liveEvidence = {
        sessionId,
        consentAt: now,
        endedAt: now,
        originalTranscript: "I built a scheduling AP eye.",
        candidateEdited: true,
      };
      await route.fulfill({ response, json: data });
    },
  );
  let attempts = 0;
  await page.route(
    `**/api/screenings/${screen.id}/responses/${responseId}/live`,
    async (route) => {
      attempts++;
      if (attempts === 1) {
        await route.fulfill({
          status: 503,
          json: { error: "Transcript temporarily unavailable." },
        });
        return;
      }
      await route.fulfill({
        json: {
          items: [
            {
              id: sessionId,
              state: "ended",
              consentAt: now,
              endedAt: now,
              endReason: "candidate-ended",
              recording: false,
              events: [
                {
                  id: crypto.randomUUID(),
                  sequence: 1,
                  kind: "agent",
                  text: "Describe an API you built.",
                  createdAt: now,
                },
                {
                  id: crypto.randomUUID(),
                  sequence: 2,
                  kind: "answer",
                  text: "I built a scheduling AP eye.",
                  createdAt: now,
                },
              ],
            },
          ],
        },
      });
    },
  );
  await page.reload();
  await candidates
    .getByRole("button", { name: "Alex Example", exact: true })
    .click();
  const review = candidates.getByRole("complementary", {
    name: "Review Alex Example",
  });
  await expect(review).toContainText("TypeScript scheduling API");
  await review
    .getByText("Live interview transcript · candidate corrected", {
      exact: true,
    })
    .click();
  await expect(
    review.getByText("I built a scheduling AP eye.", { exact: true }),
  ).toBeVisible();
  expect(attempts).toBe(0);
  const evidence = review.getByRole("region", {
    name: "Live interview evidence",
  });
  await evidence
    .getByRole("button", { name: "View full interview transcript" })
    .click();
  await expect(evidence.getByRole("alert")).toContainText(
    "temporarily unavailable",
  );
  await evidence.getByRole("button", { name: "Retry transcript" }).click();
  await expect(evidence.getByRole("listitem")).toHaveCount(2);
  await expect(evidence).toContainText("Audio and video were not recorded");
  await expect(
    evidence.getByText("I built a scheduling AP eye.", { exact: true }),
  ).toBeVisible();
  await evidence
    .getByRole("button", { name: "Hide full interview transcript" })
    .click();
  await expect(evidence.getByRole("list")).not.toBeVisible();
});
