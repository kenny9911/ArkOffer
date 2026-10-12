# Job AI and application review update

Date: 13 October 2026. This follows [AI_PARITY_UPDATE.md](AI_PARITY_UPDATE.md). ArkOffer retains its own branding, database and accounts. This delivery does not establish complete Metaview parity.

## Job AI timeout and recovery

The previous bounded job request timed out after 120 seconds without response headers. The same source-backed path succeeded before this change, so the evidence points to intermittent upstream latency rather than a deterministic parser or schema failure.

- Confirmed terminal failures now return their request ID and persisted status. The editor offers **Try a new AI draft** only after confirming that the previous attempt is terminal. Another paid attempt requires an explicit click.
- Lost connections, HTML gateway errors and running-request replays retain the original request ID. Retrying these requests checks the existing attempt rather than starting another generation. A successful response remains visible if refreshing history fails.
- Deleting a running private draft aborts its provider request. Late output cannot be persisted or applied, and deletion does not erase request budgets or provider usage already incurred. Both streamed and complete-JSON response readers explicitly honor deadlines and cancellation.
- The job prompt asks for concise output unless the brief requires otherwise. Optional general and task-specific reasoning controls are documented in `.env.example` and [API.md](../server/API.md). Recognized OpenAI reasoning model names default to low reasoning for this task; chat/pro/custom aliases retain provider defaults. Explicit valid configuration takes precedence; `provider` omits the setting. Unsupported configuration fails before a paid request.

The provider, exact model, 4,000-token output budget and 120-second deadline were preserved. No `.env` values were changed and no automatic provider retry was added. These changes improve bounded work and recovery; they do not guarantee availability or reduced latency.

## Private CV evidence

The application review panel now accepts PDF/DOCX uploads, shows extracted text, and allows explicit selection or deletion. Sources are private to the author, workspace and application. Uploading alone does not call AI or select a source. A review can include up to three selected CVs alongside the existing profile/transcript evidence, after consent.

The server resolves source text and fingerprints itself. It checks exact quotations and rechecks source identity, access and freshness before and after generation, on replay/history and before reviewer-note saves. Deletion or source changes withhold derived output and notes. Reviews identify supported evidence, missing information and follow-up questions without scores, rankings, integrity verdicts or automated hiring decisions. Protected characteristics and unrelated personal/contact details are excluded from qualification evidence in the provider instructions.

Files are bounded to 10 MB and 60,000 extracted characters. The isolated parser has concurrency, time and memory limits. Random private original files are removed after parsing or handled failure; only extracted text is retained. Retention and durable upload budgets apply independently of deletion. [API.md](../server/API.md#private-application-cv-documents) documents the routes and exact limits. ATS attachment import, scanned-document OCR and shared recruiter attachment libraries remain unimplemented.

## Collaborative job review

Job previews now include workspace comments, own-comment edit/delete, human review checks and review history. Job rows display comment and current-review counts. Comment revisions prevent overwriting concurrent edits; acknowledged saves clear the composer even when a subsequent refresh fails, preventing duplicate retries.

Each review check is bound to the exact displayed job version. Editing the job invalidates earlier checks, and inactive members do not count. A stale preview cannot approve a newer job. Server-side checks enforce workspace membership, ownership, revisions and request budgets. These are human checks, not reconstructed source-specific AI or compliance verdicts. No job is published externally.

## Sequence editor regression

The full browser suite exposed a selection race when inserting a link immediately after formatting text. An animation-frame callback could restore an obsolete selection and replace the greeting. Selection now restores with the committed textarea value before another keyboard action. The regression test deliberately delays animation callbacks and verifies that the formatted greeting and new link both survive.

The first GitHub run also exposed an ambiguous Sourcing test selector: before setup finished loading, it could click the navigation tab instead of the prompt control. Prompt choices now have a named accessible group, and the regression test scopes its interaction to that group while deliberately delaying setup. Prompt validation and its assertions remain intact.

## Source inspection and REA evidence

The signed-in source application-review route still displayed an ATS connection gate. It was observed and dismissed without connecting an account or creating source records. The source's protected application workflow was therefore not available for runtime comparison.

REA analyzed two public JavaScript route artifacts exposed by the site's public manifest: `routes/job-post.04d346b299.js` and `routes/application-review.5fb7d19f1f.js` (137,081 bytes total). Both parsed, producing 292 findings and 42,716 AST nodes. The semantic graph was partial at its 100,000-node ceiling, with unresolved imported modules; these observations do not establish private backend behavior or algorithm equivalence. Earlier visible comments/check columns are recorded in [SOURCE_REVIEW.md](SOURCE_REVIEW.md). The ArkOffer workflows above were independently implemented.

Evidence identifiers:

- Parent: `ev_88169b926f16d18e7558382c9e7bc81a7a8da527d1bee3cdc9230df259133098`
- Summary: `ev_e55370ade7bc70298cd6ea1441ff82c6561c0be23e2ace84f3896cf979d074d0`
- Artifact container SHA-256: `dda92ddf31ecf7782365a9a0e316ba493ddb90eb5f86fc9671c9c56d8d71ba5c`

Source bundles and runtime captures remain ignored and are not shipped with the repository.

## Verification

Live checks used the existing configured provider/model and synthetic records in disposable local databases. They did not publish jobs, change real candidate decisions or send outreach.

| Check                                | Result                                                                                                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unchanged source-backed job baseline | Passed in 7.65 seconds; one paid request, validated draft and explicit local apply.                                                                                                    |
| Updated source-backed job workflow   | Passed in 14.52 seconds; one paid request, validated draft and explicit local apply.                                                                                                   |
| CV-backed application review         | Passed in 11.38 seconds; DOCX extraction, consent, checked quotations, replay without another paid request, unchanged application status and output withholding after source deletion. |

These individual samples verify successful paths, not a latency improvement. The automated suite covers provider deadlines, cancellation, request identity, cross-workspace access, source revocation, parsing limits, quote validation and concurrent edits. Final combined validation passed: **300 backend tests, 61 browser tests, TypeScript checking, production build and formatting**. Independent reviews also checked the CV privacy boundaries, job request lifecycle, provider profile and collaboration retry behavior.

The [parity matrix](PARITY.md) remains partial. Significant gaps include source-scale discovery, real-time screening agents, mailbox integrations, ATS attachment import/write-back, scheduled reports, external job publishing and enterprise controls. Implemented provider adapters also require their own credentials and live verification; no claim of 100% functionality is made.
