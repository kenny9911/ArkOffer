import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

async function fixture(
  page: Page,
  baseURL: string | undefined,
  canDelete = true,
  playableVideo = false,
) {
  const headers = { Origin: new URL(baseURL!).origin };
  const signup = await page.request.post("/api/auth/signup", {
    headers,
    data: {
      name: "Recording reviewer",
      email: `recording-${crypto.randomUUID()}@example.test`,
      password: "RecordingReviewTests987!",
      workspaceName: "Synthetic recording reviews",
      seedDemo: false,
    },
  });
  expect(signup.ok(), await signup.text()).toBeTruthy();
  const create = await page.request.post("/api/screenings", {
    headers,
    data: {
      name: "Recorded engineering interview",
      title: "Recorded engineering interview",
      description: "Synthetic test",
      status: "draft",
      questions: [
        {
          prompt: "Describe a project.",
          type: "text",
          required: true,
          options: [],
          rubric: "",
        },
      ],
    },
  });
  expect(create.ok(), await create.text()).toBeTruthy();
  const screening = (await create.json()).item;
  const publish = await page.request.post(
    `/api/screenings/${screening.id}/publish`,
    { headers, data: {} },
  );
  expect(publish.ok(), await publish.text()).toBeTruthy();
  const publication = (await publish.json()).item;
  const form = (
    await (
      await page.request.get(`/api/interviews/${publication.token}`)
    ).json()
  ).item;
  const submit = await page.request.post(
    `/api/interviews/${publication.token}/responses`,
    {
      headers,
      data: {
        candidateName: "Alex Example",
        email: "alex@example.test",
        consent: true,
        answers: [
          {
            questionId: form.questions[0].id,
            value: "I developed a TypeScript service.",
          },
        ],
      },
    },
  );
  expect(submit.status(), await submit.text()).toBe(201);
  const state = {
    recording: "ready",
    requests: 0,
    deletes: 0,
    media: 0,
    fail: false,
    transcriptFailure: false,
    legacyTiming: false,
  };
  await page.route(
    `**/api/screenings/${screening.id}/responses`,
    async (route) => {
      const response = await route.fetch(),
        data = await response.json();
      data.items[0].liveSessionId = "synthetic-session";
      data.items[0].answers[0].liveEvidence = {
        sessionId: "synthetic-session",
        consentAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        originalTranscript: "I developed a TypeScript service.",
        candidateEdited: false,
      };
      await route.fulfill({ response, json: data });
    },
  );
  await page.route(
    `**/api/screenings/${screening.id}/responses/*/recordings**`,
    async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/transcript")) {
        if (state.transcriptFailure)
          return route.fulfill({
            status: 503,
            json: { error: "Synthetic transcript outage" },
          });
        return route.fulfill({
          json: {
            synchronization: "approximate-utterance",
            items: playableVideo
              ? [
                  {
                    id: "prompt",
                    kind: "agent",
                    text: "Describe a project.",
                    startSeconds: state.legacyTiming ? null : 0,
                    endSeconds: state.legacyTiming ? null : 2,
                  },
                  {
                    id: "answer",
                    kind: "answer",
                    text: "Original speech about a search service.",
                    startSeconds: state.legacyTiming ? null : 2,
                    endSeconds: state.legacyTiming ? null : 6,
                  },
                  {
                    id: "legacy",
                    kind: "followup-answer",
                    text: "Untimed clarification from an older agent.",
                    startSeconds: null,
                    endSeconds: null,
                  },
                ]
              : [],
          },
        });
      }
      if (url.pathname.endsWith("/media")) {
        state.media++;
        // Generated locally from a solid color, with no camera/microphone data.
        if (playableVideo) {
          const bytes = readFileSync(
            new URL("./assets/synthetic-interview.mp4", import.meta.url),
          );
          const range = /bytes=(\d+)-(\d*)/.exec(
            route.request().headers().range || "",
          );
          const start = range ? Number(range[1]) : 0;
          const end = range?.[2]
            ? Math.min(Number(range[2]), bytes.length - 1)
            : bytes.length - 1;
          return route.fulfill({
            status: range ? 206 : 200,
            contentType: "video/mp4",
            headers: {
              "Accept-Ranges": "bytes",
              ...(range
                ? { "Content-Range": `bytes ${start}-${end}/${bytes.length}` }
                : {}),
            },
            body: bytes.subarray(start, end + 1),
          });
        }
        return route.fulfill({
          status: 503,
          json: { error: "Synthetic storage outage" },
        });
      }
      if (route.request().method() === "DELETE") {
        state.deletes++;
        state.recording = "deleting";
        return route.fulfill({
          status: 202,
          json: { ok: true, state: "deleting" },
        });
      }
      state.requests++;
      if (state.fail)
        return route.fulfill({
          status: 503,
          json: { error: "Could not load recordings. Try again." },
        });
      return route.fulfill({
        json: {
          canDelete,
          items: [
            {
              id: "synthetic-recording",
              state: state.recording,
              consentAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 86400000).toISOString(),
              durationSeconds: 240,
              bytes: 8388608,
              playable: state.recording === "ready",
            },
          ],
        },
      });
    },
  );
  await page.goto(`/app/screening/${screening.id}?tab=candidates`);
  await page.getByRole("button", { name: "Alex Example", exact: true }).click();
  const region = page.getByRole("region", {
    name: "Interview recordings",
    exact: true,
  });
  await region
    .getByRole("button", { name: "View interview recordings", exact: true })
    .click();
  return { state, region };
}

test("recording review provides private playback, failure feedback and explicit permanent deletion", async ({
  page,
  baseURL,
}, testInfo) => {
  const { state, region } = await fixture(page, baseURL);
  await expect(region).toContainText("4 minutes · 8.0 MB");
  expect(state.media).toBe(0);
  await region
    .getByRole("button", { name: "Play recording", exact: true })
    .click();
  await expect(
    region.getByLabel("Interview recording 1", { exact: true }),
  ).toHaveAttribute(
    "src",
    /\/api\/screenings\/.*\/recordings\/synthetic-recording\/media$/,
  );
  await expect(region.getByRole("alert")).toContainText("could not be loaded");
  await expect(
    region.getByRole("link", { name: "Download MP4" }),
  ).toHaveAttribute("href", /\/media\?download=1$/);
  await region
    .getByRole("button", { name: "Delete recording", exact: true })
    .click();
  expect(state.deletes).toBe(0);
  await region
    .getByRole("button", { name: "Keep recording", exact: true })
    .click();
  expect(state.deletes).toBe(0);
  await region
    .getByRole("button", { name: "Delete recording", exact: true })
    .click();
  await region
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  await expect(region).toContainText("Access has been removed");
  await expect(region.locator("video")).toHaveCount(0);
  await expect(region.getByRole("link", { name: "Download MP4" })).toHaveCount(
    0,
  );
  expect(state.deletes).toBe(1);
  state.recording = "deleted";
  await region.getByRole("button", { name: "Refresh recordings" }).click();
  await expect(region).toContainText("The stored recording has been deleted");
  await region.screenshot({
    path: testInfo.outputPath("recording-review-deleted.png"),
  });
});

test("recording viewer respects role controls and unavailable or expired assets", async ({
  page,
  baseURL,
}) => {
  const { state, region } = await fixture(page, baseURL, false);
  await expect(
    region.getByRole("button", { name: "Play recording" }),
  ).toBeVisible();
  await expect(
    region.getByRole("button", { name: "Delete recording" }),
  ).toHaveCount(0);
  state.recording = "processing";
  await region.getByRole("button", { name: "Refresh recordings" }).click();
  await expect(region).toContainText("recording is being processed");
  await expect(
    region.getByRole("button", { name: "Play recording" }),
  ).toHaveCount(0);
  state.recording = "expired";
  await region.getByRole("button", { name: "Refresh recordings" }).click();
  await expect(region).toContainText("reached its retention limit");
  await expect(region.getByRole("link", { name: "Download MP4" })).toHaveCount(
    0,
  );
});

test("recording metadata failure can be retried without discarding candidate review", async ({
  page,
  baseURL,
}) => {
  const { state, region } = await fixture(page, baseURL);
  await expect(
    region.getByRole("button", { name: "Play recording" }),
  ).toBeVisible();
  state.fail = true;
  await region.getByRole("button", { name: "Refresh recordings" }).click();
  await expect(region.getByRole("alert")).toContainText("Try again");
  state.fail = false;
  await region.getByRole("button", { name: "Refresh recordings" }).click();
  await expect(region.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByRole("complementary", { name: "Review Alex Example" }),
  ).toContainText("I developed a TypeScript service");
});

test("video transcript supports real media seeking, active-turn highlighting, search and keyboard controls", async ({
  page,
  baseURL,
}, testInfo) => {
  const { region } = await fixture(page, baseURL, true, true);
  await region
    .getByRole("button", { name: "Play recording", exact: true })
    .click();
  const media = region.locator("video");
  await expect
    .poll(() =>
      media.evaluate((element: HTMLVideoElement) => element.readyState),
    )
    .toBeGreaterThan(0);
  await expect(region.getByRole("status")).toContainText("3 transcript turns");
  await region
    .getByRole("button", {
      name: "Seek to 0:02 Candidate: Original speech about a search service.",
      exact: true,
    })
    .click();
  await expect
    .poll(() =>
      media.evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeCloseTo(2, 0);
  await expect(region.locator('[aria-current="true"]')).toContainText(
    "Original speech about a search service",
  );
  await expect(region).toContainText(
    "Submitted answers may include candidate corrections",
  );
  await region
    .getByRole("searchbox", { name: "Search recording transcript" })
    .fill("search service");
  await expect(region.getByRole("status")).toContainText(
    "1 transcript turn match your search",
  );
  await expect(
    region
      .getByRole("list", { name: "Synchronized interview transcript" })
      .getByRole("listitem"),
  ).toHaveCount(1);
  await region.getByRole("searchbox").fill("nothing matches this");
  await expect(region.getByRole("status")).toContainText("0 transcript turns");
  await region.getByRole("searchbox").fill("");
  await expect(
    region.getByText("Timing unavailable", { exact: true }),
  ).toHaveCount(1);
  await region.getByLabel("Playback speed").selectOption("1.5");
  expect(
    await media.evaluate((element: HTMLVideoElement) => element.playbackRate),
  ).toBe(1.5);
  const controls = region.getByRole("group", {
    name: "Video playback controls",
  });
  await controls.focus();
  await controls.press("ArrowRight");
  await expect
    .poll(() =>
      media.evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeCloseTo(12, 0);
  await expect(region.locator('[aria-current="true"]')).toHaveCount(0);
  await controls.press("ArrowLeft");
  await expect
    .poll(() =>
      media.evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeCloseTo(2, 0);
  await controls.press("k");
  await expect(
    region.getByRole("button", { name: "Pause video", exact: true }),
  ).toBeVisible();
  await controls.press(" ");
  await expect(
    region.getByRole("button", { name: "Play video", exact: true }),
  ).toBeVisible();
  await region.getByRole("checkbox", { name: "Follow playback" }).uncheck();
  await region.screenshot({
    path: testInfo.outputPath("synchronized-interview-playback.png"),
  });
  await region.getByRole("button", { name: "Close player" }).click();
  await expect(media).toHaveCount(0);
});

test("legacy timing and transcript failures remain readable and recover without fabricated offsets", async ({
  page,
  baseURL,
}) => {
  const { state, region } = await fixture(page, baseURL, true, true);
  state.transcriptFailure = true;
  await region
    .getByRole("button", { name: "Play recording", exact: true })
    .click();
  await expect(region.getByRole("alert")).toContainText(
    "Synthetic transcript outage",
  );
  state.transcriptFailure = false;
  state.legacyTiming = true;
  await region
    .getByRole("button", { name: "Retry recording transcript" })
    .click();
  await expect(region).toContainText(
    "Timing is unavailable for this recording",
  );
  await expect(region.getByRole("button", { name: /^Seek to/ })).toHaveCount(0);
  await expect(region.getByRole("listitem")).toHaveCount(3);
  await expect(region.locator("video")).toBeVisible();
});
