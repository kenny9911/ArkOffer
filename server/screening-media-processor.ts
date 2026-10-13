import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  ScreeningAlignedTurn,
  ScreeningAlignedWord,
  ScreeningMediaProcessorStatus,
  ScreeningMediaSegment,
  ScreeningTranscriptToken,
} from "../shared/screening-media.js";

const MAX_BYTES = 250 * 1024 * 1024;
const MAX_SECONDS = 30 * 60;
const MAX_WORDS = 30_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_SEGMENTS = 12;
const DEFAULT_TIMEOUT = 15 * 60 * 1000;

/** Errors deliberately omit subprocess output, provider bodies, and private paths. */
export class ScreeningMediaProcessingError extends Error {}

function failure(message: string): never {
  throw new ScreeningMediaProcessingError(message);
}

function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) failure("Media processing was cancelled.");
}

/** No shell is involved; terminate before settling so callers can safely remove inputs. */
function run(
  executable: string,
  args: string[],
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<string> {
  cancelled(signal);
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "",
      bytes = 0,
      reason = "",
      killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (message: string) => {
      if (reason) return;
      reason = message;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      killTimer.unref();
    };
    const onAbort = () => stop("Media processing was cancelled.");
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => stop("Media processing exceeded its time limit."),
      timeoutMs,
    );
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024)
        stop("Media processor returned too much output.");
      else output += chunk.toString("utf8");
    });
    // Drain errors without storing filenames or media/provider content.
    child.stderr.on("data", () => {});
    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    child.once("error", () => {
      cleanup();
      reject(
        new ScreeningMediaProcessingError("Media processor is unavailable."),
      );
    });
    child.once("close", (code) => {
      cleanup();
      if (reason || code !== 0)
        reject(
          new ScreeningMediaProcessingError(
            reason || "Media processing failed. Verify that the MP4 is valid.",
          ),
        );
      else resolveResult(output);
    });
    if (signal?.aborted) onAbort();
  });
}

const localInputOptions = [
  "-protocol_whitelist",
  "file,pipe",
  "-f",
  "mov",
  "-enable_drefs",
  "0",
  "-use_absolute_path",
  "0",
];

type Probe = { duration: number; audio: boolean; frameRate: number };

async function validateInput(path: string) {
  if (!isAbsolute(path) || path.includes("\0"))
    failure("Media input must be a private local file.");
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink())
    failure("Media input must be a private regular file.");
  if (info.size < 12 || info.size > MAX_BYTES)
    failure("Media input must be an MP4 no larger than 250 MB.");
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(12);
    await handle.read(header, 0, 12, 0);
    if (header.toString("ascii", 4, 8) !== "ftyp")
      failure("Media input must be an MP4 recording.");
  } finally {
    await handle.close();
  }
}

function numberInRange(value: unknown, min: number, max: number) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}

async function readProviderJson(response: Response) {
  const declaredSize = Number(response.headers.get("content-length"));
  if (declaredSize > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    failure("Word timestamp response exceeded its size limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) failure("Word timestamp provider returned an empty response.");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        failure("Word timestamp response exceeded its size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return failure("Word timestamp provider returned invalid JSON.");
  }
}

export function createScreeningMediaProcessor(
  env: NodeJS.ProcessEnv = process.env,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
) {
  const ffmpeg = env.SCREENING_FFMPEG_PATH?.trim() || "ffmpeg";
  const ffprobe = env.SCREENING_FFPROBE_PATH?.trim() || "ffprobe";
  const model = env.SCREENING_WORD_ALIGNMENT_MODEL?.trim() || "whisper-1";
  const apiKey = env.OPENAI_API_KEY?.trim();
  const timeoutMs = Math.min(
    DEFAULT_TIMEOUT,
    Math.max(100, options.timeoutMs ?? DEFAULT_TIMEOUT),
  );
  let endpoint = "";
  try {
    const url = new URL(
      env.OPENAI_TRANSCRIPTION_BASE_URL || "https://api.openai.com/v1",
    );
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    )
      endpoint = `${url.toString().replace(/\/$/, "")}/audio/transcriptions`;
  } catch {
    // Invalid configuration is reported as unavailable without exposing its value.
  }
  let capabilities:
    | Promise<{
        ffmpeg: boolean;
        ffprobe: boolean;
        h264: boolean;
        aac: boolean;
        mp3: boolean;
      }>
    | undefined;
  const inspectCapabilities = () =>
    (capabilities ??= (async () => {
      const [encoderResult, probeResult] = await Promise.allSettled([
        run(ffmpeg, ["-hide_banner", "-encoders"], undefined, 5000),
        run(ffprobe, ["-version"], undefined, 5000),
      ]);
      const encoders =
        encoderResult.status === "fulfilled" ? encoderResult.value : "";
      return {
        ffmpeg: encoderResult.status === "fulfilled",
        ffprobe: probeResult.status === "fulfilled",
        h264: /\blibx264\b/.test(encoders),
        aac: /\baac\b/.test(encoders),
        mp3: /\blibmp3lame\b/.test(encoders),
      };
    })());

  async function probe(path: string, signal?: AbortSignal): Promise<Probe> {
    cancelled(signal);
    await validateInput(path);
    const text = await run(
      ffprobe,
      [
        "-v",
        "error",
        ...localInputOptions,
        "-i",
        path,
        "-show_entries",
        "format=duration,start_time:stream=codec_type,width,height,avg_frame_rate,start_time",
        "-of",
        "json",
      ],
      signal,
      Math.min(timeoutMs, 30_000),
    );
    let data: {
      format?: { duration?: string; start_time?: string };
      streams?: Array<{
        codec_type?: string;
        width?: number;
        height?: number;
        avg_frame_rate?: string;
        start_time?: string;
      }>;
    };
    try {
      data = JSON.parse(text);
    } catch {
      return failure("Media metadata is invalid.");
    }
    const duration = Number(data.format?.duration);
    const videos =
      data.streams?.filter((stream) => stream.codec_type === "video") ?? [];
    const audios =
      data.streams?.filter((stream) => stream.codec_type === "audio") ?? [];
    if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_SECONDS)
      failure(
        "Recordings must have a valid duration of no more than 30 minutes.",
      );
    if (
      videos.length !== 1 ||
      audios.length > 1 ||
      (data.streams?.length ?? 0) > 16
    )
      failure(
        "Use a recording with one video stream and at most one audio stream.",
      );
    const video = videos[0];
    const origin = Number(data.format?.start_time);
    const videoOrigin = Number(video.start_time);
    if (
      !Number.isFinite(origin) ||
      Math.abs(origin) > 0.001 ||
      !Number.isFinite(videoOrigin) ||
      Math.abs(videoOrigin) > 0.001
    )
      failure(
        "Media processing requires a recording with a zero-based video timeline.",
      );
    const [fpsNumerator, fpsDenominator] = (video.avg_frame_rate || "0/1")
      .split("/")
      .map(Number);
    const fps = fpsNumerator / fpsDenominator;
    if (
      !numberInRange(video.width, 2, 3840) ||
      !numberInRange(video.height, 2, 2160) ||
      !Number.isFinite(fps) ||
      fps < 1 ||
      fps > 120
    )
      failure("Recording resolution or frame rate exceeds processing limits.");
    return { duration, audio: audios.length === 1, frameRate: fps };
  }

  return {
    async status(workspaceId: string): Promise<ScreeningMediaProcessorStatus> {
      const ready = await inspectCapabilities();
      const common = [
        ...(!ready.ffmpeg ? ["FFmpeg executable"] : []),
        ...(!ready.ffprobe ? ["ffprobe executable"] : []),
      ];
      const clipping = [
        ...common,
        ...(ready.ffmpeg && !ready.h264 ? ["FFmpeg libx264 encoder"] : []),
        ...(ready.ffmpeg && !ready.aac ? ["FFmpeg AAC encoder"] : []),
      ];
      const allowed = (env.LLM_WORKSPACE_IDS ?? env.OPENAI_WORKSPACE_IDS ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
        .includes(workspaceId);
      const alignment = [
        ...common,
        ...(ready.ffmpeg && !ready.mp3 ? ["FFmpeg libmp3lame encoder"] : []),
        ...(!apiKey ? ["OPENAI_API_KEY"] : []),
        ...(!endpoint ? ["Valid HTTPS OPENAI_TRANSCRIPTION_BASE_URL"] : []),
        ...(!allowed
          ? ["LLM_WORKSPACE_IDS or OPENAI_WORKSPACE_IDS workspace access"]
          : []),
      ];
      return {
        clipping: { available: !clipping.length, missing: clipping },
        alignment: { available: !alignment.length, missing: alignment, model },
      };
    },

    async export({
      inputPath,
      outputPath,
      segments,
      signal,
    }: {
      inputPath: string;
      outputPath: string;
      segments: ScreeningMediaSegment[];
      signal?: AbortSignal;
    }): Promise<void> {
      cancelled(signal);
      if (
        !isAbsolute(outputPath) ||
        outputPath.includes("\0") ||
        resolve(inputPath) === resolve(outputPath)
      )
        failure("Choose a separate private local output file.");
      if (
        await lstat(outputPath).then(
          () => true,
          () => false,
        )
      )
        failure("The media output already exists.");
      const source = await probe(inputPath, signal);
      if (
        !Array.isArray(segments) ||
        segments.length < 1 ||
        segments.length > MAX_SEGMENTS
      )
        failure("Choose between one and 12 clip segments.");
      let duration = 0;
      for (const segment of segments) {
        if (
          !segment ||
          !numberInRange(segment.startSeconds, 0, source.duration) ||
          !numberInRange(segment.endSeconds, 0, source.duration) ||
          segment.endSeconds - segment.startSeconds < 0.1 - 1e-9 ||
          typeof segment.muted !== "boolean"
        )
          failure(
            "Clip segments must be at least 0.1 seconds and inside the recording.",
          );
        duration += segment.endSeconds - segment.startSeconds;
      }
      if (!Number.isFinite(duration) || duration > MAX_SECONDS + 1e-9)
        failure("The combined edit must be no longer than 30 minutes.");
      // Keep scratch inside the caller's private durable-cleanup directory.
      const dir = await mkdtemp(join(dirname(inputPath), "processing-"));
      try {
        const result = join(dir, "clip.mp4");
        const filters: string[] = [];
        segments.forEach((segment, index) => {
          const range = `start=${segment.startSeconds.toFixed(6)}:end=${segment.endSeconds.toFixed(6)}`;
          filters.push(
            `[0:v:0]trim=${range},setpts=PTS-STARTPTS,scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1[v${index}]`,
          );
          if (source.audio)
            filters.push(
              `[0:a:0]aresample=async=1:first_pts=0,atrim=${range},asetpts=PTS-STARTPTS${segment.muted ? ",volume=0" : ""}[a${index}]`,
            );
        });
        const inputs = segments
          .map((_, index) => `[v${index}]${source.audio ? `[a${index}]` : ""}`)
          .join("");
        filters.push(
          `${inputs}concat=n=${segments.length}:v=1:a=${source.audio ? 1 : 0}[v]${source.audio ? "[a]" : ""}`,
        );
        await run(
          ffmpeg,
          [
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-threads",
            "2",
            ...localInputOptions,
            "-i",
            inputPath,
            "-filter_complex_threads",
            "1",
            "-filter_complex",
            filters.join(";"),
            "-map",
            "[v]",
            ...(source.audio
              ? ["-map", "[a]", "-c:a", "aac", "-b:a", "96k"]
              : ["-an"]),
            "-c:v",
            "libx264",
            "-threads",
            "2",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-fps_mode",
            "vfr",
            "-map_metadata",
            "-1",
            "-map_metadata:s",
            "-1",
            "-map_chapters",
            "-1",
            "-movflags",
            "+faststart",
            "-fs",
            String(MAX_BYTES + 1),
            "-f",
            "mp4",
            result,
          ],
          signal,
          timeoutMs,
        );
        const rendered = await probe(result, signal);
        if (
          Math.abs(rendered.duration - duration) >
          segments.length / source.frameRate + 0.05
        )
          failure("The rendered edit did not match its requested duration.");
        cancelled(signal);
        await copyFile(result, outputPath, constants.COPYFILE_EXCL);
        await chmod(outputPath, 0o600);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },

    async align({
      inputPath,
      signal,
    }: {
      inputPath: string;
      signal?: AbortSignal;
    }): Promise<{ words: ScreeningAlignedWord[]; model: string }> {
      cancelled(signal);
      if (!apiKey || !endpoint)
        failure("Word timestamp transcription is not configured.");
      const source = await probe(inputPath, signal);
      if (!source.audio)
        failure("This recording has no audio stream to align.");
      const dir = await mkdtemp(join(dirname(inputPath), "processing-"));
      const deadline = AbortSignal.timeout(timeoutMs);
      const requestSignal = signal
        ? AbortSignal.any([signal, deadline])
        : deadline;
      try {
        const audio = join(dir, "audio.mp3");
        await run(
          ffmpeg,
          [
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-threads",
            "2",
            ...localInputOptions,
            "-i",
            inputPath,
            "-map",
            "0:a:0",
            "-vn",
            // Keep a delayed audio track on the original video timeline.
            "-af",
            "aresample=async=1:first_pts=0",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "32k",
            "-threads",
            "2",
            "-map_metadata",
            "-1",
            "-map_metadata:s",
            "-1",
            "-map_chapters",
            "-1",
            "-f",
            "mp3",
            audio,
          ],
          requestSignal,
          timeoutMs,
        );
        if ((await stat(audio)).size > 25 * 1024 * 1024)
          failure("The audio exceeds the transcription upload limit.");
        const bytes = await readFile(audio);
        const form = new FormData();
        form.append(
          "file",
          new Blob([new Uint8Array(bytes)], { type: "audio/mpeg" }),
          "interview.mp3",
        );
        form.append("model", model);
        form.append("response_format", "verbose_json");
        form.append("timestamp_granularities[]", "word");
        form.append("temperature", "0");
        const response = await (options.fetchImpl ?? fetch)(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
          redirect: "error",
          signal: requestSignal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          failure(`Word timestamp provider failed (${response.status}).`);
        }
        const data = await readProviderJson(response);
        const words =
          data && typeof data === "object" && "words" in data
            ? data.words
            : undefined;
        if (!Array.isArray(words) || words.length > MAX_WORDS)
          failure("Word timestamp provider returned invalid word data.");
        let previousEnd = -1;
        const validated = words.map((word): ScreeningAlignedWord => {
          if (
            !word ||
            typeof word !== "object" ||
            typeof word.word !== "string" ||
            !word.word.trim() ||
            word.word.length > 128 ||
            !numberInRange(word.start, 0, source.duration) ||
            !numberInRange(word.end, 0, source.duration) ||
            word.end <= word.start ||
            word.start < previousEnd
          )
            return failure(
              "Word timestamp provider returned invalid word data.",
            );
          previousEnd = word.end;
          return { word: word.word, start: word.start, end: word.end };
        });
        cancelled(requestSignal);
        return { words: validated, model };
      } catch (error) {
        if (requestSignal.aborted)
          failure(
            signal?.aborted
              ? "Media processing was cancelled."
              : "Word timestamp transcription exceeded its time limit.",
          );
        if (error instanceof ScreeningMediaProcessingError) throw error;
        return failure("Word timestamp transcription could not be completed.");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

const wordPattern = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
function normalizedWord(value: string) {
  const matches = [...value.matchAll(wordPattern)];
  if (matches.length !== 1) return null;
  return matches[0][0]
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replaceAll("’", "'");
}

/** Conservative ASR-derived matching; ambiguity remains untimed, never interpolated. */
export function alignTranscriptWords(
  turns: Array<{
    id: string;
    text: string;
    startSeconds: number | null;
    endSeconds: number | null;
  }>,
  words: ScreeningAlignedWord[],
): ScreeningAlignedTurn[] {
  // Avoid quadratic work on oversized upstream payloads; all original text survives.
  const eligible = turns.length <= 2000 && words.length <= MAX_WORDS;
  const timedTurns = eligible
    ? turns.filter(
        (turn) =>
          numberInRange(turn.startSeconds, 0, MAX_SECONDS) &&
          numberInRange(turn.endSeconds, 0, MAX_SECONDS) &&
          turn.endSeconds! >= turn.startSeconds!,
      )
    : [];
  const validTimeline =
    eligible &&
    words.every(
      (word, index) =>
        typeof word.word === "string" &&
        word.word.length <= 128 &&
        numberInRange(word.start, 0, MAX_SECONDS) &&
        numberInRange(word.end, 0, MAX_SECONDS) &&
        word.end > word.start &&
        (index === 0 || word.start >= words[index - 1].end),
    );
  const candidates = validTimeline ? words : [];
  const owners = new Map<ScreeningAlignedWord, (typeof turns)[number]>();
  for (const word of candidates) {
    const contained = timedTurns.filter(
      (turn) =>
        word.start >= turn.startSeconds! && word.end <= turn.endSeconds!,
    );
    if (contained.length === 1) owners.set(word, contained[0]);
  }
  return turns.map((turn) => {
    const tokens: ScreeningTranscriptToken[] = [];
    const lexical: Array<{ index: number; key: string }> = [];
    let cursor = 0;
    for (const match of turn.text.matchAll(wordPattern)) {
      if (match.index > cursor)
        tokens.push({
          text: turn.text.slice(cursor, match.index),
          startSeconds: null,
          endSeconds: null,
        });
      lexical.push({ index: tokens.length, key: normalizedWord(match[0])! });
      tokens.push({ text: match[0], startSeconds: null, endSeconds: null });
      cursor = match.index + match[0].length;
    }
    if (cursor < turn.text.length)
      tokens.push({
        text: turn.text.slice(cursor),
        startSeconds: null,
        endSeconds: null,
      });
    if (lexical.length > 2000) return { id: turn.id, tokens };
    const observed = candidates.filter((word) => owners.get(word) === turn);
    const originalCounts = new Map<string, number>();
    const observedCounts = new Map<string, number>();
    lexical.forEach((token) =>
      originalCounts.set(token.key, (originalCounts.get(token.key) ?? 0) + 1),
    );
    observed.forEach((word) => {
      const key = normalizedWord(word.word);
      if (key) observedCounts.set(key, (observedCounts.get(key) ?? 0) + 1);
    });
    const unique = new Map<
      string,
      { word: ScreeningAlignedWord; index: number }
    >();
    observed.forEach((word, index) => {
      const key = normalizedWord(word.word);
      if (key && originalCounts.get(key) === 1 && observedCounts.get(key) === 1)
        unique.set(key, { word, index });
    });
    const pairs = lexical.flatMap((token) => {
      const found = unique.get(token.key);
      return found ? [{ token, ...found }] : [];
    });
    const suffixMin = Array<number>(pairs.length + 1).fill(Infinity);
    for (let i = pairs.length - 1; i >= 0; i--)
      suffixMin[i] = Math.min(suffixMin[i + 1], pairs[i].index);
    let prefixMax = -1;
    pairs.forEach((pair, index) => {
      if (pair.index > prefixMax && pair.index < suffixMin[index + 1]) {
        tokens[pair.token.index].startSeconds = pair.word.start;
        tokens[pair.token.index].endSeconds = pair.word.end;
      }
      prefixMax = Math.max(prefixMax, pair.index);
    });
    return { id: turn.id, tokens };
  });
}
