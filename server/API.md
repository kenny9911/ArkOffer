# ArkOffer local API

The Express server stores workspace data in SQLite at `DATA_DIR/arkoffer.sqlite` and source uploads in `DATA_DIR/uploads`. `DATA_DIR` defaults to `./data`. Run on Node 22.13 or newer. There are no default accounts. Signup creates an independent workspace with 12 editable built-in templates, whether or not demo data is selected. Optional demo conversations and candidates are fictional and use example.com addresses.

Set `APP_ORIGIN` to the exact browser origin (or a comma-separated list) when frontend and backend origins differ behind a development proxy. Browser mutations require an allowed `Origin` header. Slack signed command/event routes and the Stripe raw-body webhook are exempt from browser Origin checks and instead require valid provider signatures; calendar callbacks validate one-use session-bound OAuth state. Session authentication uses a seven-day HttpOnly, SameSite=Lax cookie; the database stores only its hash. Production requires HTTPS for the Secure cookie. If an HTTPS reverse proxy terminates TLS, set `TRUST_PROXY=1` only when a trusted proxy is the sole entry point.

## Authentication

- `POST /api/auth/signup`: `{name,email,password,workspaceName?,seedDemo?}` → `{user}` (201). Password: 8–128 characters.
- `POST /api/auth/login`: `{email,password}` → `{user}`.
- `POST /api/auth/logout`: `{}` → `{ok:true}`.
- `GET /api/auth/me` → `{user}` or `{user:null}`.

`user` has `id`, `name`, `email`, `workspaceId`, `workspaceName`, and `role`. Errors return `{error:string}` with an appropriate HTTP status.

## Workspace resources

`/api/{conversations,templates,collections,candidates,searches,sequences,applications,screenings,jobs,reports}`:

- `GET /` → `{items:[]}`. Optional `q` text filter and `archived=true|false` filter.
- `GET /:id` → `{item}`.
- `POST /` with a JSON object → `{item}` (201).
- `PATCH /:id` with changed fields → `{item}`.
- `DELETE /:id` → `{ok:true}`.

Conversations and jobs require `title`; the remaining resources require `name`. Applications and screenings also accept a `title`, `candidate`, or `candidateName` in place of a name. Validated custom JSON fields are retained, including template prompts/sections, sequence steps, report filters/columns, and candidate attributes. Server-controlled IDs, timestamps, source-file metadata/storage fields, calendar/ATS/capture/enrichment provenance, and provider-processing metadata cannot be overwritten. Records and history are scoped to the active session workspace. Conversation and collection routes additionally enforce ownership, workspace visibility and viewer/editor grants; collection permissions apply to their contained conversations. Entire merged records are limited to 1 MB, including successive edits.

Conversation fields: `title`, `candidate`, `interviewer`, `date`, `duration` (minutes), `transcript`, `sections:[{id,title,content}]`, `tldr`, `status` (`ready|processing|upcoming`), `archived`, `collectionIds`, and read-only `shared`. Collection IDs must belong to the workspace. Every edit automatically saves a historical version; the newest 100 versions are retained. Adding a nonempty transcript to a pending upload changes it to ready. Source metadata is `file:{name,mimeType,size}`; storage paths and file IDs are not exposed. `shared` is computed from currently active, unexpired links.

Deleting a collection removes its ID from current conversations while preserving their content. Stale references to a collection previously deleted in the same workspace are removed from later edits; unknown IDs and IDs from another workspace remain invalid. Restoring an old note version also removes references to deleted collections.

## Conversation actions

- `POST /api/conversations/upload`: multipart `file`, optional `title`, `candidate`, and `transcript` → `{item}` (201). Audio/video uploads support up to 50 MB and remain pending until a transcript is supplied or transcription is requested. Text/VTT auto-imports at up to 800 KB. PDF/DOCX documents extract text locally at up to 10 MB per file; successful extraction returns a ready conversation with `sourceType:"document"`, `transcriptionStatus:"extracted"`, and `extraction:{status:"complete",type:"pdf"|"docx",pages?}`. A supplied transcript takes precedence over automatic extraction.
- `GET /api/conversations/:id/file`: authorized source-file attachment download.
- `GET /api/conversations/:id/media`: authorized inline audio/video playback with byte-range support. Other file types are rejected for inline playback.
- `POST /api/conversations/:id/transcribe`: `{}` → `{item,mode:"openai"}`. Requires `OPENAI_API_KEY` and the current workspace in `OPENAI_WORKSPACE_IDS`, a supported audio/video upload of at most 25 MB, and a successful provider response. Otherwise returns a clear error without fabricating text.
- `POST /api/conversations/:id/generate`: `{templateId?,format?,length?,language?}` → `{item,mode:"extractive"|"openai"|"openrouter",source,preferences}`. `format` is `bullets|paragraphs`; `length` is `concise|standard|detailed`. Supported language values are `original`, `English`, `Chinese`, `French`, `German`, `Spanish`, `Japanese`, `Portuguese`, `Italian`, `Korean`, `Arabic`, `Hindi`, `Dutch`, `Swedish`, `Danish`, `Norwegian`, `Finnish`, `Polish`, `Turkish`, `Indonesian`, `Vietnamese`, and `Thai`. Unknown options are rejected. Per-call options override saved workspace `language`, `noteFormat`, and `noteLength` defaults. With a provider, these choices become explicit model instructions. Without a provider, plain generation preserves the original transcript language and selects 3/8/16 literal excerpts for concise/standard/detailed output, formatted as bullets or paragraphs. Explicit translation and template-based synthesis return 503 without changing existing notes when the provider is absent. Provider requests include up to the first 100,000 transcript characters. `source:{truncated,characters,totalCharacters}` discloses this limit and is persisted as `item.summarySource` alongside `item.summaryMode`. `preferences:{format,length,language,languageBehavior:"original"|"requested_language"}` is also persisted as `item.summaryPreferences`. Concurrent edits during provider requests return 409 instead of being overwritten.
- `POST /api/conversations/:id/assistant`: `{question}` → `{answer,mode,citations:[{text,start,end}],source}`. Local mode retrieves matching transcript lines; citation offsets refer to the original transcript. Configured text AI answers against supplied transcript evidence. The same `source` metadata discloses provider clipping; citations only reference text the provider received.
- `GET /api/conversations/:id/versions` → `{items:[{id,label,createdAt,data}]}`.
- `POST /api/conversations/:id/versions`: `{label?}` → `{item}` (201).
- `POST /api/conversations/:id/versions/:versionId/restore`: `{}` → `{item}`. Saves the current version first.
- `GET /api/conversations/:id/shares` → `{items:[{id,createdAt,expiresAt}]}`.
- `POST /api/conversations/:id/shares`: `{expiresInHours?}` (1–720; default 168) → `{item:{id,token,url,createdAt,expiresAt}}`. The token is returned once; only its hash is stored. `url` is a relative frontend route.
- `DELETE /api/conversations/:id/shares/:shareId` → `{ok:true}`.
- Public `GET /api/shared/:token` → `{item}`. Read-only conversation evidence; no source files or workspace membership.

## Settings, export, forms

- `GET /api/settings` → `{user,settings}`.
- `PATCH /api/settings`: `{name?,workspaceName?,settings?}` → `{user,settings}`. Workspace name/default changes require owner/admin; any user may change their own display name.
- `GET /api/integrations` → `{items}` with actual `configured`, `available`, `status`, and explanatory descriptions. This directory is supplemented by dedicated provider status endpoints below; configured adapters still require credentials, workspace allowlists and explicit activation.
- `GET /api/reports/export?resource=conversations` → workspace-scoped, permission-filtered CSV download with formula-injection protection. Any supported resource can be exported.
- `GET /api/health` → `{ok,storage,services}`.
- Public `POST /api/demo-requests`: `{name,email,company,companySize?,message?}` → `{ok,message}` (201). Stores the request; does not send email.
- Public `POST /api/newsletter`: `{email}` → `{ok,message}` (201). Stores interest; does not subscribe to an external mailing service.

## Provider configuration

Text also supports RoboApply-compatible `LLM_PROVIDER=openrouter`, `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` (or `OPENROUTER_API_BASE_URL`), exact `LLM_MODEL`, and `LLM_WORKSPACE_IDS`. If defined, `LLM_WORKSPACE_IDS` supersedes the legacy OpenAI text allowlist even when blank. Audio remains separate. See [provider setup](../docs/RECONSTRUCTION.md#text-gateway-and-voice-screening).

Direct OpenAI server environment: `OPENAI_API_KEY`, `OPENAI_WORKSPACE_IDS` (comma-separated workspace UUIDs), `OPENAI_MODEL` (default `gpt-4.1-mini`), `OPENAI_TRANSCRIPTION_MODEL` (default `whisper-1`). Keys remain server-side. AI and transcription requests happen only on explicit action; demo creation and regular CRUD require no provider. Provider errors leave existing conversation notes intact. Credentials are never returned by the settings or integration APIs.

## Team and workspace identity

All listed team operations authenticate the current session; browser writes require Origin. Owner/admin management is enforced, with owner-only assignment/modification of admin/owner roles.

- `GET /api/workspaces` → `{items:[{id,name,role,joinedAt}],activeWorkspaceId}`.
- `POST /api/workspaces`: `{name}` → `{user}` (201); creates a workspace with templates and selects it for this session.
- `POST /api/workspaces/:id/switch`: `{}` → `{user}`; requires active membership and affects only this session.
- `GET /api/team/members` → `{items,canManage}`. Regular members see active teammates; admins also see suspended memberships.
- `PATCH /api/team/members/:id`: `{role?:"owner"|"admin"|"member",status?:"active"|"suspended"}` → `{ok:true}`.
- `DELETE /api/team/members/:id` → `{ok:true}`; removes membership without deleting the account or its workspace records.
- `GET /api/team/invitations` → pending `{items}`, without token material.
- `POST /api/team/invitations`: `{email,name?,role?}` → `{item:{id,email,name,role,createdAt,expiresAt,url}}` (201). The seven-day copy link is returned once; only its token hash is stored. Creating a replacement revokes the prior pending link.
- `DELETE /api/team/invitations/:id` → `{ok:true}`.
- Public `GET /api/invitations/:token` → `{invitation:{workspaceName,role,expiresAt,emailHint}}`.
- Authenticated `POST /api/invitations/:token/accept`: `{}` → `{user}`. Email must match; acceptance is single-use and selects the invited workspace.

A workspace must retain an active owner. Suspension/removal revokes sessions in that workspace and applicable outstanding invitations. Other workspace sessions remain intact. Invitations are capabilities delivered manually; they do not independently establish that an unverified signup owns the claimed mailbox. Limits: 30 memberships per account, 100 pending invitations per workspace.

## Account security

- `GET /api/account/security` → `{email,emailVerifiedAt,mailAvailable,sessions}`. Sessions contain opaque IDs, user-agent descriptions, timestamps, selected workspace and a current-session flag; no cookie hashes.
- `POST /api/account/password`: `{currentPassword,password}` → `{ok:true,user}`; verifies the old password, rotates this session and revokes all others while preserving the active workspace.
- `DELETE /api/account/sessions/others` → `{ok:true}`.
- `DELETE /api/account/sessions/:id` → `{ok:true}`; self-owned sessions only. Revoking the current session clears its cookie.
- Public `POST /api/auth/forgot-password`: `{email}` → generic `{message}` (202). Eligibility and provider results are not disclosed. Unconfigured live mail returns the same 503 for every address.
- Public `POST /api/auth/reset-password`: `{token,password}` → `{ok:true,message}`; consumes a 30-minute token and revokes all account sessions.
- `POST /api/account/verification`: `{}` → `{message}` (202) after provider acceptance, or `{verified:true,message}` when already verified.
- `POST /api/account/verify-email`: `{token}` → `{ok:true,message}`; requires the matching authenticated account, consumes the 24-hour token and records verification.

Reset/verification tokens are hashed, single-use and never returned by APIs or stored in sequence outboxes. Live Resend configuration and an allowed workspace are required. Passwords use the same 8–128 character constraints and scrypt as signup. Account request rates are bounded. The server drains pending recovery-mail requests before closing SQLite.

## Resource access and comments

For `kind` equal to `conversations` or `collections`:

- `GET /api/:kind/:id/access` → `{ownerId,visibility,permission,canEdit,canManage,grants}`; grant identities are returned only to access managers.
- `PATCH /api/:kind/:id/access`: `{visibility:"private"|"workspace"}` → `{ok:true}`.
- `PUT /api/:kind/:id/access/:userId`: `{permission:"viewer"|"editor"}` → `{ok:true}`; recipient must be an active workspace member.
- `DELETE /api/:kind/:id/access/:userId` → `{ok:true}`.

Workspace admins and resource owners manage access. Collection viewer/editor access grants corresponding access to contained conversations; unrelated private notes remain inaccessible.

- `GET /api/conversations/:id/comments` → `{items}`.
- `POST /api/conversations/:id/comments`: `{body}` (1–10,000 characters) → `{item}` (201). Read access is sufficient to comment; maximum 500 comments per note.
- `DELETE /api/conversations/:id/comments/:commentId` → `{ok:true}`; comment author or workspace admin only.

## Workspace assistant

- `GET /api/assistant/threads` → this user's active-workspace `{items}`.
- `GET /api/assistant/threads/:id` → `{item,messages}`.
- `DELETE /api/assistant/threads/:id` → `{ok:true}`.
- `POST /api/assistant/ask`: `{question,threadId?,conversationIds?}` → `{threadId,message}`. Questions are 1–2,000 characters; optional source selection is at most 50 conversation IDs.

Retrieval uses accessible unarchived transcripts and returns at most 12 citations, at most three per conversation, with 900-character excerpts and source offsets. Local mode is labeled extraction; a configured, allowed text AI provider may synthesize from that evidence. Threads/history are private to the user/workspace, limited to 100 threads and 100 questions each. Source permissions/text are rechecked after provider calls and on history reads; invalidated answers are withheld. Concurrent questions from one user/workspace are rejected. Provider output is bounded.

## Calendar, ATS and meeting providers

- `GET /api/calendar` → provider configuration/connection status.
- `POST /api/calendar/:provider/connect`: `{}` → `{url}`, where provider is `google` or `microsoft`.
- `GET /api/calendar/:provider/callback`: provider OAuth callback; validates state/session and redirects to Settings.
- `POST /api/calendar/:provider/sync`: `{}` → import results. Primary calendar, upcoming 30 days, at most 1,000 events; explicit action only.
- `DELETE /api/calendar/:provider` disconnects the current user's current-workspace connection while retaining imported notes.
- `GET /api/providers` → Greenhouse/Recall configuration and allowlist status.
- `POST /api/providers/greenhouse/sync`: `{}` → manual bounded read-only import. Owner/admin and configured workspace required.
- `GET /api/captures` → accessible Recall capture records.
- `POST /api/captures`: `{title,meetingUrl,joinAt?,consent:true,requestKey}` → capture result. `requestKey` is a UUID reused for safe repetition of the same request.
- `POST /api/captures/:id/refresh`, `POST /api/captures/:id/leave`, `POST /api/captures/:id/import`: `{}` → updated capture/import result.
- `DELETE /api/captures/:id` requests cancellation of a supported scheduled capture.
- `POST /api/captures/:id/recover`: `{botId}` attaches a verified Recall bot to an ambiguous creation only when provider metadata matches the original request.

Provider endpoints and download hosts are constrained, requests are bounded, local edits/import identity are preserved, and credentials are never returned. See [configuration and provider limits](../docs/RECONSTRUCTION.md#provider-configuration). No signed Recall webhook, automatic calendar bot rule or ATS write-back is implemented.

## Outreach delivery

Sequence draft `steps` use `{subject,body,delayDays}` and `enrolledCandidateIds` selects local candidate records.

- `GET /api/sequences/:id/delivery/preview` → personalized recipients, eligibility, delivery mode/configuration and a revision hash.
- `GET /api/sequences/:id/delivery` → current enrollments, messages, events and configuration.
- `GET /api/sequences/:id/delivery/messages/:messageId` → authorized message text and delivery state.
- `POST /api/sequences/:id/delivery/launch`: `{revision,acknowledged:true,mode:"outbox"|"resend"}` → `{ok:true,enrollmentIds,mode}` (201).
- `POST /api/sequences/:id/delivery/control`: `{action:"pause"|"resume"|"stop"|"replied",enrollmentId?}` → `{ok:true,changed}`.
- `POST /api/sequences/:id/delivery/reconcile`: `{}` refreshes bounded provider delivery state.
- Public `GET /api/outreach/unsubscribe/:token` displays a confirmation form; `POST` suppresses the recipient for that workspace and cancels future steps.

Launch/control/status reconciliation require owner/admin. Outbox mode persists messages without delivery. Live mode requires the Resend configuration and workspace allowlist. Approved recipient/content snapshots, delays, idempotency keys and bounded retries persist. Unknown delivery outcomes require attention rather than blind retry. Replies are marked manually, not detected from an inbox. The server worker runs every 15 seconds; limits and setup are in the reconstruction document.

## Billing

- `GET /api/billing` → configuration, test/live mode, management permission, active seats, provider prices, pending checkout and subscription state.
- `POST /api/billing/checkout`: `{plan,seats,acknowledged:true}` → configured Stripe checkout; owner/admin only. Seats must cover current active membership and are bounded to 1–1,000.
- `POST /api/billing/checkout/cancel`: `{}` cancels/reconciles a pending checkout.
- `POST /api/billing/portal`: `{}` → customer-portal URL for the authenticated workspace.
- `POST /api/billing/refresh`: `{}` refreshes provider subscription state.
- `POST /api/billing/webhook`: raw JSON body and `Stripe-Signature`. Signature, five-minute freshness, test/live mode, workspace/customer binding and replay/stale-event checks precede updates.

Setup requires allowed workspace IDs, Stripe credentials, recurring price IDs and HTTPS public URL. Browser input cannot select arbitrary provider prices or customers. Subscription tracking does not yet enforce feature/usage entitlements. No live payment is part of the test evidence.

## Published screening

- `POST /api/screenings/:id/publish`: `{}` → a seven-day public questionnaire link with immutable question snapshot.
- Public `GET /api/interviews/:token` → questionnaire details, without prior candidate responses.
- Public `POST /api/interviews/:token/responses`: `{candidateName,email,consent:true,answers:[{questionId,value}]}` → persisted response receipt. One response per link; identical retries are idempotent.
- `GET /api/screenings/:id/responses` → workspace-authorized response/publication review.
- `DELETE /api/screenings/:id/publications/:publicationId` revokes a link.

Question types are text, yes/no and multiple choice. Submission validates required answers against the published snapshot. No voice agent, invitation email or automated hiring score is produced.

## Document extraction boundaries

Parsing runs in an isolated worker with a 10-second timeout, a 128 MB JavaScript heap budget, and at most two concurrent document workers. PDFs are limited to 200 pages, sequential page processing, and a 1-megapixel declared image limit. DOCX archives allow at most 1,000 entries, 20 MB of declared expanded data, and 4 MB per text XML part; actual decompressed text parts are counted while streaming and verified against their declared sizes. Extracted text is limited to 800 KB. No document HTML is produced. PDF scripting/eval and XFA are disabled; DOCX external relationships, images, macros, and embedded packages are not followed. XML entity/DOCTYPE declarations are rejected. Network fetches from the worker are disabled.

DOCX extraction reads main-document paragraphs and table text, plus headers, footers, footnotes, and endnotes. It preserves text rather than layout and omits deleted text and field instructions. PDF extraction requires a text layer; OCR for scanned PDFs is not implemented. Corrupt, encrypted, empty, or unsupported documents return a clear 422 error; limits return 413 and worker saturation returns 429. Failed uploads are removed and no conversation is created. Documents can instead be supplied with an explicit transcript.

Libraries were selected against their primary documentation: [unpdf](https://github.com/unjs/unpdf), [yauzl](https://github.com/thejoshwolfe/yauzl), and [xmldom](https://github.com/xmldom/xmldom). All declare Node engine ranges that include Node 22, 24, and 26.

## Voice screening

- Public `GET /api/interviews/:token/voice` → `{available,maxSeconds,maxAttemptsPerQuestion,mode,provider,clarification,audioRetention}`; active immutable publication required.
- Public `POST /api/interviews/:token/voice/transcriptions`: multipart `audio` (canonical mono 16 kHz 16-bit PCM WAV), `questionId`, UUID `requestId`, `consent:"true"`, optional `parentTurnId` → transcript and linked `turnId`, optional clarification. At most two minutes, three attempts per question, 60 per publication, 120 per workspace/hour; consent and active funded workspace required. Repeated request IDs return stored results instead of duplicate billing; interrupted attempts fail explicitly. Client disconnect aborts provider I/O.
- Existing candidate submission accepts optional `voiceEvidence:[{questionId,turnId}]`. The server validates ownership of complete turns and attaches original transcripts/duration/timestamps/candidate-edited flags to owner-visible responses. Browser-supplied provenance is never trusted. Corrected text remains the submitted answer.

Raw recordings are held only while processing. Optional one-question clarification uses the separately configured text model, without scoring or hiring decisions. Written answers remain available when audio is disabled. Detailed provider setup and retention boundaries are in [RECONSTRUCTION.md](../docs/RECONSTRUCTION.md#text-gateway-and-voice-screening).

## Candidate enrichment

- `GET /api/candidates/:id/enrichment` → configuration, eligibility, candidate version and durable run history.
- `POST /api/candidates/:id/enrichment`: `{requestKey,candidateVersion,consent:true,identifier:"profile"|"workEmail"|"nameCompany",retryOf?,retryConfirmed?:true}` → persisted professional-field proposal or explicit no-match/failure/uncertain state. Admin and allowlisted workspace required. See the returned eligibility reasons before submitting; work-email use requires a confirmed professional address.
- `POST /api/candidates/:id/enrichment/:runId/apply`: `{fields,candidateVersion,confirm:true}` → updated candidate. Only approved proposal fields apply; provenance remains server-owned.

These endpoints recheck session, role, workspace, candidate identity and version after provider I/O. Request keys are durable; uncertain attempts require explicit retry. No personal phones/home addresses or raw provider payloads are stored. No automatic outreach or candidate judgment occurs.

## Slack integration and personal automation

- `GET /api/slack` → setup/installation/link status, personal schedules and jobs; secrets omitted and draft visibility permission-checked.
- `POST /api/slack/connect`: `{}` → OAuth URL; owner/admin, configured app and internal/external allowlists required.
- `GET /api/slack/callback`: session-bound, single-use OAuth state and post-exchange authorization checks.
- `DELETE /api/slack`: disconnect workspace installation and cancel queued work.
- `POST /api/slack/link`: `{}` → short-lived `/arkoffer link CODE`; signed Slack command binds the Slack user to the matching active ArkOffer session/member.
- `DELETE /api/slack/link`: remove personal link and pending work.
- `PUT /api/slack/schedule`: `{kind:"digest"|"reminder",enabled,hourUtc:0..23,delivery:"draft"|"automatic"}` → `{ok:true}`. Explicit opt-in; default draft mode requires review.
- `POST /api/slack/drafts`: `{kind:"digest"|"reminder"}` → queued draft ID.
- `POST /api/slack/jobs/:id/approve`: `{revision}` → queues the exact current, unexpired and permission-checked personal draft.
- `DELETE /api/slack/jobs/:id`: cancel own active work.
- Public signed `POST /api/slack/commands`: `/arkoffer link CODE`, `/arkoffer ask QUESTION`, or help. Raw HMAC/timestamp verification, replay handling and bounded parsing precede work.
- Public signed `POST /api/slack/events`: URL verification and installation/token revocation events.

Answers go only to the explicitly linked requester's private DM. The shared knowledge engine limits evidence and retains proof for every model input source; membership, installation, source permission and exact evidence are checked again before sending. Persistent workers enforce retries only for known transient failures; unknown delivery outcomes require review. No actual Slack messages are sent by repository tests.
