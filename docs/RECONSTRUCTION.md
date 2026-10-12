# ArkOffer reconstruction: evidence and scope

ArkOffer is a working local full-stack reconstruction of the observed Metaview website and selected recruiting workflows. It is **not a 100% functional clone of Metaview**. It has its own React frontend, Express API, SQLite storage, authentication, and optional external-provider adapters. Metaview's private source code, backend services, production datasets, and integration credentials were not obtained.

This record describes the implementation reviewed on **12 October 2026**. [PARITY.md](PARITY.md) maps source products and routes to local behavior and remaining gaps. [The API reference](../server/API.md) documents the actual request contracts and limits.

## Evidence ledger

| Evidence                                     | What it establishes                                                                                                                                    | Limits                                                                                                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| REA 6.4 installation and public-page capture | REA was available and used to inspect the public homepage. Capture evidence ID: `ev_f28ec07e8cadd59531a10f65532bd21e715407f4b36b8a2a98ea421531d49817`. | A public-page observation does not expose the application's private server implementation.                                                                                                                         |
| REA public browser result                    | DOM, accessibility structure, screenshot, and request metadata supported the homepage layout and asset selection.                                      | The result declared `completeness: incomplete`, a missing `events` section, and `equality_eligible: false`. Response bodies were not captured. It is not an exhaustive equivalence test.                           |
| Signed-in native Chrome observation          | The authenticated notes, templates, and demo views informed the workspace navigation, note editor, source panel, and template library.                 | Direct authenticated REA inspection was blocked by the Chrome protocol change and macOS access to `DevToolsActivePort`. Native observation supplied visible UI evidence, not backend or complete account behavior. |
| Public product pages and official help pages | Published product scope, route families, workflows, and integration dependencies. Source links are listed below and in the parity matrix.              | Published descriptions establish advertised behavior, not a successful end-to-end test of the original service.                                                                                                    |
| Local implementation review                  | The repository frontend and API show which controls read and write local data and which features are gated or absent.                                  | A visible button, a generic resource endpoint, or a product landing page alone does not establish functional parity.                                                                                               |
| Local automated and browser checks           | Targeted persistence, isolation, error handling, forms, and responsive workflows can be exercised independently of Metaview.                           | Provider mocks and local fixtures do not validate a live external service, production capacity, or Metaview equivalence.                                                                                           |

Raw browser captures and private account observations remain outside the repository. Only public source URLs, a nonsecret evidence identifier, and implementation documentation belong here. Local review artifacts included `rea-public-evidence.json`, `arkoffer-marketing-desktop.png`, `arkoffer-marketing-mobile.png`, and `arkoffer-marketing-pricing.png`; these filenames identify review outputs, not distributable account data.

## What runs locally

React, TypeScript, React Router and Vite serve public and signed-in screens. Express serves authenticated workspace APIs and selected public-token/form routes. SQLite persists `DATA_DIR/arkoffer.sqlite`; source files live under `DATA_DIR/uploads`. The application does not forward requests to Metaview or reuse its authenticated endpoints, tracking scripts or cookies.

Signup creates a personal workspace with 12 editable built-in templates and optional fictional examples. Users can create or join more workspaces. Additive migrations preserve legacy accounts and populate memberships once; removed memberships are not recreated at restart. A session selects one active workspace independently of sessions on other browsers.

Passwords use salted scrypt. Seven-day session cookies are HttpOnly, SameSite=Lax and Secure in production; only token hashes are stored. Public session-management IDs do not expose the cookie token. Mutations require an allowed Origin except provider webhooks with their own signature verification. Workspace settings and management operations enforce roles.

Notes have an owner, private/workspace visibility and optional viewer/editor grants to active teammates. Owners and administrators can read workspace notes. Member access is limited to owned, explicitly shared or workspace-visible conversations, including permissions inherited from shared collections. Permission checks cover lists, direct reads, edits, uploads/downloads, versions, public-link management, comments, assistant sources and exports. Comments are persistent; this is not real-time multi-cursor editing.

The product also supports local candidate/job/application records, CSV imports, manual recruiting decisions, templates, text/choice screening questionnaires, persistent published responses, reports, public intake forms and the public marketing pages described in the parity matrix. New team invitations are seven-day copy links, stored as hashes and accepted once by a matching signed-in email. Possession of a copied invite is a capability; an unverified signup email is not independent proof of mailbox ownership. Invitation emails are not automatically sent.

## AI, retrieval and files

Without both `OPENAI_API_KEY` and the current workspace ID in `OPENAI_WORKSPACE_IDS`, notes and Q&A use labeled transcript extraction. A supplied server credential alone does not enable every newly registered workspace. Template synthesis, translation and audio transcription require the allowed provider path. Local extraction respects format/length preferences and preserves source language.

Explicit allowed actions request summaries, translation, transcription or answers from the configured OpenAI model. Single-conversation generation/Q&A clips source input at 100,000 characters and returns source metadata. Provider errors preserve existing notes; concurrent edits cause a conflict instead of an overwrite. Provider response tests use mocks, not live paid accounts.

The workspace assistant at `/app/fillmore` keeps per-user, per-workspace threads and citations across accessible, unarchived notes. Local retrieval ranks matching transcript excerpts, taking at most three per conversation and 12 overall, with each excerpt capped at 900 characters. Retrieval streams up to 50 MB of the newest conversation records (at most 2,000 records), matches up to 20 question terms and explains when the scan limit is reached. Selecting a source narrows the search. Optional synthesis receives those excerpts; saved generated answers are capped at 20,000 characters. It does not browse the web, run autonomous actions or decide hiring outcomes. Threads are limited to 100 per user/workspace and 100 questions each. Answers whose cited source text changes or becomes inaccessible are withheld on subsequent reads. This differs from the single-note question panel, whose UI chat state is not persistent.

Uploads accept supported text, VTT, PDF, DOCX, audio and video up to 50 MB; document extraction has a 10 MB input limit. Text/extracted content is capped at 800 KB. PDF extraction supports text-based PDFs up to 200 pages; DOCX bounds expanded data at 20 MB, XML parts at 4 MB and entries at 1,000. Extraction uses workers with a ten-second deadline and at most two concurrent jobs. There is no OCR. Corrupt, empty, encrypted/unsupported or oversized documents return explicit errors and failed uploads do not create notes. Optional audio transcription has a separate 25 MB provider limit. Uploaded media supports authorized byte-range playback, but not synchronized word timing or video clipping.

Published screening links use immutable question snapshots and hashed random tokens. Each seven-day link accepts one validated candidate response; an identical retry is idempotent. Authorized users can review responses; publication management is role-restricted. Public reads do not expose submitted identities or answers. Voice agents, video interviews and automated evaluation are absent.

## Provider configuration

Start from [.env.example](../.env.example), supply credentials in a private server environment, and restart. Do not commit credentials, tokens or real workspace IDs. Authenticated `GET /api/workspaces` returns the user's workspace IDs. `OPENAI_WORKSPACE_IDS`, `PROVIDER_WORKSPACE_IDS`, `MAIL_WORKSPACE_IDS` and `BILLING_WORKSPACE_IDS` are separate comma-separated allowlists; blanks enable no workspace for their funded services. Provider operations that manage external state also require their application roles and explicit UI action.

### Calendar OAuth

Set `CALENDAR_TOKEN_ENCRYPTION_KEY` to a securely generated, stable 64-character hexadecimal secret, for example by generating one with `openssl rand -hex 32`. Back it up separately. Set `CALENDAR_APP_ORIGIN` to an exact origin in `APP_ORIGIN`; production requires HTTPS, while localhost HTTP is accepted for development.

For Google, configure `GOOGLE_CALENDAR_CLIENT_ID` and `GOOGLE_CALENDAR_CLIENT_SECRET` with the exact callback `<origin>/api/calendar/google/callback`. For Microsoft, configure `MICROSOFT_CALENDAR_CLIENT_ID` and `MICROSOFT_CALENDAR_CLIENT_SECRET` with `<origin>/api/calendar/microsoft/callback`. Each user connects through Settings and provider consent. OAuth state is expiring, session-bound and single-use; PKCE is used. Tokens are encrypted with AES-256-GCM and bound to the user, workspace and provider.

Sync is explicit, for the connected primary calendar and next 30 days, capped at 1,000 events. Imports are duplicate-safe, preserve local note edits and archive observed cancelled events. Disconnect removes local credentials while retaining imported notes. There is no background webhook/delta sync, shared-calendar picker, calendar write-back or automatic meeting-bot attendance rule.

References: [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [Google events.list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list), [Microsoft authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow), [Microsoft calendarView](https://learn.microsoft.com/en-us/graph/api/calendar-list-calendarview?view=graph-rest-1.0).

### Greenhouse Harvest v3

Set `GREENHOUSE_CLIENT_ID`, `GREENHOUSE_CLIENT_SECRET` and `PROVIDER_WORKSPACE_IDS`. `GREENHOUSE_USER_ID` optionally supplies a numeric provider user scope. A workspace owner/admin can run a manual import from Settings.

The adapter uses client credentials and fixed Harvest v3 endpoints. It imports nonprivate candidates, nonconfidential jobs and associated applications; it preserves local edits while updating separate provider metadata. Responses are bounded, with at most ten pages and 1,000 records per resource. Exceeding those bounds fails the import rather than silently importing a partial catalog. There is no continuous synchronization, attachments/CV import, scorecard write-back or remote stage mutation.

References: [Authentication](https://harvestdocs.greenhouse.io/docs/authentication), [pagination](https://harvestdocs.greenhouse.io/docs/pagination), [candidates](https://harvestdocs.greenhouse.io/reference/get_v3-candidates), [jobs](https://harvestdocs.greenhouse.io/reference/get_v3-jobs), [applications](https://harvestdocs.greenhouse.io/reference/get_v3-applications).

### Recall meeting capture

Set `RECALL_API_KEY`, `PROVIDER_WORKSPACE_IDS`, and `RECALL_REGION` to one of `us-east-1`, `us-west-2`, `eu-central-1` or `ap-northeast-1`. The UI requires a supported meeting URL and explicit recording-consent acknowledgment before requesting a bot. Scheduled joins must be between ten minutes and 30 days ahead.

Users explicitly refresh status, leave a call, cancel supported scheduled capture or import a ready transcript. Creation request identities prevent accidental duplicate local requests; ambiguous provider outcomes require recovery rather than blind automatic retries. Imported notes are private to their creator subject to workspace administration. Transcript imports are bounded to 20,000 provider segments, an 8 MB response and 500,000 characters. The adapter does not import a local media recording, receive signed status webhooks, automatically follow calendars or reproduce the source meeting infrastructure.

References: [Create bot](https://docs.recall.ai/reference/bot_create), [retrieve bot](https://docs.recall.ai/reference/bot_retrieve), [leave call](https://docs.recall.ai/reference/bot_leave_call_create), [delete bot](https://docs.recall.ai/reference/bot_destroy), [transcription](https://docs.recall.ai/docs/recallai-transcription), [download schemas](https://docs.recall.ai/docs/download-schemas), [regions](https://docs.recall.ai/docs/regions).

### Resend and account mail

Default `MAIL_MODE=outbox` saves sequence messages locally and makes no mail-provider call. Live sending requires `MAIL_MODE=resend`, `RESEND_API_KEY`, a verified `MAIL_FROM`, HTTPS `PUBLIC_APP_URL` and `MAIL_WORKSPACE_IDS`; `MAIL_REPLY_TO` is optional.

A sequence owner/admin previews personalized recipients and approves a revision before activation. Persistent messages retain the approved snapshot, delays and per-message idempotency keys. Pause/resume/cancel, manual reply status, unsubscribe links and workspace suppression lists are implemented. The server worker handles bounded retries for explicit transient failures, polls known provider statuses and stops on unknown delivery outcomes. It runs only while the server is running; this is not mailbox OAuth, automatic inbound-reply detection or a delivery guarantee. Limits include ten steps, 100 recipients per activation and 1,000 active/paused enrollments per workspace.

Account password changes work without mail and require the current password. They rotate this session and revoke others. Reset links require live mail, expire after 30 minutes, are hashed and single-use, and invalidate all sessions when consumed. Verification links require a matching signed-in account and expire after 24 hours. Account tokens never enter sequence outboxes or API responses. Forgot-password responses are generic and acknowledged before mail-provider I/O; shutdown drains pending requests. A process crash can interrupt delivery, so the receipt does not assert successful delivery.

References: [Send email](https://resend.com/docs/api-reference/emails/send-email), [idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys).

### Stripe billing

Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, at least one recurring seat price (`STRIPE_PRICE_TEAM` / `STRIPE_PRICE_BUSINESS`), HTTPS `PUBLIC_APP_URL` and `BILLING_WORKSPACE_IDS`. Use Stripe test mode first. Settings displays configured provider prices and test/live mode; an owner/admin chooses a plan and seat quantity before redirecting to Checkout.

Register the snapshot webhook endpoint `<PUBLIC_APP_URL>/api/billing/webhook` for subscription created/updated/deleted and checkout completion events. Raw request bodies are verified against the signing secret with a five-minute timestamp tolerance. Stored customer/workspace bindings, replay checks and stale-event handling protect updates; refresh reconciles provider status. Customer-portal access and checkout cancellation/recovery are available.

This tracks commercial state; it does not yet enforce subscription features, source-product usage credits, metering or paid-seat quotas on invitations. Public pricing-page figures remain illustrative. No real charge or live subscription was created during repository validation. Reference: [Stripe webhook signature verification](https://docs.stripe.com/webhooks#verify-manually).

## Remaining implementation and operational work

The working adapters do not establish complete source parity. Missing features include external candidate discovery/contact enrichment; Gmail/Outlook inbox integration and automatic reply detection; voice/video screening agents; ATS write-back and providers beyond Greenhouse; real-time coediting and video snippets; full report/AI-column automation; Slack coworker actions and scheduling; enterprise SSO/MFA/SCIM, managed domains and retention policies; and enforced usage/credit entitlements.

No production deployment, operational monitoring, load test or live paid-provider end-to-end validation is included. This is a single-process SQLite/local-files installation. Backups, encryption-key handling, HTTPS, abuse controls, recovery operations and legal policies need an operating environment and operator decisions. Configuration alone does not establish a successful external connection.

## Public content and asset provenance

The homepage follows the observed visual structure: announcement strip, white navigation, rounded calls to action, split hero, product selector, feature accordions, resource cards, and footer. ArkOffer replaces the source brand and uses original educational articles and company copy. It does not claim Metaview's customers, funding, certifications, hiring openings, or testimonials.

The hero image and fonts downloaded from observed public asset URLs are recorded with origins and hashes in [origins.json](../public/marketing/origins.json). Public availability is not a license grant. Their ownership and use rights must be resolved for distribution or replaced with licensed assets. The legal pages are explicitly draft ArkOffer documents, not copied Metaview policies or finalized advice.

## Validation evidence and boundaries

Reproduce the repository checks with:

```sh
npm test
npm run build
npm run test:e2e
npm run format:check
```

The API suites in [tests/server](../tests/server) exercise authentication, migrations, memberships/roles, conversation permissions, sharing, source files, versioning, document limits, screening responses, account security, provider request boundaries and error handling. Calendar, mail, ATS, meeting, billing and AI tests use injected responses. Browser suites in [tests/e2e](../tests/e2e) cover local browser-to-API persistence, cross-session account changes, invitations/workspace switching and recruiting flows.

Final combined-suite counts and remote checks belong in the delivery PR after execution. Earlier marketing review covered 19 public routes, desktop/390-pixel layouts, navigation, local forms, search and pricing controls. The microphone regression simulates a late permission result; it does not establish physical recording. Screenshots support layout review, not pixel equality of every source state.

The GitHub workflow runs API tests, production build and Chromium tests. A workflow file is not itself a successful check. Tests do not establish live provider accounts, original-service behavior, production capacity, accessibility conformance, hiring quality or 100% source equivalence.

## Public reference index

- [Metaview homepage](https://www.metaview.ai/), [pricing](https://www.metaview.ai/pricing), [resources](https://www.metaview.ai/resources), and [integrations](https://www.metaview.ai/integrations).
- [Navigation](https://support.metaview.ai/get-started/navigation), [working with notes](https://support.metaview.ai/notes/working-with-notes), [templates](https://support.metaview.ai/notes/templates), [transcript and recording](https://support.metaview.ai/notes/transcript-and-recording), [snippets](https://support.metaview.ai/notes/snippets), [assistant](https://support.metaview.ai/notes/assistant), [sharing/export](https://support.metaview.ai/notes/share-and-export), and [collections](https://support.metaview.ai/notes/collections).
- [Sourcing](https://support.metaview.ai/sourcing/overview), [application review](https://support.metaview.ai/application-review/overview), [screening setup](https://support.metaview.ai/screening/setup), and [reports](https://support.metaview.ai/reports/overview).
- [Team management](https://support.metaview.ai/account-management/managing-your-team), [workspace settings](https://support.metaview.ai/account-management/workspace-settings), [outreach](https://www.metaview.ai/outreach), and [fillmore](https://www.metaview.ai/fillmore).
