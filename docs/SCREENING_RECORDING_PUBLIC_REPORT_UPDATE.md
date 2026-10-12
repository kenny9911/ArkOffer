# Interview recording, adaptive follow-ups and public reports — 13 October 2026

This delivery continues the [Screening and Reports reconstruction](SCREENING_REPORTS_UPDATE.md) and [delivery workflows](SCREENING_DELIVERY_UPDATE.md). It implements the three requested features independently, using the earlier signed-in observations and partial static REA evidence. It does not establish complete Metaview functionality, private backend equivalence or live provider operation.

## Consented video recording

A saved live screening can enable recording and choose 1–90 days of retention (default 30). Publication and invitation delivery check configuration. Candidates separately consent to recording before joining, in addition to live transcription consent. Camera policy remains required, optional or off; only published tracks are captured. The AI agent subscribes to audio and does not analyze appearance.

LiveKit Egress produces a 720p MP4 in a private S3-compatible bucket. The API persists recording intent before requesting Egress and reconciles ambiguous start outcomes instead of automatically starting duplicates. End, expiry, revocation and source deletion stop capture; recording-provider failure cannot prevent independent room cleanup. Background reconciliation survives process restart. Private reviewer playback/download supports HTTP byte ranges and rechecks active membership and the explicitly submitted session. Candidate links do not expose recordings. Typed-only final submissions can attach the reviewed live session; abandoned attempts remain excluded.

Owner/admin deletion removes playback access immediately and queues provider/object removal. Retention expiry also denies playback immediately; external deletion may wait for provider recovery. Cascaded source deletion retains cleanup tombstones. A private, encrypted bucket with public access blocked and lifecycle expiration provides an operational backstop. Bucket versioning requires cleanup of old versions too; storage credentials need exact-key object/version deletion and version-list permission. Do not enable Object Lock or an incompatible retention policy unless the resulting deletion failures are monitored and resolved.

Configuration uses existing `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, workspace allowlists, and `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, plus optional HTTPS `S3_ENDPOINT`. LiveKit Cloud must permit Egress, or self-hosted Egress must be deployed. The agent and speech provider from the earlier delivery still need to run. No credentials, services or buckets were provisioned by this change; `.env` was not modified.

## Adaptive interview clarifications

The live agent may ask one clarification after a text answer whose frozen published question explicitly enables follow-up. It uses the exact configured text gateway/model, with an eight-second deadline, no retry and a 2 KiB output limit. The model selects a bounded clarification focus and a verbatim excerpt from the answer; authored neutral templates render the spoken question in one of the seven supported screening languages. The model cannot choose a new hiring criterion, score the candidate or freely rewrite the interview.

Disabled follow-ups, choice questions, repeat and skip commands make no clarification-model request. Timeout, malformed or unsupported output preserves the original answer and advances to the next question. A candidate may repeat or skip either turn. Signed callbacks keep the original question identity, distinguish original/follow-up answers from skip commands and prevent duplicate turn resolution. Review displays the full transcript and structured follow-up evidence separately from candidate-corrected final answers. The candidate still explicitly submits; no automatic hiring decision is made.

This is bounded clarification, not arbitrary branching, resume-grounded questioning, automatic translation of the saved plan or Metaview's private model behavior. The questionnaire voice path remains separate and retains no raw audio archive.

## Reviewed public report results

A report author chooses a completed run of the current saved report, selected columns and conversations, public title/summary, optional conversation titles, optional CSV and a 1–30 day expiry. Preview displays the exact public projection before a separate confirmation publishes it. The author must own or administratively manage every selected conversation. The resulting capability URL is returned once; only its hash is stored. Link metadata remains available for permanent revocation.

Anonymous viewing and CSV export rebuild the selected projection and verify expiry, revocation, author membership, report/run state and current source authority/content. Changed or inaccessible source results invalidate the link. Public output excludes raw transcript quotes, extraction instructions, annotations, internal source/run IDs and screening media. Source-derived cell values can still contain sensitive information, which is why publication requires review. The public route and API use no-store, no-referrer and noindex headers. CSV export neutralizes spreadsheet formula prefixes.

A public link is a reviewed snapshot of selected completed results; it does not expose the live report workspace or subscribe anonymous viewers to changes. Existing named grants and email subscriptions continue separately.

## Validation and remaining gaps

Validation uses isolated synthetic workspaces and provider adapters, including the pinned SDK over mocked HTTP. Backend checks cover callback ordering/consent, submitted-session recording scope, byte ranges, revocation during storage access, retry/reconciliation and cleanup, plus public-link authority, projection, stale results, expiry and revoke. Browser flows cover candidate/reviewer states and actual local report preview, publication, anonymous access, CSV and revocation. Final combined counts and remote checks are recorded in the delivery PR.

During this delivery the configured text gateway was preserved. LiveKit credentials, S3 bucket and S3 access keys were absent, so actual camera capture, Egress upload, speech/model conversation and cloud object deletion remain unverified. These are real provider-backed implementations with readiness checks, not evidence of active external services. The current [parity matrix](PARITY.md) retains gaps such as transcript-synchronized seeking/editing, full-plan agent editing, advanced report datasets/charts, automatic ATS actions and source-scale functionality.
