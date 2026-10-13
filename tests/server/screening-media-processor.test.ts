import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  stat,
  truncate,
  symlink,
  chmod,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  alignTranscriptWords,
  createScreeningMediaProcessor,
} from "../../server/screening-media-processor.js";

let dir: string, input: string, silent: string;
const available =
  spawnSync("ffmpeg", ["-version"]).status === 0 &&
  spawnSync("ffprobe", ["-version"]).status === 0;
const mediaTest = (name: string, fn: () => Promise<void>) =>
  test(
    name,
    {
      skip:
        !available &&
        "FFmpeg/ffprobe are not installed; run these tests in the media-enabled CI job.",
    },
    fn,
  );
const env = {
  OPENAI_API_KEY: "synthetic-speech-key",
  OPENAI_WORKSPACE_IDS: "workspace-one",
};
const segment = (startSeconds: number, endSeconds: number, muted = false) => ({
  startSeconds,
  endSeconds,
  muted,
});

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "arkoffer-media-test-"));
  input = join(dir, "synthetic.mp4");
  silent = join(dir, "silent.mp4");
  if (!available) return;
  const result = spawnSync("ffmpeg", [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=160x90:r=20:d=4",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=16000:duration=4",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-metadata",
    "title=private source metadata",
    "-shortest",
    input,
  ]);
  assert.equal(result.status, 0, result.stderr.toString());
  const noAudio = spawnSync("ffmpeg", [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    input,
    "-c:v",
    "copy",
    "-an",
    silent,
  ]);
  assert.equal(noAudio.status, 0, noAudio.stderr.toString());
});
after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

mediaTest(
  "media capability status separates local editing from workspace-authorized speech",
  async () => {
    const processor = createScreeningMediaProcessor(env);
    const enabled = await processor.status("workspace-one");
    assert.equal(enabled.clipping.available, true);
    assert.equal(enabled.alignment.available, true);
    assert.equal(enabled.alignment.model, "whisper-1");
    assert.equal(
      (await processor.status("workspace-two")).alignment.available,
      false,
    );
    assert.equal(
      (
        await createScreeningMediaProcessor({
          ...env,
          LLM_WORKSPACE_IDS: "",
        }).status("workspace-one")
      ).alignment.available,
      false,
    );
    const invalid = await createScreeningMediaProcessor({
      ...env,
      OPENAI_TRANSCRIPTION_BASE_URL: "http://127.0.0.1/private",
      SCREENING_WORD_ALIGNMENT_MODEL: "timestamp-model",
    }).status("workspace-one");
    assert.equal(invalid.alignment.available, false);
    assert.equal(invalid.alignment.model, "timestamp-model");
    const missing = await createScreeningMediaProcessor({
      SCREENING_FFMPEG_PATH: join(dir, "absent-ffmpeg"),
      SCREENING_FFPROBE_PATH: join(dir, "absent-ffprobe"),
    }).status("workspace-one");
    assert.equal(missing.clipping.available, false);
    assert.ok(missing.clipping.missing.includes("FFmpeg executable"));
    assert.ok(missing.alignment.missing.includes("OPENAI_API_KEY"));
  },
);

mediaTest(
  "FFmpeg exports accurate ordered segments, muted audio, no copied metadata, and private output",
  async () => {
    const output = join(dir, "edited.mp4");
    const beforeBytes = await readFile(input);
    await createScreeningMediaProcessor().export({
      inputPath: input,
      outputPath: output,
      segments: [segment(2, 3, true), segment(0.5, 1.5)],
    });
    const result = spawnSync("ffprobe", [
      "-v",
      "error",
      "-show_format",
      "-show_streams",
      "-of",
      "json",
      output,
    ]);
    const media = JSON.parse(result.stdout.toString());
    assert.ok(Math.abs(Number(media.format.duration) - 2) < 0.15);
    assert.equal(media.format.tags?.title, undefined);
    assert.equal(
      media.streams.find(
        (stream: { codec_type: string }) => stream.codec_type === "video",
      ).codec_name,
      "h264",
    );
    assert.equal(
      media.streams.find(
        (stream: { codec_type: string }) => stream.codec_type === "audio",
      ).codec_name,
      "aac",
    );
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.deepEqual(await readFile(input), beforeBytes);
    const pcm = spawnSync("ffmpeg", [
      "-v",
      "error",
      "-i",
      output,
      "-map",
      "0:a:0",
      "-f",
      "s16le",
      "-ac",
      "1",
      "-ar",
      "16000",
      "pipe:1",
    ]).stdout;
    function peak(start: number, end: number) {
      let value = 0;
      for (
        let index = start * 16000 * 2;
        index < end * 16000 * 2 && index + 1 < pcm.length;
        index += 2
      )
        value = Math.max(value, Math.abs(pcm.readInt16LE(index)));
      return value;
    }
    assert.ok(peak(0.1, 0.8) < 20, "first segment must be silent");
    assert.ok(peak(1.2, 1.8) > 500, "second segment must retain source audio");
    await assert.rejects(
      createScreeningMediaProcessor().export({
        inputPath: input,
        outputPath: output,
        segments: [segment(0, 1)],
      }),
      /already exists/,
    );
  },
);

mediaTest(
  "silent recordings export without fabricating an audio track",
  async () => {
    const output = join(dir, "silent-edit.mp4");
    await createScreeningMediaProcessor().export({
      inputPath: silent,
      outputPath: output,
      segments: [segment(0.25, 0.75)],
    });
    const result = spawnSync("ffprobe", [
      "-v",
      "error",
      "-show_streams",
      "-of",
      "json",
      output,
    ]);
    assert.equal(JSON.parse(result.stdout.toString()).streams.length, 1);
    const boundaryOutput = join(dir, "tenth-second-edit.mp4");
    await createScreeningMediaProcessor().export({
      inputPath: silent,
      outputPath: boundaryOutput,
      segments: [segment(0.4, 0.5)],
    });
    assert.ok((await stat(boundaryOutput)).size > 0);
    await assert.rejects(
      createScreeningMediaProcessor(env).align({ inputPath: silent }),
      /no audio stream/,
    );
  },
);

mediaTest(
  "input validation rejects protocols, symlinks, malformed/oversized files and invalid clip ranges",
  async () => {
    const processor = createScreeningMediaProcessor();
    const output = join(dir, "invalid-edit.mp4");
    for (const segments of [
      [],
      [segment(-1, 2)],
      [segment(0, 99)],
      [segment(0, Infinity)],
      [segment(NaN, 1)],
      [segment(1, 1)],
      Array.from({ length: 21 }, () => segment(0, 1)),
    ])
      await assert.rejects(
        processor.export({ inputPath: input, outputPath: output, segments }),
      );
    await assert.rejects(
      processor.export({
        inputPath: "https://example.com/video.mp4",
        outputPath: output,
        segments: [segment(0, 1)],
      }),
      /private local/,
    );
    const invalid = join(dir, "not-an-mp4.mp4");
    await writeFile(invalid, "not a real mp4 file");
    await assert.rejects(
      processor.export({
        inputPath: invalid,
        outputPath: output,
        segments: [segment(0, 1)],
      }),
      /MP4 recording/,
    );
    const link = join(dir, "linked.mp4");
    await symlink(input, link);
    await assert.rejects(
      processor.export({
        inputPath: link,
        outputPath: output,
        segments: [segment(0, 1)],
      }),
      /regular file/,
    );
    await truncate(invalid, 250 * 1024 * 1024 + 1);
    await assert.rejects(
      processor.export({
        inputPath: invalid,
        outputPath: output,
        segments: [segment(0, 1)],
      }),
      /250 MB/,
    );
    await assert.rejects(
      processor.export({
        inputPath: input,
        outputPath: input,
        segments: [segment(0, 1)],
      }),
      /separate/,
    );
    const shifted = join(dir, "shifted-origin.mp4");
    const shiftedResult = spawnSync("ffmpeg", [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-copyts",
      "-itsoffset",
      "1",
      "-i",
      input,
      "-map",
      "0",
      "-c",
      "copy",
      "-avoid_negative_ts",
      "disabled",
      shifted,
    ]);
    assert.equal(shiftedResult.status, 0, shiftedResult.stderr.toString());
    await assert.rejects(
      processor.export({
        inputPath: shifted,
        outputPath: output,
        segments: [segment(0, 1)],
      }),
      /zero-based video timeline/,
    );
    await assert.rejects(stat(output));
  },
);

mediaTest(
  "word transcription uses dedicated model and compressed audio with bounded provider timestamps",
  async () => {
    let called = 0;
    const processor = createScreeningMediaProcessor(
      {
        ...env,
        OPENAI_TRANSCRIPTION_MODEL: "different-live-model",
        LLM_MODEL: "different-text-model",
        OPENAI_TRANSCRIPTION_BASE_URL: "https://speech.example/v1",
        SCREENING_WORD_ALIGNMENT_MODEL: "timestamp-model",
      },
      {
        fetchImpl: (async (url, init) => {
          called++;
          assert.equal(url, "https://speech.example/v1/audio/transcriptions");
          assert.equal(init?.redirect, "error");
          assert.ok(init?.signal);
          assert.equal(
            new Headers(init?.headers).get("authorization"),
            "Bearer synthetic-speech-key",
          );
          const form = init!.body as FormData;
          assert.equal(form.get("model"), "timestamp-model");
          assert.equal(form.get("response_format"), "verbose_json");
          assert.equal(form.get("timestamp_granularities[]"), "word");
          const file = form.get("file") as File;
          assert.equal(file.type, "audio/mpeg");
          assert.ok(file.size > 1000 && file.size < 25 * 1024 * 1024);
          return Response.json({
            words: [
              { word: "Synthetic", start: 0.5, end: 1 },
              { word: "speech", start: 1.1, end: 1.7 },
            ],
          });
        }) as typeof fetch,
      },
    );
    assert.deepEqual(await processor.align({ inputPath: input }), {
      model: "timestamp-model",
      words: [
        { word: "Synthetic", start: 0.5, end: 1 },
        { word: "speech", start: 1.1, end: 1.7 },
      ],
    });
    assert.equal(called, 1);
  },
);

mediaTest(
  "malformed, oversized, out-of-range and unordered provider responses fail without exposing provider content",
  async () => {
    const responses = [
      () => Response.json({ words: [{ word: "bad", start: 9, end: 10 }] }),
      () => Response.json({ words: [{ word: "bad", start: 1, end: 0 }] }),
      () => Response.json({ words: [{ word: "bad", start: 1, end: 1 }] }),
      () =>
        Response.json({
          words: [
            { word: "first", start: 0, end: 1 },
            { word: "second", start: 0.5, end: 1.5 },
          ],
        }),
      () =>
        Response.json({
          words: [
            { word: "first", start: 1, end: 1.5 },
            { word: "second", start: 0, end: 0.5 },
          ],
        }),
      () => Response.json({ words: [{ word: "bad", start: null, end: 1 }] }),
      () => Response.json({ text: "no timing" }),
      () => new Response("invalid JSON"),
      () =>
        new Response("synthetic sensitive provider content", { status: 500 }),
      () =>
        new Response("{}", {
          headers: { "content-length": String(5 * 1024 * 1024) },
        }),
      () => new Response("x".repeat(4 * 1024 * 1024 + 1)),
    ];
    for (const makeResponse of responses) {
      const processor = createScreeningMediaProcessor(env, {
        fetchImpl: (async () => makeResponse()) as typeof fetch,
      });
      await assert.rejects(
        processor.align({ inputPath: input }),
        (error) =>
          error instanceof Error &&
          !error.message.includes("sensitive") &&
          /Word timestamp/.test(error.message),
      );
    }
  },
);

mediaTest(
  "word transcription preserves an initial audio-track delay on the video timeline",
  async () => {
    const delayed = join(dir, "delayed-audio.mp4");
    const generated = spawnSync("ffmpeg", [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=160x90:r=20:d=4",
      "-itsoffset",
      "1",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=16000:duration=3",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-t",
      "4",
      delayed,
    ]);
    assert.equal(generated.status, 0, generated.stderr.toString());
    const processor = createScreeningMediaProcessor(env, {
      fetchImpl: (async (_url, init) => {
        const file = (init!.body as FormData).get("file") as File;
        const audio = join(dir, "delayed-provider-input.mp3");
        await writeFile(audio, new Uint8Array(await file.arrayBuffer()));
        const decoded = spawnSync("ffmpeg", [
          "-v",
          "error",
          "-i",
          audio,
          "-f",
          "s16le",
          "-ac",
          "1",
          "-ar",
          "16000",
          "pipe:1",
        ]);
        assert.equal(decoded.status, 0);
        function peak(start: number, end: number) {
          let value = 0;
          for (let index = start * 32000; index < end * 32000; index += 2)
            value = Math.max(
              value,
              Math.abs(decoded.stdout.readInt16LE(index)),
            );
          return value;
        }
        assert.ok(
          peak(0.1, 0.7) < 20,
          "leading silence must preserve source audio offset",
        );
        assert.ok(
          peak(1.2, 1.8) > 500,
          "speech remains at its original video-relative time",
        );
        return Response.json({
          words: [{ word: "Synthetic", start: 1.2, end: 1.6 }],
        });
      }) as typeof fetch,
    });
    assert.equal(
      (await processor.align({ inputPath: delayed })).words[0].start,
      1.2,
    );
    const edited = join(dir, "delayed-audio-edit.mp4");
    await processor.export({
      inputPath: delayed,
      outputPath: edited,
      segments: [segment(0, 2)],
    });
    const editedAudio = spawnSync("ffmpeg", [
      "-v",
      "error",
      "-i",
      edited,
      "-f",
      "s16le",
      "-ac",
      "1",
      "-ar",
      "16000",
      "pipe:1",
    ]);
    assert.equal(editedAudio.status, 0);
    let leadingPeak = 0;
    for (let index = 3200; index < 22400; index += 2)
      leadingPeak = Math.max(
        leadingPeak,
        Math.abs(editedAudio.stdout.readInt16LE(index)),
      );
    assert.ok(
      leadingPeak < 20,
      "editing must also preserve the initial video/audio offset",
    );
  },
);

mediaTest(
  "abort terminates media/provider work and does not leave an output",
  async () => {
    const controller = new AbortController();
    controller.abort();
    const output = join(dir, "cancelled.mp4");
    await assert.rejects(
      createScreeningMediaProcessor().export({
        inputPath: input,
        outputPath: output,
        segments: [segment(0, 1)],
        signal: controller.signal,
      }),
      /cancelled/,
    );
    let requestSignal: AbortSignal | undefined;
    const active = new AbortController();
    const processor = createScreeningMediaProcessor(env, {
      fetchImpl: (async (_url, init) => {
        requestSignal = init!.signal!;
        active.abort();
        throw new DOMException("Aborted", "AbortError");
      }) as typeof fetch,
    });
    await assert.rejects(
      processor.align({ inputPath: input, signal: active.signal }),
      /cancelled/,
    );
    assert.equal(requestSignal?.aborted, true);
    await assert.rejects(stat(output));
  },
);

mediaTest(
  "active subprocess cancellation and timeout terminate the child and remove temporary work",
  async () => {
    for (const mode of ["abort", "timeout"] as const) {
      const startedPath = join(dir, `${mode}-started.json`);
      const survivedPath = join(dir, `${mode}-survived`);
      const executable = join(dir, `${mode}-fake-ffmpeg`);
      await writeFile(
        executable,
        `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(startedPath)}, JSON.stringify({output:process.argv.at(-1),pid:process.pid}));\nsetTimeout(() => fs.writeFileSync(${JSON.stringify(survivedPath)}, 'unexpected surviving child'), 15000);\nsetInterval(() => {}, 1000);\n`,
      );
      await chmod(executable, 0o700);
      const controller = new AbortController();
      const processor = createScreeningMediaProcessor(
        { SCREENING_FFMPEG_PATH: executable },
        { timeoutMs: mode === "timeout" ? 5000 : 15000 },
      );
      const outputPath = join(dir, `${mode}-never-exported.mp4`);
      const pending = assert.rejects(
        processor.export({
          inputPath: input,
          outputPath,
          segments: [segment(0, 1)],
          signal: controller.signal,
        }),
        mode === "abort" ? /cancelled/ : /time limit/,
      );
      let started = false;
      for (let attempt = 0; attempt < 700 && !started; attempt++) {
        started = await stat(startedPath).then(
          () => true,
          () => false,
        );
        if (!started) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(started, true, "test child must actually start");
      if (mode === "abort") controller.abort();
      await pending;
      const metadata = JSON.parse(await readFile(startedPath, "utf8"));
      await assert.rejects(stat(metadata.output));
      await assert.rejects(stat(outputPath));
      assert.throws(() => process.kill(metadata.pid, 0), { code: "ESRCH" });
      await assert.rejects(
        stat(survivedPath),
        "terminated child cannot run its delayed write",
      );
    }
  },
);

test("word matching preserves characters and uses only unambiguous ordered exact normalized matches", () => {
  const turns = [
    {
      id: "turn",
      text: " Hello, brave  WORLD! I can’t...",
      startSeconds: 0,
      endSeconds: 4,
    },
  ];
  const result = alignTranscriptWords(turns, [
    { word: "hello,", start: 0.1, end: 0.5 },
    { word: "different", start: 0.5, end: 0.8 },
    { word: "world", start: 1, end: 1.5 },
    { word: "I", start: 1.6, end: 1.8 },
    { word: "can't", start: 2, end: 2.5 },
  ]);
  assert.equal(
    result[0].tokens.map((token) => token.text).join(""),
    turns[0].text,
  );
  assert.deepEqual(
    result[0].tokens
      .filter((token) => token.startSeconds !== null)
      .map((token) => token.text),
    ["Hello", "WORLD", "I", "can’t"],
  );
  assert.equal(
    result[0].tokens.find((token) => token.text === "brave")?.startSeconds,
    null,
  );
});

test("repetitions, reversed order, overlapping turns, absent timing and unmatched words stay untimed", () => {
  const cases = [
    { text: "yes yes", words: [{ word: "yes", start: 0.1, end: 0.3 }] },
    {
      text: "yes",
      words: [
        { word: "yes", start: 0.1, end: 0.3 },
        { word: "yes", start: 0.4, end: 0.6 },
      ],
    },
    {
      text: "first second",
      words: [
        { word: "second", start: 0.1, end: 0.3 },
        { word: "first", start: 0.4, end: 0.6 },
      ],
    },
    { text: "yes", words: [{ word: "yes", start: 9, end: 10 }] },
  ];
  for (const value of cases) {
    const result = alignTranscriptWords(
      [{ id: "one", text: value.text, startSeconds: 0, endSeconds: 1 }],
      value.words,
    );
    assert.ok(result[0].tokens.every((token) => token.startSeconds === null));
    assert.equal(
      result[0].tokens.map((token) => token.text).join(""),
      value.text,
    );
  }
  const words = [{ word: "yes", start: 0.1, end: 0.3 }];
  assert.ok(
    alignTranscriptWords(
      [{ id: "one", text: "yes", startSeconds: null, endSeconds: null }],
      words,
    )[0].tokens.every((token) => token.startSeconds === null),
  );
  const overlapping = alignTranscriptWords(
    [
      { id: "one", text: "yes", startSeconds: 0, endSeconds: 1 },
      { id: "two", text: "yes", startSeconds: 0, endSeconds: 1 },
    ],
    words,
  );
  assert.ok(
    overlapping.every((turn) =>
      turn.tokens.every((token) => token.startSeconds === null),
    ),
  );
});
