import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

type Edit = {
  id: string;
  title: string;
  revision: number;
  segments: { startSeconds: number; endSeconds: number; muted: boolean }[];
  createdAt: string;
  updatedAt: string;
};
type Job = {
  id: string;
  kind: "alignment" | "export";
  state: string;
  editId: string | null;
  editTitle: string | null;
  editRevision: number | null;
  createdAt: string;
  error: string | null;
};
async function fixture(
  page: Page,
  baseURL: string | undefined,
  canEdit = true,
  available = true,
) {
  const headers = { Origin: new URL(baseURL!).origin };
  const signup = await page.request.post("/api/auth/signup", {
    headers,
    data: {
      name: "Studio reviewer",
      email: `studio-${crypto.randomUUID()}@example.test`,
      password: "StudioReviewTests987!",
      workspaceName: "Synthetic studio",
      seedDemo: false,
    },
  });
  expect(signup.ok(), await signup.text()).toBeTruthy();
  const create = await page.request.post("/api/screenings", {
    headers,
    data: {
      name: "Studio interview",
      title: "Studio interview",
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
        candidateName: "Studio Candidate",
        email: "synthetic@example.test",
        consent: true,
        answers: [
          { questionId: form.questions[0].id, value: "I built a service." },
        ],
      },
    },
  );
  expect(submit.status(), await submit.text()).toBe(201);
  const now = new Date().toISOString();
  const state = {
    edits: [] as Edit[],
    jobs: [] as Job[],
    studioGets: 0,
    transcriptGets: 0,
    alignmentPosts: 0,
    alignmentKeys: [] as string[],
    failAlignmentResponse: false,
    exports: 0,
    cancelled: [] as string[],
    conflict: false,
    aligned: true,
  };
  await page.route(
    `**/api/screenings/${screening.id}/responses`,
    async (route) => {
      const response = await route.fetch(),
        data = await response.json();
      data.items[0].liveSessionId = "synthetic-session";
      await route.fulfill({ response, json: data });
    },
  );
  await page.route(
    `**/api/screenings/${screening.id}/responses/*/recordings**`,
    async (route) => {
      const url = new URL(route.request().url()),
        method = route.request().method();
      const path = url.pathname;
      if (path.endsWith("/media")) {
        const bytes = readFileSync(
          new URL("./assets/synthetic-interview.mp4", import.meta.url),
        );
        const range = /bytes=(\d+)-(\d*)/.exec(
            route.request().headers().range || "",
          ),
          start = range ? Number(range[1]) : 0,
          end = range?.[2]
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
      if (path.endsWith("/transcript")) {
        state.transcriptGets++;
        return route.fulfill({
          json: {
            synchronization: "approximate-utterance",
            items: [
              {
                id: "answer",
                kind: "answer",
                text: "I built a service. Unmatched!",
                startSeconds: 2,
                endSeconds: 8,
                ...(state.aligned
                  ? {
                      tokens: [
                        { text: "I", startSeconds: 2, endSeconds: 2.3 },
                        { text: " ", startSeconds: null, endSeconds: null },
                        { text: "built", startSeconds: 2.5, endSeconds: 3 },
                        { text: " a ", startSeconds: null, endSeconds: null },
                        { text: "service.", startSeconds: 3.5, endSeconds: 4 },
                        {
                          text: " Unmatched!",
                          startSeconds: null,
                          endSeconds: null,
                        },
                      ],
                    }
                  : {}),
              },
            ],
          },
        });
      }
      if (path.endsWith("/studio") && method === "GET") {
        state.studioGets++;
        return route.fulfill({
          json: {
            canEdit,
            capabilities: {
              clipping: { available, missing: available ? [] : ["FFmpeg"] },
              alignment: {
                available,
                missing: available ? [] : ["Speech API key"],
                model: "synthetic-speech",
              },
            },
            edits: state.edits,
            jobs: state.jobs,
            alignment: state.aligned
              ? {
                  jobId:
                    state.jobs
                      .filter(
                        (job) =>
                          job.kind === "alignment" && job.state === "ready",
                      )
                      .at(-1)?.id || "original-alignment",
                  model: "synthetic-speech",
                  matched: 3,
                  total: 5,
                }
              : null,
          },
        });
      }
      if (path.endsWith("/alignment") && method === "POST") {
        const body = route.request().postDataJSON();
        expect(body.consent).toBe(true);
        expect(body.requestKey).toMatch(/^[a-f0-9-]{36}$/);
        state.alignmentKeys.push(body.requestKey);
        if (state.failAlignmentResponse) {
          state.failAlignmentResponse = false;
          return route.abort("failed");
        }
        state.alignmentPosts++;
        const job: Job = {
          id: `alignment-${state.alignmentPosts}`,
          kind: "alignment",
          state: "queued",
          editId: null,
          editTitle: null,
          editRevision: null,
          createdAt: now,
          error: null,
        };
        state.jobs.push(job);
        return route.fulfill({ status: 202, json: { job } });
      }
      if (path.endsWith("/export") && method === "POST") {
        state.exports++;
        const edit = state.edits.find((item) =>
          path.includes(`/edits/${item.id}/`),
        )!;
        expect(route.request().postDataJSON().revision).toBe(edit.revision);
        const job: Job = {
          id: `export-${state.exports}`,
          kind: "export",
          state: "queued",
          editId: edit.id,
          editTitle: edit.title,
          editRevision: edit.revision,
          createdAt: now,
          error: null,
        };
        state.jobs.push(job);
        return route.fulfill({ status: 202, json: { job } });
      }
      if (path.includes("/studio/jobs/") && method === "DELETE") {
        const id = path.split("/").at(-1)!;
        state.cancelled.push(id);
        state.jobs = state.jobs.map((job) =>
          job.id === id ? { ...job, state: "cancelled" } : job,
        );
        return route.fulfill({ json: { ok: true } });
      }
      if (path.endsWith("/edits") && method === "POST") {
        const edit = {
          ...route.request().postDataJSON(),
          id: `edit-${state.edits.length + 1}`,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        state.edits.push(edit);
        return route.fulfill({ json: { edit } });
      }
      if (path.includes("/studio/edits/") && method === "PUT") {
        const edit = state.edits.find((item) => path.endsWith(`/${item.id}`))!;
        if (state.conflict) {
          edit.revision++;
          edit.title = "Changed by another reviewer";
          state.conflict = false;
          return route.fulfill({
            status: 409,
            json: { error: "Edit revision changed." },
          });
        }
        expect(route.request().postDataJSON().revision).toBe(edit.revision);
        Object.assign(edit, route.request().postDataJSON(), {
          revision: edit.revision + 1,
        });
        return route.fulfill({ json: { edit } });
      }
      if (path.includes("/studio/edits/") && method === "DELETE") {
        state.edits = state.edits.filter(
          (edit) => !path.endsWith(`/${edit.id}`),
        );
        return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({
        json: {
          canDelete: canEdit,
          items: [
            {
              id: "synthetic-recording",
              state: "ready",
              consentAt: now,
              expiresAt: new Date(Date.now() + 86400000).toISOString(),
              durationSeconds: 20,
              bytes: 1900,
              playable: true,
            },
          ],
        },
      });
    },
  );
  await page.goto(`/app/screening/${screening.id}?tab=candidates`);
  await page
    .getByRole("button", { name: "Studio Candidate", exact: true })
    .click();
  const region = page.getByRole("region", {
    name: "Interview recordings",
    exact: true,
  });
  await region
    .getByRole("button", { name: "View interview recordings", exact: true })
    .click();
  await region
    .getByRole("button", { name: "Play recording", exact: true })
    .click();
  const media = region.getByLabel("Interview recording 1", { exact: true });
  await expect
    .poll(() =>
      media.evaluate((element: HTMLVideoElement) => element.readyState),
    )
    .toBeGreaterThan(0);
  const studio = region.getByRole("region", {
    name: "Recording studio",
    exact: true,
  });
  return { region, studio, media, state };
}

test("word seeking and private edit save, reload, conflict, export and removal preserve the original", async ({
  page,
  baseURL,
}, testInfo) => {
  const { region, studio, media, state } = await fixture(page, baseURL);
  await expect(
    region.getByRole("list", { name: "Synchronized interview transcript" }),
  ).toContainText("I built a service. Unmatched!");
  await region
    .getByRole("button", { name: "Seek word built at 2.50 seconds" })
    .click();
  await expect
    .poll(() =>
      media.evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeCloseTo(2.5, 1);
  await expect(
    region.getByRole("button", { name: "Seek word built at 2.50 seconds" }),
  ).toHaveAttribute("aria-current", "true");
  await expect(
    region.getByRole("button", { name: /Seek word Unmatched/ }),
  ).toHaveCount(0);
  expect(state.studioGets).toBe(0);
  expect(state.alignmentPosts).toBe(0);
  await studio
    .getByRole("button", { name: "Word timing & video editor", exact: true })
    .click();
  await studio
    .getByLabel("Edit title", { exact: true })
    .fill("Engineering excerpt");
  await studio
    .getByRole("button", { name: "Add range at current time" })
    .click();
  await expect(studio.getByLabel("Range 1 start", { exact: true })).toHaveValue(
    "2.5",
  );
  await studio.getByLabel("Range 1 end", { exact: true }).fill("4");
  await studio.getByLabel("Mute range 1", { exact: true }).check();
  await studio
    .getByRole("button", { name: "Add range at current time" })
    .click();
  await studio.getByLabel("Range 2 start", { exact: true }).fill("6");
  await studio.getByLabel("Range 2 end", { exact: true }).fill("8");
  await studio
    .getByRole("button", { name: "Move range 2 up", exact: true })
    .click();
  await expect(studio.getByLabel("Range 1 start", { exact: true })).toHaveValue(
    "6",
  );
  await studio
    .getByRole("button", { name: "Preview edit on original", exact: true })
    .click();
  await expect
    .poll(() =>
      media.evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeGreaterThanOrEqual(6);
  await expect
    .poll(() => media.evaluate((element: HTMLVideoElement) => element.muted))
    .toBe(true);
  await expect(
    studio.getByRole("button", {
      name: "Preview edit on original",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await media.evaluate((element: HTMLVideoElement) => element.muted),
  ).toBe(false);
  expect(
    await media.evaluate((element: HTMLVideoElement) => element.paused),
  ).toBe(true);
  await studio.getByRole("button", { name: "Save edit", exact: true }).click();
  await expect(studio).toContainText("Edit saved.");
  expect(state.edits[0].segments).toEqual([
    { startSeconds: 6, endSeconds: 8, muted: false },
    { startSeconds: 2.5, endSeconds: 4, muted: true },
  ]);
  await studio
    .getByRole("button", { name: "Export saved edit", exact: true })
    .click();
  await expect(
    studio.getByRole("button", { name: "Cancel export", exact: true }),
  ).toBeVisible();
  state.jobs[0].state = "ready";
  await studio
    .getByRole("button", { name: "Refresh studio", exact: true })
    .click();
  await studio
    .getByRole("button", { name: "Preview export", exact: true })
    .click();
  await expect(
    studio.getByLabel("Export preview: Engineering excerpt", { exact: true }),
  ).toHaveAttribute("src", /\/studio\/jobs\/export-1\/media$/);
  await expect(
    studio.getByRole("link", { name: "Download export MP4" }),
  ).toHaveAttribute("href", /\/studio\/jobs\/export-1\/media\?download=1$/);
  const download = page.waitForEvent("download");
  await studio.getByRole("link", { name: "Download export MP4" }).click();
  expect((await download).suggestedFilename()).toBe("screening-excerpt.mp4");
  await studio
    .getByRole("button", { name: "Remove export", exact: true })
    .click();
  expect(state.cancelled).toEqual([]);
  await studio.getByRole("button", { name: "Keep it", exact: true }).click();
  await studio
    .getByRole("button", { name: "Remove export", exact: true })
    .click();
  await studio
    .getByRole("button", { name: "Confirm removal", exact: true })
    .click();
  await expect(
    studio.getByRole("link", { name: "Download export MP4" }),
  ).toHaveCount(0);
  expect(state.cancelled).toEqual(["export-1"]);
  await region
    .getByRole("button", { name: "Close player", exact: true })
    .click();
  await region
    .getByRole("button", { name: "Play recording", exact: true })
    .click();
  await studio
    .getByRole("button", { name: "Word timing & video editor", exact: true })
    .click();
  await studio.getByLabel("Saved edit", { exact: true }).selectOption("edit-1");
  await expect(studio.getByLabel("Edit title", { exact: true })).toHaveValue(
    "Engineering excerpt",
  );
  await studio
    .getByLabel("Edit title", { exact: true })
    .fill("Unsaved review title");
  await studio
    .getByRole("button", { name: "Refresh studio", exact: true })
    .click();
  await expect(studio.getByLabel("Edit title", { exact: true })).toHaveValue(
    "Unsaved review title",
  );
  state.conflict = true;
  await studio.getByRole("button", { name: "Save edit", exact: true }).click();
  await expect(studio.getByRole("alert")).toContainText(
    "Your draft is preserved",
  );
  await expect(studio.getByLabel("Edit title", { exact: true })).toHaveValue(
    "Unsaved review title",
  );
  await expect(
    studio.getByRole("button", { name: "Export saved edit", exact: true }),
  ).toBeDisabled();
  await studio
    .getByRole("button", { name: "Save as new edit", exact: true })
    .click();
  await expect(studio.getByLabel("Saved edit", { exact: true })).toHaveValue(
    "edit-2",
  );
  expect(state.edits[0].title).toBe("Changed by another reviewer");
  expect(state.edits[1].title).toBe("Unsaved review title");
  await studio
    .getByLabel("Edit title", { exact: true })
    .fill("Unsaved switch draft");
  await studio.getByLabel("Saved edit", { exact: true }).selectOption("edit-1");
  await expect(
    studio.getByRole("group", { name: "Discard unsaved edit" }),
  ).toBeVisible();
  await studio
    .getByRole("button", { name: "Keep editing", exact: true })
    .click();
  await expect(studio.getByLabel("Edit title", { exact: true })).toHaveValue(
    "Unsaved switch draft",
  );
  await studio
    .getByRole("heading", { name: "Recording studio", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("private-recording-studio-timing.png"),
  });
  await studio
    .getByRole("group", { name: "Range 1", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("private-recording-studio-edit.png"),
  });
});

test("word timing requires explicit consent, refreshes words after completion, and allows cancellation", async ({
  page,
  baseURL,
}) => {
  const { region, studio, state } = await fixture(page, baseURL);
  state.aligned = false;
  await region
    .getByRole("button", { name: "Close player", exact: true })
    .click();
  await region
    .getByRole("button", { name: "Play recording", exact: true })
    .click();
  await expect(region.getByRole("button", { name: /^Seek word/ })).toHaveCount(
    0,
  );
  await studio
    .getByRole("button", { name: "Word timing & video editor", exact: true })
    .click();
  const generate = studio.getByRole("button", {
    name: "Generate word timing",
    exact: true,
  });
  await expect(generate).toBeDisabled();
  const consent = studio.getByRole("checkbox", {
    name: /I agree to send this recording/,
  });
  await consent.check();
  state.failAlignmentResponse = true;
  await generate.click();
  await expect(studio.getByRole("alert")).toBeVisible();
  await expect(generate).toBeEnabled();
  await generate.click();
  expect(state.alignmentKeys[1]).toBe(state.alignmentKeys[0]);
  await expect(
    studio.getByRole("button", { name: "Cancel word timing", exact: true }),
  ).toBeVisible();
  expect(state.alignmentPosts).toBe(1);
  const previousGets = state.transcriptGets;
  state.jobs[0].state = "ready";
  state.aligned = true;
  await studio
    .getByRole("button", { name: "Refresh studio", exact: true })
    .click();
  await expect(
    region.getByRole("button", { name: "Seek word built at 2.50 seconds" }),
  ).toBeVisible();
  expect(state.transcriptGets).toBeGreaterThan(previousGets);
  state.aligned = false;
  state.jobs[0].state = "cancelled";
  await studio
    .getByRole("button", { name: "Refresh studio", exact: true })
    .click();
  await expect(region.getByRole("button", { name: /^Seek word/ })).toHaveCount(
    0,
  );
  await consent.check();
  await generate.click();
  await studio
    .getByRole("button", { name: "Cancel word timing", exact: true })
    .click();
  await expect(studio).toContainText("Processing cancelled.");
  expect(state.cancelled).toEqual(["alignment-2"]);
});

test("unconfigured media services remain honest and workspace viewers cannot mutate studio data", async ({
  page,
  baseURL,
}) => {
  const { studio, state } = await fixture(page, baseURL, false, false);
  const now = new Date().toISOString();
  state.edits.push({
    id: "saved",
    title: "Saved private excerpt",
    revision: 1,
    segments: [{ startSeconds: 1, endSeconds: 3, muted: true }],
    createdAt: now,
    updatedAt: now,
  });
  state.jobs.push({
    id: "saved-export",
    kind: "export",
    state: "ready",
    editId: "saved",
    editTitle: "Saved private excerpt",
    editRevision: 1,
    error: null,
    createdAt: now,
  });
  await studio
    .getByRole("button", { name: "Word timing & video editor", exact: true })
    .click();
  await expect(studio).toContainText("Only workspace owners and admins");
  await expect(studio).toContainText("Video export is unavailable: FFmpeg");
  await expect(studio).toContainText(
    "Word timing is unavailable: Speech API key",
  );
  await expect(
    studio.getByRole("button", { name: "Generate word timing", exact: true }),
  ).toHaveCount(0);
  await studio.getByLabel("Saved edit", { exact: true }).selectOption("saved");
  await expect(studio.getByLabel("Edit title", { exact: true })).toBeDisabled();
  await expect(
    studio.getByLabel("Range 1 start", { exact: true }),
  ).toBeDisabled();
  await expect(
    studio.getByRole("button", { name: "Save edit", exact: true }),
  ).toHaveCount(0);
  await expect(
    studio.getByRole("button", { name: "Export saved edit", exact: true }),
  ).toHaveCount(0);
  await expect(
    studio.getByRole("button", { name: "Remove export", exact: true }),
  ).toHaveCount(0);
  await expect(
    studio.getByRole("link", { name: "Download export MP4" }),
  ).toBeVisible();
});

test("owners can save selections with unavailable processors without enabling processing actions", async ({
  page,
  baseURL,
}) => {
  const { studio, state } = await fixture(page, baseURL, true, false);
  await studio
    .getByRole("button", { name: "Word timing & video editor", exact: true })
    .click();
  await expect(
    studio.getByRole("button", { name: "Generate word timing", exact: true }),
  ).toBeDisabled();
  await expect(
    studio.getByRole("checkbox", { name: /I agree to send this recording/ }),
  ).toBeDisabled();
  await studio
    .getByLabel("Edit title", { exact: true })
    .fill("Offline selection");
  await studio
    .getByRole("button", { name: "Add range at current time", exact: true })
    .click();
  await studio.getByLabel("Range 1 end", { exact: true }).fill("2");
  await studio.getByRole("button", { name: "Save edit", exact: true }).click();
  await expect(studio).toContainText("Edit saved.");
  await expect(
    studio.getByRole("button", { name: "Export saved edit", exact: true }),
  ).toBeDisabled();
  expect(state.alignmentPosts).toBe(0);
  expect(state.exports).toBe(0);
});
