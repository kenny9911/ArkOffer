import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
const token = "b".repeat(64),
  questionId = "10000000-0000-4000-8000-000000000099",
  sessionId = "20000000-0000-4000-8000-000000000099";
async function mock(
  page: Page,
  options: {
    available?: boolean;
    deferred?: boolean;
    previous?: boolean;
    recording?: boolean;
    followup?: boolean;
    skipped?: boolean;
  } = {},
) {
  const state = { requests: [] as unknown[], submission: null as unknown };
  await page.addInitScript(
    ({ deferred }) => {
      const state = {
        requested: 0,
        stopped: 0,
        resolve: null as null | (() => void),
        audio: [] as AudioContext[],
      };
      Object.assign(window, { liveTest: state });
      function stream(constraints: MediaStreamConstraints) {
        const result = new MediaStream();
        if (constraints.audio) {
          const context = new AudioContext();
          const destination = context.createMediaStreamDestination();
          state.audio.push(context);
          destination.stream
            .getTracks()
            .forEach((track) => result.addTrack(track));
        }
        if (constraints.video) {
          const canvas = document.createElement("canvas");
          canvas.width = 640;
          canvas.height = 360;
          canvas.getContext("2d")!.fillRect(0, 0, 640, 360);
          const captured = (
            canvas as HTMLCanvasElement & { captureStream: () => MediaStream }
          ).captureStream();
          captured.getTracks().forEach((track) => result.addTrack(track));
        }
        for (const track of result.getTracks()) {
          const stop = track.stop.bind(track);
          track.stop = () => {
            state.stopped++;
            stop();
          };
        }
        return result;
      }
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: (constraints: MediaStreamConstraints) => {
          state.requested++;
          if (deferred)
            return new Promise((resolve) => {
              state.resolve = () => resolve(stream(constraints));
            });
          return Promise.resolve(stream(constraints));
        },
      });
      Object.defineProperty(navigator.mediaDevices, "enumerateDevices", {
        configurable: true,
        value: async () => [],
      });
    },
    { deferred: options.deferred || false },
  );
  const liveSession = {
    id: sessionId,
    state: "active",
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    events: options.skipped
      ? [{ id: "skip-1", kind: "skip", questionId, text: "Skip please" }]
      : [
          {
            id: "event-1",
            kind: "answer",
            questionId,
            text: "I built a TypeScript API.",
          },
          ...(options.followup
            ? [
                {
                  id: "follow-1",
                  kind: "followup-question",
                  questionId,
                  text: "What did you personally contribute to the API?",
                },
                {
                  id: "follow-2",
                  kind: "followup-answer",
                  questionId,
                  text: "I implemented the request validation.",
                },
              ]
            : []),
        ],
  };
  await page.route("**/api/interviews/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/voice"))
      return route.fulfill({ json: { available: false } });
    if (path.endsWith("/live/status"))
      return route.fulfill({
        json: {
          enabled: true,
          available: options.available !== false,
          cameraPolicy: "optional",
          recording: !!options.recording,
          recordingRetentionDays: 7,
          reason:
            "Live interviewing is not configured for this hiring team. You can complete the questionnaire below.",
          previousSession: options.previous ? liveSession : null,
        },
      });
    if (path.endsWith("/live/sessions")) {
      state.requests.push(route.request().postDataJSON());
      return route.fulfill({
        status: 503,
        json: {
          error:
            "The live interviewer could not connect. Please use the questionnaire.",
        },
      });
    }
    if (path.endsWith("/end"))
      return route.fulfill({
        json: { item: { ...liveSession, state: "ended" } },
      });
    if (path.endsWith("/responses")) {
      state.submission = route.request().postDataJSON();
      return route.fulfill({ status: 201, json: { ok: true } });
    }
    return route.fulfill({
      json: {
        item: {
          title: "Live Platform Engineer Screening",
          description: "A synthetic interview",
          workspaceName: "Synthetic Hiring Team",
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          questions: [
            {
              id: questionId,
              prompt: "Describe a service you built.",
              type: "text",
              options: [],
              required: true,
            },
          ],
        },
        submitted: false,
      },
    });
  });
  await page.goto(`/interviews/${token}`);
  return state;
}
async function mediaState(page: Page) {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          liveTest: {
            requested: number;
            stopped: number;
            resolve: null | (() => void);
          };
        }
      ).liveTest,
  );
}
test("unconfigured live interview leaves the questionnaire usable and never asks for devices", async ({
  page,
}) => {
  await mock(page, { available: false });
  await expect(
    page.getByText("Live interviewing is not configured", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Check camera and microphone" }),
  ).toHaveCount(0);
  expect((await mediaState(page)).requested).toBe(0);
  await page
    .getByLabel("Describe a service you built.", { exact: false })
    .fill("I built a search API.");
});
test("late device permission is cleaned up after cancelling preview", async ({
  page,
}) => {
  await mock(page, { deferred: true });
  await page
    .getByRole("button", { name: "Check camera and microphone" })
    .click();
  await expect.poll(async () => (await mediaState(page)).requested).toBe(1);
  await page.getByRole("button", { name: "Cancel device check" }).click();
  await page.evaluate(() =>
    (
      window as unknown as { liveTest: { resolve: () => void } }
    ).liveTest.resolve(),
  );
  await expect
    .poll(async () => (await mediaState(page)).stopped)
    .toBeGreaterThan(0);
  await expect(
    page.getByRole("button", { name: "Start live interview" }),
  ).toHaveCount(0);
});
test("device preview requires consent, provider failure stops devices and preserves typed answers", async ({
  page,
}, testInfo) => {
  const state = await mock(page);
  await page
    .getByLabel("Describe a service you built.", { exact: false })
    .fill("My original typed answer.");
  await page
    .getByRole("button", { name: "Check camera and microphone" })
    .click();
  await expect(
    page.getByRole("button", { name: "Start live interview" }),
  ).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath("live-interview-preview.png"),
    fullPage: true,
  });
  await page
    .getByRole("checkbox", {
      name: "I agree to share my microphone",
      exact: false,
    })
    .check();
  await page.getByRole("button", { name: "Start live interview" }).click();
  await expect(page.getByRole("alert")).toContainText("could not connect");
  expect(state.requests).toHaveLength(1);
  expect(state.requests[0]).toMatchObject({
    consent: true,
    cameraEnabled: true,
  });
  await expect
    .poll(async () => (await mediaState(page)).stopped)
    .toBeGreaterThan(0);
  await expect(
    page.getByLabel("Describe a service you built.", { exact: false }),
  ).toHaveValue("My original typed answer.");
});
test("interrupted interview recovers saved transcript for explicit review and manual submission", async ({
  page,
}) => {
  const state = await mock(page, { previous: true });
  await page.getByRole("button", { name: "Close previous interview" }).click();
  await expect(
    page.getByText("I built a TypeScript API.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Describe a service you built.", { exact: false }),
  ).toHaveValue("");
  await page
    .getByRole("button", { name: "Use transcript in my answers" })
    .click();
  await expect(
    page.getByLabel("Describe a service you built.", { exact: false }),
  ).toHaveValue("I built a TypeScript API.");
  await page
    .getByLabel("Describe a service you built.", { exact: false })
    .fill("I built and maintained a TypeScript API.");
  await page.getByLabel("Full name").fill("Synthetic Candidate");
  await page
    .getByLabel("Email address", { exact: true })
    .fill("synthetic@example.test");
  await page
    .getByRole("checkbox", {
      name: /I agree to share my name, email address and responses/i,
    })
    .check();
  await page.getByRole("button", { name: "Submit responses" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Thank you for sharing your experience.",
    }),
  ).toBeVisible();
  expect(state.submission).toMatchObject({
    liveSessionId: sessionId,
    answers: [
      { questionId, value: "I built and maintained a TypeScript API." },
    ],
  });
  expect((await mediaState(page)).requested).toBe(0);
});

test("removed capability does not trap an interrupted candidate behind disabled submission", async ({
  page,
}) => {
  const state = await mock(page, { available: false, previous: true });
  await page
    .getByLabel("Describe a service you built.", { exact: false })
    .fill("Typed fallback answer.");
  await page.getByLabel("Full name").fill("Synthetic Candidate");
  await page
    .getByLabel("Email address", { exact: true })
    .fill("synthetic@example.test");
  await page
    .getByRole("checkbox", {
      name: /I agree to share my name, email address and responses/i,
    })
    .check();
  await expect(
    page.getByRole("button", { name: "Submit responses" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Submit responses" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Thank you for sharing your experience.",
    }),
  ).toBeVisible();
  expect(state.submission).toMatchObject({
    answers: [{ questionId, value: "Typed fallback answer." }],
  });
  expect((await mediaState(page)).requested).toBe(0);
});

test("recording requires its own consent before any provider start", async ({
  page,
}) => {
  const state = await mock(page, { recording: true });
  await page
    .getByRole("button", { name: "Check camera and microphone" })
    .click();
  await page
    .getByRole("checkbox", {
      name: "I agree to share my microphone",
      exact: false,
    })
    .check();
  await expect(
    page.getByRole("button", { name: "Start live interview" }),
  ).toBeDisabled();
  expect(state.requests).toHaveLength(0);
  await page.getByRole("checkbox", { name: /I agree to record/ }).check();
  await page.getByRole("button", { name: "Start live interview" }).click();
  await expect(page.getByRole("alert")).toContainText("could not connect");
  expect(state.requests[0]).toMatchObject({
    consent: true,
    recordingConsent: true,
  });
});

test("adaptive answers remain linked to the original question for candidate review", async ({
  page,
}) => {
  await mock(page, { previous: true, followup: true });
  await page.getByRole("button", { name: "Close previous interview" }).click();
  await expect(
    page.getByText("What did you personally contribute to the API?", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Use transcript in my answers" })
    .click();
  await expect(
    page.getByLabel("Describe a service you built.", { exact: false }),
  ).toHaveValue(
    "I built a TypeScript API.\nI implemented the request validation.",
  );
});

test("all skipped live answers can attach the session without overwriting typed answers", async ({
  page,
}) => {
  const state = await mock(page, {
    previous: true,
    skipped: true,
    recording: true,
  });
  await page.getByRole("button", { name: "Close previous interview" }).click();
  await page
    .getByLabel("Describe a service you built.", { exact: false })
    .fill("Typed final answer.");
  await page
    .getByRole("button", { name: "Use transcript in my answers" })
    .click();
  await expect(
    page.getByLabel("Describe a service you built.", { exact: false }),
  ).toHaveValue("Typed final answer.");
  await page.getByLabel("Full name").fill("Synthetic Candidate");
  await page
    .getByLabel("Email address", { exact: true })
    .fill("synthetic@example.test");
  await page
    .getByRole("checkbox", {
      name: /I agree to share my name, email address and responses/i,
    })
    .check();
  await page.getByRole("button", { name: "Submit responses" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Thank you for sharing your experience.",
    }),
  ).toBeVisible();
  expect(state.submission).toMatchObject({
    liveSessionId: sessionId,
    answers: [{ questionId, value: "Typed final answer." }],
  });
});
