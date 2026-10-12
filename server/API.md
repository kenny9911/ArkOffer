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

## Private note-edit drafts

All routes require a current session and conversation access; writes additionally require edit access. Draft reads and actions are restricted to their author in the active workspace. Drafts are separate from conversation resource JSON and public shares.

- `GET /api/conversations/:id/note-edits` → `{items,sourceFingerprint,aiAvailable}`. Fetch the fingerprint after pending note saves finish.
- `POST /api/conversations/:id/note-edits`: `{requestId,sourceFingerprint,target,operation,instructions?,pronounInstructions?,find?,replacement?}` → `{item}` (201 for a new ready draft). `requestId` is a UUID. `target` is `{kind:"section",sectionId}`, `{kind:"tldr"}`, `{kind:"summary"}` or `{kind:"summary-and-transcript"}`. AI operations are `shorten|expand|bullets|paragraphs|custom`, supported only for a section or TLDR; custom requires instructions. `replace` requires nonempty `find` and a `replacement` string, which may be empty. It replaces every exact case-sensitive literal match in the chosen scope without a provider.
- `POST /api/conversations/:id/note-edits/:draftId/apply`: `{}` → `{item,draft,alreadyApplied}`. Client-supplied proposed text is rejected; only the persisted server draft applies.
- `POST /api/conversations/:id/note-edits/:draftId/discard`: `{}` → `{item}`. Applied or generating drafts cannot be discarded.

Drafts expose `id,target,operation,instructions,before,proposed,evidence,status,error,createdAt,updatedAt,versionId,sourceFingerprint`; whole-note replacement also returns `changes` for field-by-field review. Evidence entries have `source:"notes"|"transcript"` and an exact `quote`. Status is `generating|ready|failed|applied|discarded`. The same request ID and input return the persisted state (202 while generating, otherwise 200); changed input returns 409. A hash-only request ledger prevents generation replay after draft retention expires (410). An interrupted request is marked failed when it expires, with an unknown provider outcome rather than fabricated success.

The fingerprint covers the full conversation and its saved versions, and is checked before generation, after provider completion and on apply. A conflict returns 409 and preserves the current notes. Apply atomically saves the previous version, updates only selected content and marks the draft applied; repeated apply returns the current conversation without overwriting later edits. Limits: 20 drafts per author/workspace per ten-minute window; latest 100 drafts per author/conversation; 100 versions; 30,000 target characters; 60,000 transcript characters for AI edits; 45-second provider deadline; 1 MB resulting conversation.

`summary` changes current section contents and TLDR; `summary-and-transcript` also changes the current transcript. Neither changes titles, metadata names, snippets, historical versions/drafts, exports or other records. This is literal text replacement, not complete data erasure. Optional pronoun wording must be explicitly supplied; the model is instructed not to infer names, gender or pronouns. All generated wording requires preview and human review.

## Job creation sources

- `GET /api/job-sources/templates` → `{items}` with three original templates and source fingerprints.
- `GET /api/job-sources/conversations` → `{items}`. Scans the latest 500 workspace conversations and returns readable, unarchived transcripts, their lengths and eligibility. `GET /api/job-sources/conversations/:id` → `{item}` with the authorized source preview and fingerprint.
- `GET /api/job-sources/documents` → `{items}` for the current author/workspace. `POST /api/job-sources/documents` accepts one multipart `file` (PDF/DOCX) and returns `{item}` (201). `DELETE /api/job-sources/documents/:id` → `{ok:true}` for an owned document.

Sources expose `kind,id,title,text,fingerprint`. Document limits: 10 MB/file, 60,000 extracted characters, 20 upload attempts/workspace/hour, 30 retained documents/author/workspace, plus the isolated parser limits below. Uploaded originals are removed after extraction; extracted text is privately stored separately from Notes. Source changes or deletion invalidate derived drafts. There is no OCR or external URL import.

## Private job-description drafts

- `GET /api/job-drafts?jobId=<uuid>` → `{available,items}` for the current author/workspace; `jobId` is optional.
- `POST /api/job-drafts`: `{requestId,jobId?,sourceVersion?,details?,brief?,source?,mode?,companyContext?,tone?}` → `{item}` (201). Existing jobs require their current `updatedAt` as `sourceVersion` and must omit `details`. New jobs require `details:{title,department?,location?,employmentType?,salary?,description?}`. Optional `source:{kind,id,fingerprint}` uses `template|conversation|document` and is resolved by the server. `mode` is `ai` (default) or `manual`; manual requires a source and creates an editable source-copy draft without a model request. `tone` is `clear|warm|formal`; default `clear`. Brief and company context are each limited to 10,000 characters; either a nonempty brief or a selected source is required. Existing descriptions accept up to 60,000 characters.
- `POST /api/job-drafts/:id/apply`: `{confirm:true,description}` → `{item,alreadyApplied?}`. Description is the explicitly reviewed, possibly user-edited text, 1–60,000 characters. A new job gets `status:"draft"`; an existing job retains all other fields and status.
- `DELETE /api/job-drafts/:id` → `{ok:true}`. Cancels/discards active results or removes retained history; the request-ID ledger remains.

Draft items contain `id,jobId,title,status,result,error,model,sourceCurrent,createdAt`; `result` has `description,suggestions,missingDetails`. States include `running|ready|stale|failed|applied|discarded`. Request UUIDs are author/workspace scoped; matching retries reuse stored results, and deleted/expired requests cannot be regenerated under the same ID. Source access and revisions are checked before/after generation, on history/replay and before apply; invalid source content is withheld. Repeated apply returns the latest job. Limits: 100 retained drafts per author/workspace, two active requests and 30 generation attempts per workspace/hour, a 120-second streamed AI deadline and the 1 MB resource cap. Sanitized provider failures are preserved for the author. No external job publishing or ATS write-back occurs.

Known terminal generation errors include `requestId` and `generationStatus` alongside `error`. The editor offers an explicit new attempt only after confirming a terminal result; ambiguous network failures retain the original request identity. Deleting a running draft aborts its upstream request and rejects late output; it cannot undo provider usage already incurred. The job drafting profile uses concise output guidance and optional reasoning controls described below, without changing the model, deadline or token budget.

## Collaborative job review

These routes require an active workspace member and a job in that workspace. Comments are workspace-visible; only their author can edit or delete them. Reviewer identities expose names, not email addresses.

- `POST /api/job-collaboration/summary`: `{ids}` → `{items:[{id,commentCount,reviewedCount}]}`. Up to 200 UUIDs; foreign/deleted IDs omitted.
- `GET /api/jobs/:jobId/collaboration` → `{fingerprint,snapshot,comments,checks,history,commentCount,reviewedCount,limits}`. The snapshot identifies the current job version.
- `POST /api/jobs/:jobId/comments`: `{body}` → `{id}` (201).
- `PATCH /api/jobs/:jobId/comments/:id`: `{body,revision}` → `{ok:true}`. `DELETE` at the same path accepts `{revision}`. Stale revisions return 409.
- `POST /api/jobs/:jobId/review`: `{fingerprint,revision,reviewed}` → `{ok:true}`. Initial own revision is zero. Job fingerprint and own revision conflicts return 409; the editor refuses to review a stale preview.

Checks bind to job title, description, metadata, status and update revision. Edits invalidate earlier checks; suspended/removed members do not count. Checks are human review acknowledgments, not AI/compliance scores or publication approval. Limits: 4,000 characters/comment, 200 comments/job, 20,000/workspace, 30 comment creates/person/workspace/hour, 60 review changes/person/workspace/hour, latest 200 review history events/job. Usage survives content deletion. Deleting a job cascades its collaboration records. A successful save followed by a failed refresh is reported as saved, preventing accidental duplicate comment retries.

## Private application CV documents

- `GET /api/applications/:id/documents` → `{items}` containing only the current author's document metadata, fingerprints and lengths for that application/workspace.
- `POST /api/applications/:id/documents` accepts one multipart `file` (PDF/DOCX) → `{item}` (201), including extracted-text preview and fingerprint. Upload does not select evidence or invoke AI.
- `GET /api/applications/:id/documents/:documentId` → `{item}` with privately authorized extracted text.
- `DELETE /api/applications/:id/documents/:documentId` → `{ok:true}`. Deletes the private source and invalidates derived reviews without changing the application decision.

Limits: 10 MB/file, 60,000 extracted characters, five documents/application/author, 50/author/workspace, 20 workspace upload attempts/hour. Parsing reuses the isolated PDF/DOCX bounds below. Originals are removed after extraction or handled failure; only extracted text remains in private tables, separate from generic resources and Notes. Identity/membership, application existence, connection and retention are rechecked after extraction. Scanned-image OCR and ATS attachment import are absent.

## Application criteria and evidence assistance

Job criteria are workspace-visible only after explicit approval. Criteria drafts, analysis outputs and reviewer notes are private to the current user/workspace.

- `GET /api/jobs/:id/review-criteria` → `{revision,criteria,setup:{enabled},drafts}`; up to ten recent own criteria drafts.
- `PUT /api/jobs/:id/review-criteria`: `{revision,approved:true,criteria:[{id,text,importance}]}` → `{revision,criteria}`. Each criterion has a unique UUID, 1–600 character text and `importance:"required"|"preferred"`; one to ten criteria. Revision mismatch returns 409.
- `POST /api/jobs/:id/review-criteria/draft`: `{requestId,revision}` → `{item}` (201 for new output). Requires a current nonempty job description of at most 30,000 characters. Draft output contains proposed criteria plus provider/model; it does not approve them.
- `GET /api/applications/:id/review-assistance` → `{jobId,criteria,candidateEvidence,sources,items,setup:{enabled}}`; up to 30 recent own analysis runs. Source choices include only readable, unarchived transcripts.
- `POST /api/applications/:id/review-assistance`: `{requestId,criteriaRevision,conversationIds,documents?,consent:true}` → `{item}` (201 for a new completed run). Select zero to five unique transcript UUIDs and up to three unique private `documents:[{id,fingerprint}]`. A linked candidate with professional evidence can also supply source material. At least one source and a job with current approved criteria are required. Document content is resolved by the server, never accepted inline.
- `PATCH /api/applications/:id/review-assistance/:runId`: `{notes,reviewed}` → `{item}`. Saves up to 10,000 characters of private human notes and an optional reviewed timestamp; it does not change a hiring decision.

Run items include `id,kind,status,createdAt` and, only while sources/access are current, `output,notes,reviewedAt,error`. Analysis output includes all approved criteria exactly once, with `criterionId,evidence:[{sourceId,quote}],missingInformation,followUp`, the approved criteria/source snapshot, provider/model and `humanReviewRequired:true`. Quotes must match supplied evidence exactly. Candidate source fields are limited to role, company and skills; the combined selected evidence limit is 60,000 characters. Recruiter opinions and previous decisions are not supplied as candidate facts.

Repeated UUIDs return their persisted request state (202 while running, otherwise 200); request mismatches are rejected. Session, membership, application/job/candidate content, criteria revision, transcript access and private document fingerprints are checked after generation and on later reads/review-note writes. Deleted, changed, reassigned or inaccessible sources withhold output and private notes. Empty document selections preserve legacy transcript/profile request identities. Limits: ten attempts per user/hour, 50 per workspace/hour, two active requests per workspace, 55-second cancellation deadline and 20 KB provider output. Missing evidence is not a negative assessment. These endpoints do not rank/score applicants, produce integrity verdicts, recommend or automate rejection, change ATS stages, or run continuous review.

## Private AI report views

Definitions, processing runs, values, evidence and annotations are author/workspace scoped and excluded from generic reports and public shares. A definition is `{name,question,sourceIds,columns,filters?}`. Columns are `{id,name,instruction,type}` with a unique 1–64 character alphanumeric/underscore/hyphen ID and `type:"text"|"number"|"boolean"|"currency"`. Filters are `{title?,candidate?,interviewer?,status?,dateField?,from?,to?,durationMin?,durationMax?}`. Title/candidate/interviewer are case-insensitive substrings of at most 200 characters. Status is `""|"ready"|"processing"|"upcoming"`; dateField is `"created"|"conversation"` (default created). Optional `YYYY-MM-DD` bounds apply inclusively to that selected date field. Duration bounds are finite numbers from 0 to 10,080 minutes and a reversed range is rejected. Missing values do not match duration or conversation-date filters. The saved duration may be calendar-planned duration; there is no inferred talk-time or late-start metric. The author can enter the schema or explicitly generate and review a proposal using the private draft endpoints below.

- `GET /api/report-views/drafts` → `{available,items}`; `GET /api/report-views/drafts/:id` → `{item}`. Both are author/workspace scoped.
- `POST /api/report-views/drafts`: `{requestId,brief,consent:true,viewId?,revision?}` → `{item}` (201). Brief is 20–4,000 characters. A bound view requires its current revision. The provider receives only the brief and proposes a name, question, one to five typed columns, supported filters and explanatory notes; no source records are sent. Matching UUIDs reuse the request state; deleted/expired identities cannot generate again.
- `POST /api/report-views/drafts/:id/apply`: `{confirm:true}` → `{definition,notes,alreadyApplied}`. Returns an editable definition with `sourceIds:[]`; the client preserves manually selected sources. This does not save a view or run extraction. Bound-view changes invalidate the proposal.
- `DELETE /api/report-views/drafts/:id` → `{ok:true}`. Cancels/removes an owned proposal while preserving request identity/budget records. Draft limits: 15 attempts/user/workspace/hour, 30/workspace/hour, two active requests/workspace and 100 retained drafts/author/workspace; shared 60-second provider deadline.

- `GET /api/report-views` → `{items,sources,setup:{configured,model},limits}`. Owned views include `favorite,ownerName,createdAt,updatedAt`; authorized unarchived source metadata includes `candidate,interviewer,date,duration,status` in addition to title, creation time and transcript length. Missing duration is `null`.
- `POST /api/report-views`: definition → `{item,runs}` (201). Saving a view makes no model request.
- `GET /api/report-views/:id` → `{item,runs}`; latest 25 runs with progress, typed values, source quotations and truncation metadata.
- `PATCH /api/report-views/:id`: `{revision,definition}` → `{item,runs}`. Rejects stale revisions and cancels in-progress work for the prior definition. The editor retains its original revision through polling and preference refreshes.
- `PATCH /api/report-views/:id/preferences`: `{favorite:boolean}` → `{item,runs}`. Strict author/workspace scope; favorite changes neither extraction/presentation revisions nor provider work. Duplication uses a separately saved copy through the existing create endpoint and does not copy extracted results.
- `DELETE /api/report-views/:id` → `{ok:true}`; aborts processing and removes that view and its retained results. Budget usage remains recorded.
- `POST /api/report-views/:id/runs`: `{requestKey,revision,consent:true}` → `{item,reused:false}` (202). Matching request keys return the stored run with `reused:true`; mismatched view/revision returns 409. Requires the configured, allowed shared text provider.
- `POST /api/report-views/:id/runs/:runId/cancel`: `{}` → `{item}`.
- `PATCH /api/report-views/:id/runs/:runId/cells/:cellId`: `{annotation}` → `{ok:true}`; annotation is at most 4,000 characters. A human annotation does not overwrite the extracted value or evidence.
- `GET /api/report-views/:id/runs/:runId/export.csv` → permission- and source-checked CSV with formula-injection protection, values, evidence, UTF-16 offsets, annotations and truncation disclosure.
- `PATCH /api/report-views/:id/presentation`: `{revision,runId?,presentation}` → `{item,runs}`. Presentation is `{mode:"table"|"bar"|"line",groupBy:string|null,operation:"count"|"sum"|"average",metric:string|null}`. The independent presentation revision rejects stale edits. An optional owned run selects its immutable column snapshot for validation; otherwise the current definition supplies columns. Saving presentation does not trigger extraction or change its revision. Line charts use categorical group order; they do not represent a time-series axis.
- `GET /api/report-views/:id/runs/:runId/grouped.csv` → source- and permission-checked grouping export with formula-injection protection. Run responses include aggregation of authorized rows under the saved presentation; counts, numeric/currency sums and averages retain currency separation and disclose missing/failed/pending values.

Each run processes up to 20 selected notes × five columns = 100 cells. The provider receives at most 60,000 transcript characters per conversation, with `truncated,includedCharacters,totalCharacters` returned for review. Non-null values require exact transcript quotes. Missing/ambiguous evidence yields `not_documented` and `null`, not a guessed negative. Currency values use `{amount,currency}`. Source title/transcript content and access are rechecked before and after provider work and on reads/exports; unavailable rows return no source title, values or annotations. Run status distinguishes queued/processing/completed outcomes, partial failure, cancellation and interruption.

Limits: 100 views per author/workspace, one active run per author/workspace, 500 cells per user and 2,000 per workspace over 24 hours, bounded 1 MB result data and the shared provider deadline. The one-second server worker resumes stored queued work, but interrupted paid processing requires a new explicitly confirmed run. There is no shared report-result permission system, subscription or scheduled report delivery.

## Settings, export, forms

- `GET /api/settings` → `{user,settings}`.
- `PATCH /api/settings`: `{name?,workspaceName?,settings?}` → `{user,settings}`. Workspace name/default changes require owner/admin; any user may change their own display name.
- `GET /api/integrations` → `{items}` with actual `configured`, `available`, `status`, and explanatory descriptions. This directory is supplemented by dedicated provider status endpoints below; configured adapters still require credentials, workspace allowlists and explicit activation.
- `GET /api/reports/export?resource=conversations` → workspace-scoped, permission-filtered CSV download with formula-injection protection. Any supported resource can be exported.
- `GET /api/health` → `{ok,storage,services}`.
- Public `POST /api/demo-requests`: `{name,email,company,companySize?,message?}` → `{ok,message}` (201). Stores the request; does not send email.
- Public `POST /api/newsletter`: `{email}` → `{ok,message}` (201). Stores interest; does not subscribe to an external mailing service.

## Provider configuration

Text also supports RoboApply-compatible `LLM_PROVIDER=openrouter`, `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` (or `OPENROUTER_API_BASE_URL`), exact `LLM_MODEL`, and `LLM_WORKSPACE_IDS`. If defined, `LLM_WORKSPACE_IDS` supersedes the legacy OpenAI text allowlist even when blank. Notes, job drafts, application evidence assistance and report columns share this configuration without new provider credentials. Audio remains separate. See [provider setup](../docs/RECONSTRUCTION.md#text-gateway-and-voice-screening).

Optional `LLM_REASONING_EFFORT` applies generally; nonempty `LLM_JOB_REASONING_EFFORT` and `LLM_INTERVIEW_REASONING_EFFORT` override it for their task. Values: `none|minimal|low|medium|high|xhigh|max|provider`; `provider` omits reasoning controls. Invalid explicit values fail before a paid call. Job requests default to low reasoning only for recognized OpenAI reasoning-family names; chat/pro/custom aliases and other models retain provider defaults. OpenRouter uses `reasoning.effort`, direct OpenAI uses `reasoning_effort`. Exact model names and request budgets are preserved. Streamed and complete-JSON response readers both honor cancellation and deadlines explicitly; neither triggers automatic retries.

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

Sequence draft `steps` use `{kind,subject,body,delayDays,format,cc,bcc}`. Kinds are automatic `email` and manual `manual_email`, `linkedin_message`, `linkedin_connection`, `linkedin_inmail`, `call`, `sms`, `task`; missing kind preserves legacy email behavior. `format` is `plain` or `formatted` (restricted safe markup). Only automatic email supports copies, at most five distinct Cc/Bcc addresses per step. `enrolledCandidateIds` selects workspace candidates. Optional `settings` contains `{timezone,weekdays,startHour,endHour}` with an IANA timezone and Sunday=0 through Saturday=6.

- `GET /api/sequences/:id/delivery/preview` → personalized recipients, eligibility, delivery mode/configuration and a revision hash.
- `GET /api/sequences/:id/delivery` → current enrollments, messages, events and configuration.
- `GET /api/sequences/:id/delivery/messages/:messageId` → authorized message text and delivery state.
- `POST /api/sequences/:id/delivery/launch`: `{revision,acknowledged:true,mode:"outbox"|"resend"}` → `{ok:true,enrollmentIds,mode}` (201).
- `POST /api/sequences/:id/delivery/control`: `{action:"pause"|"resume"|"stop"|"replied",enrollmentId?}` → `{ok:true,changed}`.
- `POST /api/sequences/:id/delivery/reconcile`: `{}` refreshes bounded provider delivery state.
- Public `GET /api/outreach/unsubscribe/:token` displays a confirmation form; `POST` suppresses the recipient for that workspace and cancels future steps.

Launch/control/status reconciliation require owner/admin. Outbox mode persists messages without delivery. Live mode requires the Resend configuration and workspace allowlist. Approved recipient/content snapshots, delays, idempotency keys and bounded retries persist. Unknown delivery outcomes require attention rather than blind retry. Replies are marked manually, not detected from an inbox. The server worker runs every 15 seconds; limits and setup are in the reconstruction document.

Manual-only schedules can use candidates without email addresses. Manual-task completion explicitly advances the schedule and never transmits a message. Copied recipients participate in immutable approval, suppression checks and a durable 1,000-recipient-slot/workspace/24h ledger. The unsubscribe form accepts a copied recipient's own address without exposing Bcc or the recipient group. Message-level provider bounces suppress the approved group because polling cannot identify which copy bounced.

## Sequence editor and private AI drafts

- `GET /api/sequence-workspace` returns saved sequences, observed activity metrics, sender and AI availability.
- `GET /api/sequence-workspace/:id` returns the sequence and revision fingerprint.
- `POST /api/sequence-workspace` creates a validated draft; `PATCH /api/sequence-workspace/:id` requires the matching revision. Saving never launches delivery.
- `GET /api/sequence-drafts` lists the author's private proposals; `POST` accepts `{requestId,instruction,draft,sequenceId?,revision?}`. The draft has name, description, steps, optional settings and candidate IDs. Candidate records and copied addresses are excluded from the model request; AI cannot add copies.

Subjects are required for automatic email, manual email and InMail; other manual channels accept optional titles. Sequence generation requests streaming with a 120-second deadline and observes cancellation. A complete successful primary-choice response is required; truncated, refused, filtered or length-limited output is rejected. Compatible complete-JSON fallback responses must also end successfully. Other text workflows retain their own configured bound or the shared 60-second default. Failed generation is recorded and does not retry automatically; replaying the same request identity returns its existing state.

Generation uses the configured text model/allowlist, persistent request identity, 30/workspace/hour budget and at most two simultaneous calls. Saved-source edits invalidate proposals. The client explicitly applies a proposal to the editor; save and delivery approval remain separate. At most ten steps and 100 candidate IDs are accepted.

## Private sourcing sessions

- `GET /api/sourcing` returns private sessions, saved professional reference profiles and availability.
- `POST /api/sourcing/sessions` accepts `{requestId,prompt,context?,mode?,source?,referenceId?,referenceProfiles?,manual?,exclusions?}`. Modes: `sourcing`, `lookalikes`, `market`, `talent`; sources: `workspace`, `pdl`. Up to five reference URLs resolve only to saved LinkedIn profiles.
- `GET/PATCH/DELETE /api/sourcing/sessions/:id` reads, updates or discards an owned session. Updates require the numeric revision. Criteria contain bounded lists of titles, locations, skills, companies, keywords and excluded companies; `exclusions` is `{pastSearches,sequenced}`.
- `POST /api/sourcing/sessions/:id/runs` requires `{requestId,revision,consent:true,size?,afterRunId?}`. Pack size is 1–25 (default 20). Pagination requires the preceding ready pack and unchanged criteria/library snapshot.
- `PATCH /api/sourcing/sessions/:id/reviews` stores private reviews; `POST .../import` explicitly imports selected professional results to the candidate library.
- `GET /api/sourcing/sessions/:id/runs/:runId/export.csv` exports an authorized result pack and private reviews with formula protection.

Sessions/results/reviews are author/workspace-scoped. Changed/deleted workspace profiles are withheld from old results. History exclusions do not expose another user's searches. PDL requires its key and `SOURCING_WORKSPACE_IDS`; only selected professional resume fields are retained. Exclusions filter bounded PDL results after retrieval, so discarded results can consume credits. Failed/discarded paid requests still count: 15/user/hour, 40/workspace/hour and two concurrent requests. Sessions hold at most 50 packs. No global market estimate, external contact discovery or recruiting decision is generated.

## Private screening question drafts

- `GET /api/screening-drafts` lists owned drafts and AI availability.
- `POST /api/screening-drafts` accepts `{requestId,brief,context?,jobId?,questionCount?,consent:true}`. Brief/context are at most 12,000 characters each; question count is 3–10 (default 5). Only role data is sent to the model.
- `POST /api/screening-drafts/:id/apply` requires `{confirm:true}` and returns an editable proposal with questions and private rubrics. No shared screening or candidate link is created.
- `DELETE /api/screening-drafts/:id` discards the draft and aborts active generation where possible; its paid-request identity and budget remain reserved.

Job fingerprints, session identity and provider access are rechecked after generation and before apply. Limits: 15/user/hour, 30/workspace/hour, two active requests, 100 retained drafts/user, a 120-second controller/adapter deadline and 6,000 output tokens. The adapter requests streaming and exposes only a complete, validated proposal; the existing model/provider is unchanged, with no automatic paid retry. The editor saves reviewed questions; publication strips private rubrics/context/goals from public snapshots.

## Billing

- `GET /api/billing` → configuration, test/live mode, management permission, active seats, provider prices, pending checkout and subscription state.
- `POST /api/billing/checkout`: `{plan,seats,acknowledged:true}` → configured Stripe checkout; owner/admin only. Seats must cover current active membership and are bounded to 1–1,000.
- `POST /api/billing/checkout/cancel`: `{}` cancels/reconciles a pending checkout.
- `POST /api/billing/portal`: `{}` → customer-portal URL for the authenticated workspace.
- `POST /api/billing/refresh`: `{}` refreshes provider subscription state.
- `POST /api/billing/webhook`: raw JSON body and `Stripe-Signature`. Signature, five-minute freshness, test/live mode, workspace/customer binding and replay/stale-event checks precede updates.

Setup requires allowed workspace IDs, Stripe credentials, recurring price IDs and HTTPS public URL. Browser input cannot select arbitrary provider prices or customers. Subscription tracking does not yet enforce feature/usage entitlements. No live payment is part of the test evidence.

## Screening workspaces

- `GET /api/screening-workspaces` → `{items}`; `GET /api/screening-workspaces/:id` → `{item}`. Both require an active session and use the current workspace.
- `POST /api/screening-workspaces`: `{title,description,jobId?,screeningConfig}` → `{item}` (201). Job association must resolve in the same workspace. The dedicated create endpoint caps a workspace at 1,000 screenings.
- `PATCH /api/screening-workspaces/:id`: the same definition plus `{revision}` → `{item}`. Revision is the previously read `updatedAt` string; a mismatch returns 409. The UI retains unsaved edits until the reviewer reloads or discards them.

`screeningConfig` has strict version `1`, `setup:{welcomeMessage,completionMessage,language,voice,interviewMode?,cameraPolicy?}`, `context:{role,company}`, `outreach:{deadlineDays}`, and `sections:[{id,title,goal,questions}]`. Messages are at most 5,000 characters; role/company context at most 12,000 each. Supported locale values are `en-US,en-GB,es-ES,fr-FR,de-DE,pt-BR,zh-CN,ja-JP`; voice is a local browser voice name of at most 150 characters. `interviewMode` is `questionnaire` (default) or `live`; `cameraPolicy` is `optional` (default), `required` or `off`. These settings do not automatically translate saved questions. `deadlineDays` is an integer from 1–30, default seven in a new configuration.

There are 1–20 sections and at most 50 questions total. Section title is 1–120 characters and private goal is at most 2,000. Questions are `{id,prompt,type,options,required,rubric,followUp}` with UUID identities unique across sections/questions, prompt and private rubric at most 2,000 characters, and up to 20 options of at most 200 characters. Types remain text, yes/no and multiple choice. Incomplete prompts/options may be saved as a draft; publication validates completeness and distinct choices. Entire saved records are capped at 150,000 bytes. Saves retain a flattened question list for existing runtime endpoints. Legacy questionnaires are mapped into the editor on read without rewriting stored data or existing publications.

Saved configuration, section goals and rubrics are hiring-team data. Candidate publication explicitly excludes private goals, role/company context and rubrics. It includes only public title/description/workspace name, validated questions with section titles/follow-up flags, and allowlisted setup messages/language/voice. Messages resolve `{{screening_title}}` and `{{company_name}}` before being frozen in the publication.

## Published screening

- `POST /api/screenings/:id/publish`: `{}` → an immutable questionnaire link expiring after configured `deadlineDays` (1–30; default/legacy seven). Only workspace owners may publish. At most 100 active links per screening; existing publications are not changed by draft edits.
- Public `GET /api/interviews/:token` → questionnaire details, without prior candidate responses.
- Public `POST /api/interviews/:token/responses`: `{candidateName,email,consent:true,answers:[{questionId,value}]}` → persisted response receipt. One response per link; identical retries are idempotent.
- `GET /api/screenings/:id/responses` → workspace-authorized response/publication review.
- `DELETE /api/screenings/:id/publications/:publicationId` revokes a link; workspace owner required.
- `GET /api/screenings/:id/reviews` → `{items}` with shared human review records for that screening’s submitted responses.
- `PATCH /api/screenings/:id/responses/:responseId/review`: `{revision,status,notes}` → `{item}`. An active workspace member must have a response belonging to this screening/workspace. Status is `unreviewed|reviewed|progressed|rejected`; notes are trimmed and at most 10,000 characters. Initial revision is zero; each save increments it and stale writes return 409. Records include response identity, reviewer identity/name and update time; they are never returned by public candidate endpoints.

Question types are text, yes/no and multiple choice. Submission validates required answers against the published snapshot. The candidate view uses the frozen welcome/completion copy and narration settings; private configuration and shared review notes remain excluded. Review status is a manually saved local annotation, not an ATS stage change or automated eligibility decision. Live interview sessions and reviewed invitation/reminder delivery are described below. Automated hiring scores, rejection messages and ATS decisions remain unimplemented.

## Document extraction boundaries

Parsing runs in an isolated worker with a 10-second timeout, a 128 MB JavaScript heap budget, and at most two concurrent document workers. PDFs are limited to 200 pages, sequential page processing, and a 1-megapixel declared image limit. DOCX archives allow at most 1,000 entries, 20 MB of declared expanded data, and 4 MB per text XML part; actual decompressed text parts are counted while streaming and verified against their declared sizes. Extracted text is limited to 800 KB. No document HTML is produced. PDF scripting/eval and XFA are disabled; DOCX external relationships, images, macros, and embedded packages are not followed. XML entity/DOCTYPE declarations are rejected. Network fetches from the worker are disabled.

DOCX extraction reads main-document paragraphs and table text, plus headers, footers, footnotes, and endnotes. It preserves text rather than layout and omits deleted text and field instructions. PDF extraction requires a text layer; OCR for scanned PDFs is not implemented. Corrupt, encrypted, empty, or unsupported documents return a clear 422 error; limits return 413 and worker saturation returns 429. Failed uploads are removed and no conversation is created. Documents can instead be supplied with an explicit transcript.

Libraries were selected against their primary documentation: [unpdf](https://github.com/unjs/unpdf), [yauzl](https://github.com/thejoshwolfe/yauzl), and [xmldom](https://github.com/xmldom/xmldom). All declare Node engine ranges that include Node 22, 24, and 26.

## Voice screening

- Public `GET /api/interviews/:token/voice` → `{available,maxSeconds,maxAttemptsPerQuestion,mode,provider,clarification,audioRetention}`; active immutable publication required.
- Public `POST /api/interviews/:token/voice/transcriptions`: multipart `audio` (canonical mono 16 kHz 16-bit PCM WAV), `questionId`, UUID `requestId`, `consent:"true"`, optional `parentTurnId` → transcript and linked `turnId`, optional clarification. At most two minutes, three attempts per question, 60 per publication, 120 per workspace/hour; consent and active funded workspace required. Repeated request IDs return stored results instead of duplicate billing; interrupted attempts fail explicitly. Client disconnect aborts provider I/O.
- Existing candidate submission accepts optional `voiceEvidence:[{questionId,turnId}]`. The server validates ownership of complete turns and attaches original transcripts/duration/timestamps/candidate-edited flags to owner-visible responses. Browser-supplied provenance is never trusted. Corrected text remains the submitted answer.

Raw recordings are held only while processing. Optional one-question clarification uses the separately configured text model, without scoring or hiring decisions; a published `followUp:false` disables that model call. Missing local narration voices leave written questions available. Written answers remain available when audio is disabled. Detailed provider setup and retention boundaries are in [RECONSTRUCTION.md](../docs/RECONSTRUCTION.md#text-gateway-and-voice-screening).

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

## Live screening interviews

- `GET /api/live-interviews/status` (active session) → `{available,missing,recording:false,maxMinutes:30}` for the current workspace. Publication and invitation preview/queue/dispatch reject unavailable live configuration.
- Public `GET /api/interviews/:token/live/status` returns current capability and live session state.
- Public `POST /api/interviews/:token/live/sessions` creates/replays a bounded session with explicit consent and a request identity; the response includes a narrowly scoped room token. See the strict request schema in `live-interviews.ts`.
- Public `GET /api/interviews/:token/live/sessions/:sessionId` returns current state/transcript; `POST .../:sessionId/end` ends the matching session. Publication, workspace and session scope are checked each time.
- `POST /api/live-interviews/callback` accepts bounded JSON with `{eventId,sessionId,sequence,kind,questionId?,text?}`. HMAC-SHA256 covers `timestamp + "." + rawBody`; headers are `X-ArkOffer-Timestamp` (milliseconds) and `X-ArkOffer-Signature` (hex), with a five-minute window. This route is mounted before JSON parsing/browser Origin checks. Event identity/body and increasing sequence are verified.
- `POST /api/interviews/:token/responses` accepts optional `liveSessionId` for an ended/failed session of that publication. The server retains original answer transcripts and flags candidate edits.
- `GET /api/screenings/:id/responses/:responseId/live` requires an active workspace member and returns only sessions attached to that submitted response. Reviewer UI shows original transcripts separately from final candidate answers.

Room sessions require configured LiveKit, an allowed workspace, a registered ArkOffer interview agent and speech/text providers. Tokens cannot record or manage rooms. Expiry, revocation, completion and shutdown trigger room cleanup. Audio/video are streamed, not archived; see `agents/interview` and [delivery setup](../docs/SCREENING_DELIVERY_UPDATE.md).

## Screening invitations and reminders

- `GET /api/screenings/:id/outreach` → invitation history and delivery readiness/mode.
- Owner-only `POST /api/screenings/:id/outreach/preview`: `{revision,candidateIds?,recipients?:[{name,email}],subject,body,reminderDays?}` → immutable 15-minute preview, with 1–50 unique recipients and at most five reminders. The template variables are `candidate_name`, `candidate_first_name`, `screening_title`, `company_name`, `interview_link`, `deadline`.
- Owner-only `POST .../outreach/queue`: `{previewId,requestId,confirmed:true}` → creates individual immutable publications and queued delivery records. It checks the screening revision, current candidate records, delivery configuration, duplicate active recipients, opt-outs and live readiness. The same request/preview can replay without duplicate mail.
- Owner-only `POST .../outreach/invitations/:invitationId/cancel`: `{confirmed:true}` cancels pending messages and revokes its candidate link.
- Owner-only `GET .../outreach/invitations/:invitationId/preview` returns the resolved message and capability link only under the original delivery settings. `Cache-Control: no-store` applies.
- Public `GET /api/screening-outreach/unsubscribe/:token` confirms intent; `POST` suppresses future screening emails to that address in that workspace. GET does not unsubscribe.

Default reminders are three and one days before the saved 1–30 day deadline. Pending delivery is cancelled on completion, expiry, revocation, candidate removal, loss of author ownership or opt-out. Missed reminder windows older than six hours and reminders within 24 hours of another delivery are skipped. Provider-accepted mail is distinct from delivered mail; unknown/interrupted sends require manual provider review and are not retried. Outbox records are previews, not delivery.

## Report sharing and subscriptions

- `GET /api/report-views/:id/sharing` reads named workspace grants. Author-only `PUT` accepts `{revision,grants:[{userId,permission:"viewer"|"editor"}]}` and conflicts on stale revisions. Viewers read; editors may edit definitions/presentation/annotations and explicitly run extraction. Only the author manages grants or deletes the report.
- Report list includes authored and granted reports; favorites remain per user. Every result, evidence view, aggregate, annotation and CSV rechecks underlying conversation access and source freshness. A report grant alone reveals no private conversation evidence. AI definition proposals remain private to the requesting author.
- `GET /api/report-views/:id/subscription` reads the signed-in user's settings and delivery history. `PUT` accepts `{revision,enabled,frequency:"immediate"|"weekly"|"monthly",notifyResults,notifyUpcoming,utcHour,weekday,monthDay}`. Hour is 0–23 UTC, weekday 0–6 (Sunday–Saturday), month day 1–31 (clamped to the final day of shorter months). Only the user's current email may receive their subscription; live mail requires a verified account address.
- `GET /api/report-views/:id/subscription/deliveries/:deliveryId` produces a fresh, permission-checked preview of that subscriber's delivery.
- Public `GET /api/report-subscriptions/unsubscribe/:token` is a confirmation page; `POST` disables that subscription and cancels pending mail.

New-result notifications cover completed current-revision runs and currently matching, unchanged, accessible sources. Upcoming reminders apply to selected matching conversations explicitly scheduled with a timezone-bearing start timestamp within 30 minutes; date-only entries are not guessed. Schedules never initiate AI extraction, skip empty digests and recheck subscription revision, membership, report/source access, email and delivery settings at dispatch. Queues retain stable send identities, do not retry uncertain outcomes and distinguish local outbox, provider acceptance and failures. Sharing/subscription APIs do not enable public report links or emailed CSV attachments.
