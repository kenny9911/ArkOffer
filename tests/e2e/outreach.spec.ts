import { test, expect } from "./fixtures";

test("sequence preview, explicit local launch, persisted outbox, pause and manual reply work end to end", async ({
  page,
  baseURL,
}) => {
  const headers = { Origin: new URL(baseURL!).origin };
  const signup = await page.request.post("/api/auth/signup", {
    headers,
    data: {
      name: "Outreach Owner",
      email: `outreach-${Date.now()}@example.com`,
      password: "LocalTestPass987!",
      workspaceName: "Outreach Team",
      seedDemo: false,
    },
  });
  expect(signup.ok()).toBeTruthy();
  const candidateResponse = await page.request.post("/api/candidates", {
    headers,
    data: {
      name: "Alex Example",
      email: "alex@example.com",
      company: "Example Labs",
      role: "Engineer",
    },
  });
  expect(candidateResponse.ok()).toBeTruthy();
  const candidate = (await candidateResponse.json()).item;
  const sequenceResponse = await page.request.post("/api/sequences", {
    headers,
    data: {
      name: "Personalized engineering",
      enrolledCandidateIds: [candidate.id],
      steps: [
        {
          subject: "Hello {{firstName}}",
          body: "Your work at {{company}} caught our attention. — {{senderName}}",
          delayDays: 0,
        },
        {
          subject: "Following up",
          body: "Would you like to talk?",
          delayDays: 2,
        },
      ],
    },
  });
  expect(sequenceResponse.ok()).toBeTruthy();
  const sequence = (await sequenceResponse.json()).item;
  await page.goto("/app/sequences");
  await page.getByRole("link", { name: /Personalized engineering/ }).click();
  await page
    .getByRole("button", { name: "Review delivery", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("No email is sent to candidates.");
  await dialog.getByText("Alex Example", { exact: true }).click();
  await expect(dialog).toContainText("Hello Alex");
  await expect(dialog).toContainText("Example Labs");
  const launch = dialog.getByRole("button", {
    name: "Queue in local outbox",
    exact: true,
  });
  await expect(launch).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await launch.click();
  await expect(dialog).toContainText("Sequence queued in the local outbox.");
  await expect
    .poll(
      async () => {
        const result = await page.request.get(
          `/api/sequences/${sequence.id}/delivery`,
        );
        return (await result.json()).messages[0].status;
      },
      { timeout: 22000 },
    )
    .toBe("outbox");
  await dialog
    .getByRole("button", { name: "Refresh delivery", exact: true })
    .click();
  await expect(dialog).toContainText("Local outbox · not delivered");
  await dialog
    .getByRole("button", { name: "Step 1: Hello Alex", exact: true })
    .click();
  await expect(dialog).toContainText("Unsubscribe from Outreach Team");
  await dialog.getByRole("button", { name: "Pause all", exact: true }).click();
  await expect(dialog.getByText("Paused", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Resume all", exact: true }).click();
  await expect(dialog.getByText("Active", { exact: true })).toBeVisible();
  await dialog
    .getByRole("button", { name: "Mark replied", exact: true })
    .click();
  await expect(
    dialog.getByText("Reply recorded", { exact: true }),
  ).toBeVisible();
  await expect(dialog).toContainText("Cancelled");
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await page.reload();
  await page
    .getByRole("button", { name: "Review delivery", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Activity/ })
    .click();
  await expect(
    page.getByRole("dialog").getByText("Reply recorded", { exact: true }),
  ).toBeVisible();
});
