import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures";

const token = "a".repeat(64);
const questionId = "10000000-0000-4000-8000-000000000001";
const questionTwo = "10000000-0000-4000-8000-000000000002";
const turnId = "20000000-0000-4000-8000-000000000001";
const followupTurnId = "20000000-0000-4000-8000-000000000002";
async function mockInterview(
  page: Page,
  mode: "normal" | "deferred" | "denied" = "normal",
) {
  // Fake audio nodes supply synthetic samples. No real microphone or provider is accessed.
  await page.addInitScript(
    ({ mode }) => {
      const state = {
        requested: 0,
        stopped: 0,
        closed: 0,
        spoken: [] as string[],
        resolvePermission: null as null | (() => void),
        rejectPermission: null as null | (() => void),
        processors: [] as {
          onaudioprocess: ((event: unknown) => void) | null;
        }[],
      };
      Object.assign(window, { voiceTest: state });
      const stream = () => ({
        getTracks: () => [
          {
            stop: () => {
              state.stopped++;
            },
          },
        ],
      });
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: () => {
            state.requested++;
            if (mode === "denied")
              return Promise.reject(new Error("permission denied"));
            if (mode === "deferred")
              return new Promise((resolve, reject) => {
                state.resolvePermission = () => resolve(stream());
                state.rejectPermission = () =>
                  reject(new Error("permission denied"));
              });
            return Promise.resolve(stream());
          },
        },
      });
      class FakeContext {
        sampleRate = 16000;
        destination = {};
        state = "running";
        resume() {
          return Promise.resolve();
        }
        close() {
          this.state = "closed";
          state.closed++;
          return Promise.resolve();
        }
        createMediaStreamSource() {
          return { connect() {}, disconnect() {} };
        }
        createScriptProcessor() {
          const processor = {
            onaudioprocess: null as null | ((event: unknown) => void),
            connect() {
              queueMicrotask(() => {
                processor.onaudioprocess?.({
                  inputBuffer: {
                    getChannelData: () => new Float32Array(16000).fill(0.1),
                  },
                });
              });
            },
            disconnect() {},
          };
          state.processors.push(processor);
          return processor;
        }
      }
      Object.defineProperty(window, "AudioContext", {
        configurable: true,
        value: FakeContext,
      });
      Object.defineProperty(window, "SpeechSynthesisUtterance", {
        configurable: true,
        value: class {
          constructor(public text: string) {}
        },
      });
      Object.defineProperty(window, "speechSynthesis", {
        configurable: true,
        value: {
          cancel() {},
          getVoices: () => [{ localService: true }],
          speak: (utterance: { text: string }) =>
            state.spoken.push(utterance.text),
        },
      });
    },
    { mode },
  );
  await page.route(`**/api/interviews/${token}`, (route) =>
    route.fulfill({
      json: {
        item: {
          title: "Product voice interview",
          description: "Share your work experience.",
          workspaceName: "Hiring Team",
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          questions: [
            {
              id: questionId,
              prompt: "Describe your product experience.",
              type: "text",
              options: [],
              required: true,
            },
            {
              id: questionTwo,
              prompt: "Can you use Figma?",
              type: "yes-no",
              options: [],
              required: true,
            },
          ],
        },
        submitted: false,
      },
    }),
  );
  await page.route(`**/api/interviews/${token}/voice`, (route) =>
    route.fulfill({
      json: { available: true, provider: "OpenAI", clarification: true },
    }),
  );
  await page.goto(`/interviews/${token}`);
}
async function start(page: Page) {
  await expect(
    page.getByRole("button", { name: "Start guided voice interview" }),
  ).toBeDisabled();
  await page.getByLabel("I agree to send my voice answers").check();
  await page
    .getByRole("button", { name: "Start guided voice interview" })
    .click();
}
async function state(page: Page) {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          voiceTest: {
            requested: number;
            stopped: number;
            closed: number;
            spoken: string[];
          };
        }
      ).voiceTest,
  );
}

test("guided voice consent, narration, transcription, optional follow-up, correction and final review", async ({
  page,
}) => {
  await mockInterview(page);
  let recordings = 0,
    submitted: unknown;
  await page.route(
    `**/api/interviews/${token}/voice/transcriptions`,
    async (route) => {
      const body = route.request().postDataBuffer()!.toString();
      expect(body).toContain("audio/wav");
      expect(body).toContain(questionId);
      expect(body).toContain('name="consent"\r\n\r\ntrue');
      recordings++;
      if (recordings === 1)
        await route.fulfill({
          status: 201,
          json: {
            turnId,
            text: "I designed onboarding.",
            durationMs: 1000,
            followup: "What did you learn?",
          },
        });
      else {
        expect(body).toContain(turnId);
        await route.fulfill({
          status: 201,
          json: {
            turnId: followupTurnId,
            text: "I designed onboarding.\n\nFollow-up: What did you learn?\nI tested clarity.",
            answerText: "I tested clarity.",
            followupAnswered: "What did you learn?",
            durationMs: 2000,
            followup: null,
          },
        });
      }
    },
  );
  await page.route(`**/api/interviews/${token}/responses`, async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({ status: 201, json: { ok: true } });
  });
  expect((await state(page)).requested).toBe(0);
  await start(page);
  await page
    .getByRole("button", { name: "Read question aloud", exact: true })
    .click();
  expect((await state(page)).spoken).toEqual([
    "Describe your product experience.",
  ]);
  await page
    .getByRole("button", { name: "Record answer", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Recording");
  await page.getByRole("button", { name: "Stop and transcribe" }).click();
  await expect(page.getByLabel("Review your answer")).toHaveValue(
    "I designed onboarding.",
  );
  await expect(page.getByLabel("Optional AI follow-up")).toContainText(
    "What did you learn?",
  );
  await page
    .getByLabel("Review your answer")
    .fill("I designed and tested onboarding.");
  await page.getByRole("button", { name: "Record follow-up answer" }).click();
  await page.getByRole("button", { name: "Stop and transcribe" }).click();
  await expect(page.getByLabel("Review your answer")).toHaveValue(
    "I designed and tested onboarding.\n\nFollow-up: What did you learn?\nI tested clarity.",
  );
  expect((await state(page)).stopped).toBe(2);
  expect((await state(page)).closed).toBe(2);
  await page.getByRole("button", { name: "Next question" }).click();
  await page.getByLabel("Your answer", { exact: true }).selectOption("Yes");
  await page.getByLabel("Full name").fill("Candidate Example");
  await page
    .getByLabel("Email address", { exact: true })
    .fill("candidate@example.com");
  await page.getByLabel("I agree to share my name").check();
  await page.getByRole("button", { name: "Submit responses" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Thank you for sharing your experience.",
    }),
  ).toBeVisible();
  expect(submitted).toMatchObject({
    voiceEvidence: [{ questionId, turnId: followupTurnId }],
    answers: [
      {
        questionId,
        value:
          "I designed and tested onboarding.\n\nFollow-up: What did you learn?\nI tested clarity.",
      },
      { questionId: questionTwo, value: "Yes" },
    ],
  });
});

test("cancelled or abandoned microphone permission stops a late stream without uploading", async ({
  page,
}) => {
  await mockInterview(page, "deferred");
  let uploads = 0;
  await page.route(
    `**/api/interviews/${token}/voice/transcriptions`,
    (route) => {
      uploads++;
      return route.abort();
    },
  );
  await start(page);
  await page
    .getByRole("button", { name: "Record answer", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Waiting for microphone permission",
  );
  await page.getByRole("button", { name: "Cancel recording" }).click();
  await page.evaluate(() =>
    (
      window as unknown as { voiceTest: { resolvePermission: () => void } }
    ).voiceTest.resolvePermission(),
  );
  await expect.poll(async () => (await state(page)).stopped).toBe(1);
  await expect(page.getByRole("status")).toContainText("Microphone off");
  expect(uploads).toBe(0);
  await page
    .getByRole("button", { name: "Record answer", exact: true })
    .click();
  await page.getByRole("button", { name: "Use written questionnaire" }).click();
  await page.evaluate(() =>
    (
      window as unknown as { voiceTest: { resolvePermission: () => void } }
    ).voiceTest.resolvePermission(),
  );
  await expect.poll(async () => (await state(page)).stopped).toBe(2);
  await expect(
    page.getByRole("button", { name: "Start guided voice interview" }),
  ).toBeDisabled();
  expect(uploads).toBe(0);
});

test("recording cancellation releases microphone and context and preserves typed fallback", async ({
  page,
}) => {
  await mockInterview(page);
  await start(page);
  await page
    .getByRole("button", { name: "Record answer", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Recording");
  await page.getByRole("button", { name: "Use written questionnaire" }).click();
  expect((await state(page)).stopped).toBe(1);
  expect((await state(page)).closed).toBe(1);
  await page
    .getByLabel("Describe your product experience.", { exact: false })
    .fill("A typed alternative.");
  await expect(
    page.getByLabel("Describe your product experience.", { exact: false }),
  ).toHaveValue("A typed alternative.");
});

test("permission denial and revoked-link transcription failures show a useful written fallback", async ({
  page,
}) => {
  await mockInterview(page, "denied");
  await start(page);
  await page
    .getByRole("button", { name: "Record answer", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Microphone access was unavailable",
  );
  await page
    .getByLabel("Review your answer")
    .fill("I can still type my answer.");
  await expect(
    page.getByRole("button", { name: "Next question" }),
  ).toBeEnabled();
});

test("unmounting an interview releases recording and discards late permission", async ({
  page,
}) => {
  await mockInterview(page, "deferred");
  await start(page);
  await page
    .getByRole("button", { name: "Record answer", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Waiting for microphone permission",
  );
  await page.evaluate(() => {
    history.pushState({}, "", "/interviews/invalid");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(
    page.getByRole("heading", { name: "This link is unavailable" }),
  ).toBeVisible();
  await page.evaluate(() =>
    (
      window as unknown as { voiceTest: { resolvePermission: () => void } }
    ).voiceTest.resolvePermission(),
  );
  await expect.poll(async () => (await state(page)).stopped).toBe(1);
});

test("revoked-link responses leave microphone off and allow typed review", async ({
  page,
}) => {
  await mockInterview(page);
  await start(page);
  await page.route(`**/api/interviews/${token}/voice/transcriptions`, (route) =>
    route.fulfill({
      status: 404,
      json: { error: "This screening link is unavailable or has expired." },
    }),
  );
  await page
    .getByRole("button", { name: "Record answer", exact: true })
    .click();
  await page.getByRole("button", { name: "Stop and transcribe" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "This screening link is unavailable",
  );
  expect((await state(page)).stopped).toBe(1);
  await page
    .getByLabel("Review your answer")
    .fill("My typed answer is still editable.");
  await expect(page.getByRole("status")).toContainText("Microphone off");
});
