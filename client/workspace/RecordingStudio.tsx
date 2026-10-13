import { memo, useEffect, useRef, useState, type RefObject } from "react";
import "./recording-studio.css";

type Segment = { startSeconds: number; endSeconds: number; muted: boolean };
type Edit = {
  id: string;
  title: string;
  revision: number;
  segments: Segment[];
  createdAt: string;
  updatedAt: string;
};
type Job = {
  id: string;
  kind: "alignment" | "export";
  editId: string | null;
  editTitle: string | null;
  editRevision: number | null;
  state: "queued" | "processing" | "ready" | "failed" | "cancelled";
  error: string | null;
  createdAt: string;
};
type Studio = {
  canEdit: boolean;
  capabilities: {
    clipping: { available: boolean; missing: string[] };
    alignment: { available: boolean; missing: string[]; model: string };
  };
  edits: Edit[];
  jobs: Job[];
  alignment: {
    jobId: string;
    model: string;
    matched: number;
    total: number;
  } | null;
};
type Draft = { title: string; segments: Segment[] };
const emptyDraft = (): Draft => ({ title: "", segments: [] });
const draftFrom = (edit: Edit): Draft => ({
  title: edit.title,
  segments: edit.segments,
});
const pending = (job: Job) => ["queued", "processing"].includes(job.state);
const seconds = (value: number) => Math.round(value * 1000) / 1000;

function RecordingStudio({
  path,
  video,
  duration,
  seek,
  onAlignmentReady,
}: {
  path: string;
  video: RefObject<HTMLVideoElement | null>;
  duration: number;
  seek: (value: number) => void;
  onAlignmentReady: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [studio, setStudio] = useState<Studio | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [consent, setConsent] = useState(false);
  const [selected, setSelected] = useState("");
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [baseline, setBaseline] = useState<{ draft: Draft; revision: number }>({
    draft: emptyDraft(),
    revision: 0,
  });
  const [nextSelection, setNextSelection] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    kind: "edit" | "job";
    id: string;
  } | null>(null);
  const [notice, setNotice] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [exportPreview, setExportPreview] = useState("");
  const preview = useRef<{
    segments: Segment[];
    index: number;
    muted: boolean;
  } | null>(null);
  const advancePreview = useRef<(() => void) | null>(null);
  const observedAlignment = useRef<string | null | undefined>(undefined);
  const requestKeys = useRef(new Map<string, string>());
  const onReady = useRef(onAlignmentReady);
  onReady.current = onAlignmentReady;
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline.draft);
  const latest = studio?.edits.find((edit) => edit.id === selected);
  const conflict =
    !!selected && !!studio && (!latest || latest.revision > baseline.revision);
  const total = draft.segments.reduce(
    (sum, item) => sum + item.endSeconds - item.startSeconds,
    0,
  );
  const validSegments =
    draft.segments.length > 0 &&
    draft.segments.length <= 12 &&
    draft.segments.every(
      (item) =>
        Number.isFinite(item.startSeconds) &&
        Number.isFinite(item.endSeconds) &&
        item.startSeconds >= 0 &&
        item.endSeconds - item.startSeconds >= 0.1 - 1e-9 &&
        item.endSeconds <= duration,
    ) &&
    total <= Math.min(duration, 1800);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    fetch(`/api/${path}/studio`, {
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error || "Could not load the recording studio.");
        if (controller.signal.aborted) return;
        setStudio(data);
        const alignmentId = data.alignment?.jobId || null;
        if (observedAlignment.current !== alignmentId) {
          observedAlignment.current = alignmentId;
          onReady.current();
        }
      })
      .catch((cause: Error) => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    return () => controller.abort();
  }, [open, path, refresh]);

  useEffect(() => {
    if (!open || !studio?.jobs.some(pending)) return;
    const timer = setTimeout(() => setRefresh((value) => value + 1), 3000);
    return () => clearTimeout(timer);
  }, [open, studio, refresh]);

  useEffect(() => {
    if (dirty || !latest || latest.revision <= baseline.revision) return;
    const value = draftFrom(latest);
    setDraft(value);
    setBaseline({ draft: value, revision: latest.revision });
  }, [latest, dirty, baseline.revision]);

  function stopPreview() {
    const active = preview.current;
    preview.current = null;
    if (active && video.current) {
      video.current.pause();
      video.current.muted = active.muted;
    }
    setPreviewing(false);
  }
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    function advance() {
      const active = preview.current;
      if (!active || !element) return;
      const segment = active.segments[active.index];
      if (
        element.currentTime < segment.startSeconds - 0.15 ||
        element.currentTime >= segment.endSeconds - 0.025
      ) {
        if (++active.index >= active.segments.length) {
          preview.current = null;
          element.pause();
          element.muted = active.muted;
          setPreviewing(false);
          return;
        }
        const next = active.segments[active.index];
        element.currentTime = next.startSeconds;
        element.muted = next.muted;
        void element.play().catch(() => {
          preview.current = null;
          element.muted = active.muted;
          setPreviewing(false);
          setError(
            "Preview could not continue. Use the original video controls and retry.",
          );
        });
      }
    }
    advancePreview.current = advance;
    element.addEventListener("timeupdate", advance);
    element.addEventListener("ended", advance);
    return () => {
      advancePreview.current = null;
      element.removeEventListener("timeupdate", advance);
      element.removeEventListener("ended", advance);
      const active = preview.current;
      if (active) {
        element.pause();
        element.muted = active.muted;
        preview.current = null;
      }
    };
  }, [video]);
  useEffect(() => {
    if (!previewing) return;
    let frame = 0;
    function tick() {
      advancePreview.current?.();
      frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [previewing]);

  async function request(endpoint: string, method: string, body?: unknown) {
    const response = await fetch(`/api/${path}/studio${endpoint}`, {
      method,
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 409) setRefresh((value) => value + 1);
      throw new Error(
        response.status === 409
          ? `${data.error || "The saved edit changed."} Your draft is preserved. Load the latest saved edit or save a new copy.`
          : data.error || "The recording operation failed.",
      );
    }
    return data;
  }
  async function queue(
    endpoint: string,
    operation: string,
    body: Record<string, unknown>,
  ) {
    const key = requestKeys.current.get(operation) || crypto.randomUUID();
    requestKeys.current.set(operation, key);
    const data = await request(endpoint, "POST", { ...body, requestKey: key });
    requestKeys.current.delete(operation);
    return data;
  }
  async function run(name: string, action: () => Promise<void>) {
    setBusy(name);
    setError("");
    setNotice("");
    try {
      await action();
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError((cause as Error).message);
      setRefresh((value) => value + 1);
    } finally {
      setBusy("");
    }
  }
  function choose(id: string) {
    stopPreview();
    const edit = studio?.edits.find((item) => item.id === id);
    const value = edit ? draftFrom(edit) : emptyDraft();
    setSelected(edit?.id || "");
    setDraft(value);
    setBaseline({ draft: value, revision: edit?.revision || 0 });
    setNextSelection(null);
    setError("");
    setNotice("");
  }
  async function save(copy = false) {
    await run("save", async () => {
      const data = await request(
        selected && !copy ? `/edits/${selected}` : "/edits",
        selected && !copy ? "PUT" : "POST",
        {
          ...draft,
          ...(selected && !copy ? { revision: baseline.revision } : {}),
        },
      );
      const value = draftFrom(data.edit);
      setDraft(value);
      setSelected(data.edit.id);
      setBaseline({ draft: value, revision: data.edit.revision });
      setStudio(
        (current) =>
          current && {
            ...current,
            edits: [
              ...current.edits.filter((item) => item.id !== data.edit.id),
              data.edit,
            ],
          },
      );
      setNotice("Edit saved. Export creates a separate video file.");
    });
  }
  function changeSegment(index: number, patch: Partial<Segment>) {
    stopPreview();
    setDraft((current) => ({
      ...current,
      segments: current.segments.map((item, position) =>
        position === index ? { ...item, ...patch } : item,
      ),
    }));
  }
  function reorder(index: number, movement: number) {
    stopPreview();
    setDraft((current) => {
      const segments = [...current.segments];
      [segments[index], segments[index + movement]] = [
        segments[index + movement],
        segments[index],
      ];
      return { ...current, segments };
    });
  }
  async function playPreview() {
    const element = video.current;
    if (!element || !validSegments) return;
    stopPreview();
    setError("");
    preview.current = {
      segments: draft.segments.map((item) => ({ ...item })),
      index: 0,
      muted: element.muted,
    };
    setPreviewing(true);
    element.muted = draft.segments[0].muted;
    seek(draft.segments[0].startSeconds);
    try {
      await element.play();
    } catch {
      stopPreview();
      setError("Preview could not play. Load the video and retry.");
    }
  }
  const canEdit = !!studio?.canEdit;
  return (
    <section className="recording-studio" aria-label="Recording studio">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          if (open) stopPreview();
          setOpen(!open);
        }}
      >
        {open ? "Hide recording studio" : "Word timing & video editor"}
      </button>
      {open && (
        <div className="recording-studio-body">
          <header>
            <h3>Recording studio</h3>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => {
                setError("");
                setRefresh((value) => value + 1);
              }}
            >
              Refresh studio
            </button>
          </header>
          <p className="screening-candidate-muted">
            Create private excerpts from this recording. Saved edits and exports
            preserve the original video and transcript. Exports expire with the
            source recording.
          </p>
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
          {!studio ? (
            <p role="status">Loading recording studio…</p>
          ) : (
            <>
              {!canEdit && (
                <p>
                  Only workspace owners and admins can create edits, exports or
                  word timing. You can preview saved edits and download
                  available exports.
                </p>
              )}
              <section
                className="recording-studio-alignment"
                aria-label="Word timing"
              >
                <h4>Word timing</h4>
                <p>
                  Speech recognition matches words to the original transcript.
                  Matched words become seek buttons; unmatched text stays
                  readable without estimated timings. These timings can be
                  imperfect.
                </p>
                {studio.alignment && (
                  <p>
                    {studio.alignment.matched} of {studio.alignment.total} words
                    matched · {studio.alignment.model}
                  </p>
                )}
                {!studio.capabilities.alignment.available && (
                  <p>
                    Word timing is unavailable:{" "}
                    {studio.capabilities.alignment.missing.join(", ") ||
                      "speech processing is not configured"}
                    .
                  </p>
                )}
                {canEdit && (
                  <>
                    <label className="recording-studio-check">
                      <input
                        type="checkbox"
                        checked={consent}
                        disabled={
                          !!busy || !studio.capabilities.alignment.available
                        }
                        onChange={(event) => setConsent(event.target.checked)}
                      />
                      I agree to send this recording’s audio to the configured
                      speech provider for transcription. Usage charges may
                      apply.
                    </label>
                    <p className="screening-candidate-muted">
                      Speech model:{" "}
                      {studio.capabilities.alignment.model || "Not configured"}
                    </p>
                    <button
                      type="button"
                      disabled={
                        !!busy ||
                        !consent ||
                        !studio.capabilities.alignment.available ||
                        studio.jobs.some(
                          (job) => job.kind === "alignment" && pending(job),
                        )
                      }
                      onClick={() =>
                        void run("alignment", async () => {
                          await queue("/alignment", "alignment", {
                            consent: true,
                          });
                          setConsent(false);
                          setNotice(
                            "Word timing queued. Processing continues in the background.",
                          );
                        })
                      }
                    >
                      {busy === "alignment"
                        ? "Queuing…"
                        : "Generate word timing"}
                    </button>
                  </>
                )}
              </section>
              <section aria-label="Video edit">
                <h4>Video edit</h4>
                {!studio.capabilities.clipping.available && (
                  <p>
                    Video export is unavailable:{" "}
                    {studio.capabilities.clipping.missing.join(", ") ||
                      "media processing is not configured"}
                    . You can still save and preview edit selections.
                  </p>
                )}
                <label>
                  Saved edit
                  <select
                    aria-label="Saved edit"
                    value={selected}
                    disabled={!!busy}
                    onChange={(event) => {
                      if (dirty) setNextSelection(event.target.value);
                      else choose(event.target.value);
                    }}
                  >
                    <option value="">
                      {canEdit ? "New edit" : "Select a saved edit"}
                    </option>
                    {studio.edits.map((edit) => (
                      <option key={edit.id} value={edit.id}>
                        {edit.title} · revision {edit.revision}
                      </option>
                    ))}
                    {selected && !latest && (
                      <option value={selected}>
                        Deleted edit (local draft)
                      </option>
                    )}
                  </select>
                </label>
                {nextSelection !== null && (
                  <div
                    className="recording-studio-confirm"
                    role="group"
                    aria-label="Discard unsaved edit"
                  >
                    <p>
                      You have unsaved changes. Discard them and switch edits?
                    </p>
                    <button type="button" onClick={() => choose(nextSelection)}>
                      Discard draft and switch
                    </button>
                    <button
                      type="button"
                      onClick={() => setNextSelection(null)}
                    >
                      Keep editing
                    </button>
                  </div>
                )}
                {conflict && (
                  <div className="recording-studio-confirm">
                    <p>
                      The saved edit changed or was removed. Your draft is
                      preserved.
                    </p>
                    <button
                      type="button"
                      disabled={!!busy}
                      onClick={() => setNextSelection(latest?.id || "")}
                    >
                      Load latest saved edit
                    </button>
                  </div>
                )}
                {(canEdit || selected) && (
                  <>
                    <label>
                      Edit title
                      <input
                        value={draft.title}
                        maxLength={120}
                        disabled={!canEdit || !!busy}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            title: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <p className="screening-candidate-muted">
                      Keep up to 12 ranges in the order below. Times are seconds
                      in the original video; each range must be at least 0.1
                      seconds. Total length cannot exceed{" "}
                      {Math.min(duration, 1800).toFixed(1)} seconds.
                    </p>
                    <ol
                      className="recording-studio-segments"
                      aria-label="Edit ranges"
                    >
                      {draft.segments.map((segment, index) => (
                        <li key={index}>
                          <fieldset disabled={!canEdit || !!busy}>
                            <legend>Range {index + 1}</legend>
                            <div className="recording-studio-range">
                              <label>
                                Start (seconds)
                                <input
                                  aria-label={`Range ${index + 1} start`}
                                  type="number"
                                  step="0.001"
                                  min="0"
                                  max={duration}
                                  value={
                                    Number.isNaN(segment.startSeconds)
                                      ? ""
                                      : segment.startSeconds
                                  }
                                  onChange={(event) =>
                                    changeSegment(index, {
                                      startSeconds: event.target.valueAsNumber,
                                    })
                                  }
                                />
                              </label>
                              <button
                                type="button"
                                onClick={() =>
                                  changeSegment(index, {
                                    startSeconds: Math.min(
                                      duration,
                                      seconds(video.current?.currentTime || 0),
                                    ),
                                  })
                                }
                              >
                                Use current time as start
                              </button>
                              <label>
                                End (seconds)
                                <input
                                  aria-label={`Range ${index + 1} end`}
                                  type="number"
                                  step="0.001"
                                  min="0.1"
                                  max={duration}
                                  value={
                                    Number.isNaN(segment.endSeconds)
                                      ? ""
                                      : segment.endSeconds
                                  }
                                  onChange={(event) =>
                                    changeSegment(index, {
                                      endSeconds: event.target.valueAsNumber,
                                    })
                                  }
                                />
                              </label>
                              <button
                                type="button"
                                onClick={() =>
                                  changeSegment(index, {
                                    endSeconds: Math.min(
                                      duration,
                                      seconds(video.current?.currentTime || 0),
                                    ),
                                  })
                                }
                              >
                                Use current time as end
                              </button>
                            </div>
                            <label className="recording-studio-check">
                              <input
                                type="checkbox"
                                checked={segment.muted}
                                onChange={(event) =>
                                  changeSegment(index, {
                                    muted: event.target.checked,
                                  })
                                }
                              />
                              Mute range {index + 1}
                            </label>
                            <div className="recording-studio-actions">
                              <button
                                type="button"
                                disabled={index === 0}
                                aria-label={`Move range ${index + 1} up`}
                                onClick={() => reorder(index, -1)}
                              >
                                Move up
                              </button>
                              <button
                                type="button"
                                disabled={index === draft.segments.length - 1}
                                aria-label={`Move range ${index + 1} down`}
                                onClick={() => reorder(index, 1)}
                              >
                                Move down
                              </button>
                              <button
                                type="button"
                                aria-label={`Remove range ${index + 1}`}
                                onClick={() => {
                                  stopPreview();
                                  setDraft((current) => ({
                                    ...current,
                                    segments: current.segments.filter(
                                      (_, position) => position !== index,
                                    ),
                                  }));
                                }}
                              >
                                Remove range
                              </button>
                            </div>
                          </fieldset>
                        </li>
                      ))}
                    </ol>
                    {canEdit && (
                      <button
                        type="button"
                        disabled={
                          !!busy ||
                          draft.segments.length >= 12 ||
                          !(duration >= 0.1)
                        }
                        onClick={() => {
                          stopPreview();
                          const start = Math.min(
                            Math.min(
                              duration,
                              seconds(video.current?.currentTime || 0),
                            ),
                            Math.max(0, duration - 0.1),
                          );
                          setDraft((current) => ({
                            ...current,
                            segments: [
                              ...current.segments,
                              {
                                startSeconds: start,
                                endSeconds: Math.min(
                                  duration,
                                  seconds(Math.min(duration, start + 10)),
                                ),
                                muted: false,
                              },
                            ],
                          }));
                        }}
                      >
                        Add range at current time
                      </button>
                    )}
                    {draft.segments.length > 0 && (
                      <p>
                        {Number.isFinite(total) ? total.toFixed(3) : "—"}{" "}
                        seconds selected
                        {!validSegments
                          ? ". Check range boundaries and total length before saving or previewing."
                          : "."}
                      </p>
                    )}
                    <div className="recording-studio-actions">
                      <button
                        type="button"
                        disabled={!validSegments}
                        onClick={() =>
                          previewing ? stopPreview() : void playPreview()
                        }
                      >
                        {previewing
                          ? "Stop edit preview"
                          : "Preview edit on original"}
                      </button>
                      {canEdit && (
                        <>
                          <button
                            type="button"
                            disabled={
                              !!busy ||
                              !draft.title.trim() ||
                              !validSegments ||
                              !dirty ||
                              conflict ||
                              (!selected && studio.edits.length >= 20)
                            }
                            onClick={() => void save()}
                          >
                            {busy === "save" ? "Saving…" : "Save edit"}
                          </button>
                          {selected && (
                            <button
                              type="button"
                              disabled={
                                !!busy ||
                                !draft.title.trim() ||
                                !validSegments ||
                                studio.edits.length >= 20
                              }
                              onClick={() => void save(true)}
                            >
                              Save as new edit
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={
                              !!busy ||
                              !selected ||
                              dirty ||
                              conflict ||
                              !studio.capabilities.clipping.available ||
                              studio.jobs.some(
                                (job) =>
                                  job.editId === selected && pending(job),
                              )
                            }
                            onClick={() =>
                              void run("export", async () => {
                                await queue(
                                  `/edits/${selected}/export`,
                                  `export:${selected}:${baseline.revision}`,
                                  { revision: baseline.revision },
                                );
                                setNotice(
                                  "Export queued. Your original recording is unchanged.",
                                );
                              })
                            }
                          >
                            {busy === "export"
                              ? "Queuing…"
                              : "Export saved edit"}
                          </button>
                          {selected && (
                            <button
                              type="button"
                              disabled={!!busy || conflict}
                              onClick={() =>
                                setConfirm({ kind: "edit", id: selected })
                              }
                            >
                              Delete saved edit
                            </button>
                          )}
                        </>
                      )}
                    </div>
                    {dirty && (
                      <p className="screening-candidate-muted">
                        Unsaved changes. Save before exporting.
                      </p>
                    )}
                    {previewing && (
                      <p role="status">
                        Previewing the selected ranges on the original player
                        above. Muted ranges silence this preview.
                      </p>
                    )}
                  </>
                )}
              </section>
              <section aria-label="Media processing jobs">
                <h4>Processing & exports</h4>
                {studio.jobs.length === 0 ? (
                  <p>No processing jobs yet.</p>
                ) : (
                  <ul className="recording-studio-jobs">
                    {studio.jobs.map((job) => (
                      <li key={job.id}>
                        <strong>
                          {job.kind === "alignment"
                            ? "Word timing"
                            : job.editTitle || "Video export"}
                        </strong>
                        {job.editRevision !== null && (
                          <span> · revision {job.editRevision}</span>
                        )}
                        <span> · {job.state}</span>
                        {job.error && <p>{job.error}</p>}
                        <div className="recording-studio-actions">
                          {job.kind === "export" && job.state === "ready" && (
                            <>
                              <button
                                type="button"
                                onClick={() =>
                                  setExportPreview(
                                    exportPreview === job.id ? "" : job.id,
                                  )
                                }
                              >
                                {exportPreview === job.id
                                  ? "Close export preview"
                                  : "Preview export"}
                              </button>
                              <a
                                href={`/api/${path}/studio/jobs/${job.id}/media?download=1`}
                                download="screening-excerpt.mp4"
                              >
                                Download export MP4
                              </a>
                            </>
                          )}
                          {canEdit && pending(job) && (
                            <button
                              type="button"
                              disabled={!!busy}
                              onClick={() =>
                                void run(job.id, async () => {
                                  await request(`/jobs/${job.id}`, "DELETE");
                                  setNotice("Processing cancelled.");
                                })
                              }
                            >
                              Cancel{" "}
                              {job.kind === "alignment"
                                ? "word timing"
                                : "export"}
                            </button>
                          )}
                          {canEdit &&
                            job.kind === "export" &&
                            job.state === "ready" && (
                              <button
                                type="button"
                                disabled={!!busy}
                                onClick={() =>
                                  setConfirm({ kind: "job", id: job.id })
                                }
                              >
                                Remove export
                              </button>
                            )}
                        </div>
                        {exportPreview === job.id && job.state === "ready" && (
                          <video
                            controls
                            playsInline
                            preload="metadata"
                            aria-label={`Export preview: ${job.editTitle || "Video export"}`}
                            src={`/api/${path}/studio/jobs/${job.id}/media`}
                            onError={() =>
                              setError(
                                "This export is unavailable. Refresh the studio to check its status.",
                              )
                            }
                          />
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {studio.jobs.some(pending) && (
                  <p role="status">
                    Processing continues in the background. Job status refreshes
                    automatically.
                  </p>
                )}
              </section>
              {confirm && (
                <div
                  className="recording-studio-confirm"
                  role="group"
                  aria-label="Confirm studio deletion"
                >
                  <p>
                    {confirm.kind === "job"
                      ? "Remove this exported video? The original recording and saved edit remain available."
                      : "Delete this saved edit? The original recording remains available. Related exports may no longer be available."}
                  </p>
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() =>
                      void run("delete", async () => {
                        if (confirm.kind === "job") {
                          await request(`/jobs/${confirm.id}`, "DELETE");
                          setExportPreview("");
                        } else {
                          await request(`/edits/${confirm.id}`, "DELETE", {
                            revision: baseline.revision,
                          });
                          choose("");
                        }
                        setConfirm(null);
                        setNotice("Removed.");
                      })
                    }
                  >
                    Confirm removal
                  </button>
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => setConfirm(null)}
                  >
                    Keep it
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

export default memo(RecordingStudio);
