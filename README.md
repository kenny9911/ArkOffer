# ArkOffer

A recruiting workspace and public website reconstructed from observable Metaview pages, with ArkOffer branding. React, Express and SQLite provide a persistent local application, with configurable adapters for external services.

This is **not verified 100% Metaview parity**. REA captured the public website; the signed-in application was inspected through Chrome's desktop UI. The private source backend and enterprise account states were unavailable. See [coverage and gaps](docs/PARITY.md) and [evidence, architecture and provider setup](docs/RECONSTRUCTION.md).

## Run locally

Use Node.js 24 LTS (minimum 22.13).

```sh
npm ci
# Only if you do not already have .env:
cp .env.example .env
npm run dev
```

Open [http://localhost:5174](http://localhost:5174). The API defaults to port 3002; `PORT` in your existing `.env` overrides it and the Vite proxy follows that port. Register an independent ArkOffer account; optional example data is fictional. Metaview credentials and private account records are not included.

SQLite lives in `DATA_DIR/arkoffer.sqlite` and uploaded files in `DATA_DIR/uploads` (default `./data`). Both are excluded from Git. Back up the database, uploads and separately stored provider encryption key together while the app is stopped. Membership and session migrations preserve existing accounts.

## Working features

- Accounts, workspace membership and switching, owner/admin/member roles, expiring invitations, suspension/removal, password changes, session management, and provider-backed password recovery/email verification.
- Notes from transcripts, text/PDF/DOCX uploads and browser recordings; editing, snippets, templates, extraction, provider-backed summaries/transcription/translation, history, archive, export and expiring public links.
- Conversation ownership, viewer/editor grants, workspace visibility and comments, enforced across API reads, files, history and exports. Workspace assistant threads retrieve cited excerpts across accessible notes and persist their history.
- Candidate records and CSV import, local sourcing/search, manual application decisions, jobs, text/choice screening links with saved responses, optional spoken prompts and recorded answers with reviewed transcripts, local reports and CSV exports.
- Sequence previews and explicit enrollment approval, persistent scheduled delivery, pause/resume/cancel, unsubscribe suppression and provider status. Default **outbox mode does not send email**.
- Configurable Google/Microsoft calendar import, Greenhouse Harvest v3 import, Recall meeting capture, and Stripe subscription checkout/customer portal.
- Prompt-driven Sourcing with four guided modes, private search sessions, editable criteria, result packs, exclusions, review, import and CSV; optional People Data Labs discovery.
- Full-page sequence editor with an AI draft panel, manual steps, timezone schedules, formatted email and copied-recipient approval/suppression.
- Private AI screening questions and review rubrics, handed to the manual editor before saving or publishing candidate links.
- Professional candidate enrichment proposals with source provenance, selective field application and protection against concurrent edits.
- Private AI job-description drafts with editable previews and explicit application to a workspace job; existing status and metadata are preserved.
- Human-approved job criteria and private application evidence reviews with checked quotations, missing information, follow-up questions and reviewer notes. Hiring decisions remain manual.
- Private report views with selected conversations, typed AI columns, consent before processing, progress/cancellation, source evidence, annotations and CSV export.
- Per-section/TLDR note-edit drafts with evidence, preview, apply/discard and history; exact-term replacement can also cover all current notes and an explicitly selected transcript without AI.
- Slack app OAuth, explicit user linking, permission-aware questions, and personal digest/reminder schedules with draft approval and persistent delivery state.
- Responsive public pages, pricing controls, local articles, searchable integration directory, and saved demo/newsletter forms.

The drafting/review workflows use the existing shared text-AI provider and workspace allowlist; they add no text-provider environment variables. PDL search uses a separate `SOURCING_WORKSPACE_IDS` allowlist. Drafts and results are private to their author and workspace. Applying a note or job draft changes the workspace record only after explicit review; approved job criteria are shared with the workspace. Evidence reviews and report runs require consent, retain source references, and withhold stale or inaccessible evidence. [Workflow limits and remaining gaps](docs/RECONSTRUCTION.md#reviewed-ai-workflows) distinguish these tools from automated hiring or publishing.

The provider adapters are implemented, but no live calendar, ATS, meeting, mail or payment account is connected by this repository. Tests use local fixtures and mocked provider responses. Voice transcription, professional enrichment and Slack workflows need their own configured accounts. Natural-language automatic report construction, report subscriptions, CV ingestion, AI applicant ranking, ATS rejection/write-back and external job publishing remain unfinished, alongside real-time voice/video agents, autonomous Slack recruiting actions, comprehensive web/market research, SSO/SCIM and synchronized video clips.

## Configure services deliberately

The complete variable template is [.env.example](.env.example). Keep credentials on the server. Workspace allowlists contain comma-separated workspace UUIDs returned by authenticated `GET /api/workspaces`; an empty list enables no workspace for that operator-funded service. A signup cannot automatically spend shared provider credits.

| Service                   | Required setup                                                                                                                                                        | Actual behavior                                                                                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Text AI                   | `LLM_PROVIDER=openrouter`, `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` (or `OPENROUTER_API_BASE_URL`), `LLM_MODEL`, `LLM_WORKSPACE_IDS`; direct OpenAI also supported | Uses the configured model for notes, answers, sourcing plans, sequence/screening/job drafts, application evidence and report columns. Optional interview settings support one screening clarification. |
| Audio transcription       | `OPENAI_API_KEY`, `OPENAI_WORKSPACE_IDS`; optional model variables                                                                                                    | Transcribes uploaded media and bounded voice-screening answers. A text-only gateway does not imply audio support.                                                                                      |
| Candidate discovery       | `PDL_API_KEY`, `SOURCING_WORKSPACE_IDS`                                                                                                                               | Confirmed, bounded professional-profile search packs; separate from enrichment and local candidate-library search.                                                                                     |
| Candidate enrichment      | `PDL_API_KEY`, `ENRICHMENT_WORKSPACE_IDS`                                                                                                                             | Explicit professional-profile lookup, proposal review, selected-field apply; no automatic contact or hiring decision.                                                                                  |
| Slack                     | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, `SLACK_APP_ID`, `SLACK_ENCRYPTION_KEY`, `SLACK_APP_ORIGIN`, `SLACK_WORKSPACE_IDS`, `SLACK_TEAM_IDS` | Workspace OAuth, explicit account linking, private answers and opt-in personal automation.                                                                                                             |
| Google/Microsoft calendar | App client ID/secret, `CALENDAR_TOKEN_ENCRYPTION_KEY`, exact `CALENDAR_APP_ORIGIN` in `APP_ORIGIN`, provider callback registration                                    | Per-user/workspace OAuth, explicit primary-calendar sync for the next 30 days. No automatic meeting-bot rule.                                                                                          |
| Greenhouse                | `GREENHOUSE_CLIENT_ID`, `GREENHOUSE_CLIENT_SECRET`, `PROVIDER_WORKSPACE_IDS`; optional `GREENHOUSE_USER_ID`                                                           | Manual read-only Harvest v3 import of nonprivate candidates, nonconfidential jobs and associated applications.                                                                                         |
| Recall                    | `RECALL_API_KEY`, `RECALL_REGION`, `PROVIDER_WORKSPACE_IDS`                                                                                                           | Explicit consent, bot request, manual status refresh/leave/cancel and ready transcript import.                                                                                                         |
| Resend                    | `MAIL_MODE=resend`, `RESEND_API_KEY`, `MAIL_FROM`, HTTPS `PUBLIC_APP_URL`, `MAIL_WORKSPACE_IDS`                                                                       | Approved sequence email delivery. Password recovery and verification require live mail; tokens never enter the local outbox.                                                                           |
| Stripe                    | Secret key, webhook signing secret, configured recurring price IDs, HTTPS `PUBLIC_APP_URL`, `BILLING_WORKSPACE_IDS`                                                   | Owner/admin checkout, customer portal and signed webhook subscription updates. Test keys first; pricing-page amounts are illustrative.                                                                 |

See [detailed setup and limits](docs/RECONSTRUCTION.md#provider-configuration). Changing `.env` requires restarting the server. Calendar tokens are encrypted at rest; losing or replacing their encryption key requires reconnecting calendars. No production deployment or paid-provider configuration is performed automatically.

## Validate

```sh
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm run format:check
```

Tests use temporary databases and synthetic accounts. Browser tests start a production build on port 3412; macOS uses the installed Google Chrome when available. CI runs the API suite, build and browser suite on Node.js 24. The delivery PR records final run results; passing mocks do not establish live integration or complete source parity.

A separate isolated synthetic check completed all four new text-AI paths with the configured live model: job draft/apply, note edit/apply/version, application evidence review and queued report extraction/CSV. This bounded check does not establish continuous provider reliability, hiring quality or live operation of the other integrations.

## Production build

```sh
npm run build
npm start
```

Express serves frontend and API on `PORT` (default 3002). Production cookies require HTTPS. Set `APP_ORIGIN` to the exact public origin and, for enabled services, `PUBLIC_APP_URL` and `CALENDAR_APP_ORIGIN`. The default bind address is `127.0.0.1`; only set `TRUST_PROXY=1` for a trusted single-hop proxy with no direct bypass. Local HTTP development should use `npm run dev`.

This is a single-process SQLite/local-file deployment. The sequence, Slack and report workers run with the server; they cannot process work while it is stopped. Queued report runs can resume, while interrupted processing is marked explicitly and never automatically repeats a paid AI request. Shutdown stops report processing and drains pending Slack, outreach and account-mail work before closing storage. Provision durable storage, backups, monitoring, abuse controls and a production deployment before public use. The included legal pages are drafts.

## Project layout

- `client/marketing/`: public pages and interactions.
- `client/workspace/`: recruiting workspace, account and integration screens.
- `server/`: API, permissions, persistence, providers and document extraction.
- `tests/server/`, `tests/e2e/`: API boundaries and browser-to-storage workflows.
- [API reference](server/API.md), [parity matrix](docs/PARITY.md), [public asset provenance](public/marketing/origins.json).

Captured account data, cookies, provider credentials, runtime uploads and databases do not belong in commits.

The [source experience review](docs/SOURCE_REVIEW.md) records the signed-in audit, REA evidence, rebuilt Sourcing/Sequences/public screens and remaining feature gaps.
