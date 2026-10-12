# AI reliability and parity update — 13 October 2026

This implementation follows the [signed-in source review](SOURCE_REVIEW.md). ArkOffer still does not have 100% Metaview parity; [PARITY.md](PARITY.md) distinguishes implemented behavior from open features and provider limits.

The subsequent [job/application follow-up](JOB_AI_APPLICATION_UPDATE.md) verifies job AI live again and adds timeout recovery, private CV evidence and job collaboration. The timeout below remains the record of this earlier delivery.

## Sequence AI failure

The follow-up reproduced a second failure underneath the earlier connection failures: the provider returned a valid LinkedIn message with an empty subject, but the draft schema required a subject for every channel. Subjects are now required only for automatic email, manual email and InMail. LinkedIn messages/connections, calls, SMS and tasks accept optional titles. The same rule applies to proposal validation and approved delivery, so accepting the draft does not leave a later launch failure.

Sequence generation also opts into Chat Completions streaming while keeping the same configured provider, model and output budget. The server parses bounded SSE frames, split UTF-8, comments and usage events. A usable result requires the primary choice's successful stop and completion sentinel; another choice cannot complete it. Provider errors, refusals, length limits, truncated streams and invalid JSON never become saved draft content. Compatible gateways may return complete JSON instead, which must also end successfully. Cancellation and the 120-second deadline remain in force. There are no automatic retries or model substitutions.

Two isolated live sequence checks passed with synthetic inputs using the existing `.env` configuration. The second completed generation and an explicit local draft save in approximately 29 seconds. Neither enrolled recipients nor sent messages. This verifies the exercised path, not uninterrupted provider availability.

## Job creation

Create job post now opens blank, template, intake conversation and PDF/DOCX choices. Three original templates can be used without AI. Intake previews enforce the existing note/collection access rules. Uploaded originals are removed after bounded extraction; extracted text remains in an author/workspace-scoped source library, separate from Notes. An explicit source-copy action creates an editable private draft without a provider; AI can instead draft from server-resolved source facts. Shared job creation remains a separate reviewed action.

Source fingerprints, session identity and access are checked before and after generation and on history, retries and apply. Revoked, changed or deleted sources hide derived draft content. Long imported descriptions remain compatible with later improvement. Running retries retain the original paid-request identity. Safe provider deadline errors are preserved; unexpected provider details remain hidden.

Limits include 10 MB/file, 60,000 extracted characters, 20 upload attempts/workspace/hour, 30 private documents/user/workspace, and the existing isolated parser limits. The intake picker discloses its latest-500-conversation scan. There is no OCR, careers-site discovery, custom template management, collaborative job review or external publication.

The new source-backed job AI check did not pass live: a diagnostic attempt reached the 120-second provider deadline before response headers arrived. No shared job was created. This is a live-provider limitation, not a passing check. Template, intake and document-copy flows passed isolated browser/API tests, and model behavior is covered by mocked-provider tests.

## Report construction and charts

A prompt can now produce a private report definition with an editable question, supported title/date filters and up to five typed columns. Only the supplied brief is sent to the provider. Applying the proposal preserves manually selected sources and does not save a report or start extraction. Generation, editor application, saving and running remain distinct actions. Proposals enforce private ownership, revision checks, consent, retained request identities and separate hourly budgets.

Saved presentation controls provide table/bar display, grouping, conversation counts and numeric/currency sums or averages. Presentation revisions are independent of extraction revisions; changing a chart does not buy another extraction or interrupt a run. Historical controls and validation use the selected owned run's column snapshot. Aggregates and grouped CSV consume only currently authorized, unchanged-source results. Currency codes remain separate, and missing, failed and pending values are disclosed rather than treated as zero.

An isolated live check passed prompt generation, explicit definition application/save and persisted grouping in approximately 10 seconds with the configured model. It did not start another extraction. Remaining gaps include participant/talk-time/late-start filters, shared dashboards, scheduled subscriptions, arbitrary chart types and unrestricted source selection.

## Verification

Local validation passed 282 backend tests, the complete 55-test browser suite, the production build and formatting. The six job/report browser tests passed again after the final presentation adjustment. The delivery PR records remote CI results. Focused regressions cover partial streams, mixed completion choices, subjectless manual tasks, upload cleanup, source revocation, long imported descriptions, paid-request replay, currency/null handling and historical chart editing. Browser tests use synthetic identities and isolated stores. No credentials, actual account records, private runtime data or source bundles are committed; no external outreach or publishing was performed.
