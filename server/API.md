# ArkOffer local API

The Express server stores workspace data in SQLite at `DATA_DIR/arkoffer.sqlite` and source uploads in `DATA_DIR/uploads`. `DATA_DIR` defaults to `./data`. Run on Node 22.13 or newer. There are no default accounts. Signup creates an independent workspace with 12 editable built-in templates, whether or not demo data is selected. Optional demo conversations and candidates are fictional and use example.com addresses.

Set `APP_ORIGIN` to the exact browser origin (or a comma-separated list) when frontend and backend origins differ behind a development proxy. All mutating API requests require an allowed `Origin` header. Session authentication uses a seven-day HttpOnly, SameSite=Lax cookie; the database stores only its hash. Production requires HTTPS for the Secure cookie. If an HTTPS reverse proxy terminates TLS, set `TRUST_PROXY=1` only when a trusted proxy is the sole entry point.

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

Conversations and jobs require `title`; the remaining resources require `name`. Applications and screenings also accept a `title`, `candidate`, or `candidateName` in place of a name. Validated custom JSON fields are retained, including template prompts/sections, sequence steps, report filters/columns, and candidate attributes. Server-controlled IDs, timestamps, source-file metadata/storage fields, and provider-processing metadata cannot be overwritten. Records and history are scoped to the authenticated workspace, including nested routes. Entire merged records are limited to 1 MB, including successive edits.

Conversation fields: `title`, `candidate`, `interviewer`, `date`, `duration` (minutes), `transcript`, `sections:[{id,title,content}]`, `tldr`, `status` (`ready|processing|upcoming`), `archived`, `collectionIds`, and read-only `shared`. Collection IDs must belong to the workspace. Every edit automatically saves a historical version; the newest 100 versions are retained. Adding a nonempty transcript to a pending upload changes it to ready. Source metadata is `file:{name,mimeType,size}`; storage paths and file IDs are not exposed. `shared` is computed from currently active, unexpired links.

Deleting a collection removes its ID from current conversations while preserving their content. Stale references to a collection previously deleted in the same workspace are removed from later edits; unknown IDs and IDs from another workspace remain invalid. Restoring an old note version also removes references to deleted collections.

## Conversation actions

- `POST /api/conversations/upload`: multipart `file`, optional `title`, `candidate`, and `transcript` → `{item}` (201). Audio/video uploads support up to 50 MB and remain pending until a transcript is supplied or transcription is requested. Text/VTT auto-imports at up to 800 KB. PDF/DOCX documents extract text locally at up to 10 MB per file; successful extraction returns a ready conversation with `sourceType:"document"`, `transcriptionStatus:"extracted"`, and `extraction:{status:"complete",type:"pdf"|"docx",pages?}`. A supplied transcript takes precedence over automatic extraction.
- `GET /api/conversations/:id/file`: authorized source-file attachment download.
- `GET /api/conversations/:id/media`: authorized inline audio/video playback with byte-range support. Other file types are rejected for inline playback.
- `POST /api/conversations/:id/transcribe`: `{}` → `{item,mode:"openai"}`. Requires `OPENAI_API_KEY`, a supported audio/video upload of at most 25 MB, and a successful provider response. Otherwise returns a clear error without fabricating text.
- `POST /api/conversations/:id/generate`: `{templateId?,format?,length?,language?}` → `{item,mode:"extractive"|"openai",source,preferences}`. `format` is `bullets|paragraphs`; `length` is `concise|standard|detailed`. Supported language values are `original`, `English`, `Chinese`, `French`, `German`, `Spanish`, `Japanese`, `Portuguese`, `Italian`, `Korean`, `Arabic`, `Hindi`, `Dutch`, `Swedish`, `Danish`, `Norwegian`, `Finnish`, `Polish`, `Turkish`, `Indonesian`, `Vietnamese`, and `Thai`. Unknown options are rejected. Per-call options override saved workspace `language`, `noteFormat`, and `noteLength` defaults. With a provider, these choices become explicit model instructions. Without a provider, plain generation preserves the original transcript language and selects 3/8/16 literal excerpts for concise/standard/detailed output, formatted as bullets or paragraphs. Explicit translation and template-based synthesis return 503 without changing existing notes when the provider is absent. Provider requests include up to the first 100,000 transcript characters. `source:{truncated,characters,totalCharacters}` discloses this limit and is persisted as `item.summarySource` alongside `item.summaryMode`. `preferences:{format,length,language,languageBehavior:"original"|"requested_language"}` is also persisted as `item.summaryPreferences`. Concurrent edits during provider requests return 409 instead of being overwritten.
- `POST /api/conversations/:id/assistant`: `{question}` → `{answer,mode,citations:[{text,start,end}],source}`. Local mode retrieves matching transcript lines; citation offsets refer to the original transcript. OpenAI mode answers against supplied transcript evidence. The same `source` metadata discloses provider clipping; citations only reference text the provider received.
- `GET /api/conversations/:id/versions` → `{items:[{id,label,createdAt,data}]}`.
- `POST /api/conversations/:id/versions`: `{label?}` → `{item}` (201).
- `POST /api/conversations/:id/versions/:versionId/restore`: `{}` → `{item}`. Saves the current version first.
- `GET /api/conversations/:id/shares` → `{items:[{id,createdAt,expiresAt}]}`.
- `POST /api/conversations/:id/shares`: `{expiresInHours?}` (1–720; default 168) → `{item:{id,token,url,createdAt,expiresAt}}`. The token is returned once; only its hash is stored. `url` is a relative frontend route.
- `DELETE /api/conversations/:id/shares/:shareId` → `{ok:true}`.
- Public `GET /api/shared/:token` → `{item}`. Read-only conversation evidence; no source files or workspace membership.

## Settings, export, forms

- `GET /api/settings` → `{user,settings}`.
- `PATCH /api/settings`: `{name?,workspaceName?,settings?}` → `{user,settings}`.
- `GET /api/integrations` → `{items}` with actual `configured`, `available`, `status`, and explanatory descriptions. Calendar OAuth, ATS synchronization, live meeting attendance, and outbound emails are not implemented.
- `GET /api/reports/export?resource=conversations` → workspace-scoped CSV download with formula-injection protection. Any supported resource can be exported.
- `GET /api/health` → `{ok,storage,services}`.
- Public `POST /api/demo-requests`: `{name,email,company,companySize?,message?}` → `{ok,message}` (201). Stores the request; does not send email.
- Public `POST /api/newsletter`: `{email}` → `{ok,message}` (201). Stores interest; does not subscribe to an external mailing service.

## Provider configuration

Optional server environment: `OPENAI_API_KEY`, `OPENAI_MODEL` (default `gpt-4.1-mini`), `OPENAI_TRANSCRIPTION_MODEL` (default `whisper-1`). Keys remain server-side. AI and transcription requests happen only on explicit action; demo creation and regular CRUD require no provider. Provider errors leave existing conversation notes intact. Credentials are never returned by the settings or integration APIs.

## Document extraction boundaries

Parsing runs in an isolated worker with a 10-second timeout, a 128 MB JavaScript heap budget, and at most two concurrent document workers. PDFs are limited to 200 pages, sequential page processing, and a 1-megapixel declared image limit. DOCX archives allow at most 1,000 entries, 20 MB of declared expanded data, and 4 MB per text XML part; actual decompressed text parts are counted while streaming and verified against their declared sizes. Extracted text is limited to 800 KB. No document HTML is produced. PDF scripting/eval and XFA are disabled; DOCX external relationships, images, macros, and embedded packages are not followed. XML entity/DOCTYPE declarations are rejected. Network fetches from the worker are disabled.

DOCX extraction reads main-document paragraphs and table text, plus headers, footers, footnotes, and endnotes. It preserves text rather than layout and omits deleted text and field instructions. PDF extraction requires a text layer; OCR for scanned PDFs is not implemented. Corrupt, encrypted, empty, or unsupported documents return a clear 422 error; limits return 413 and worker saturation returns 429. Failed uploads are removed and no conversation is created. Documents can instead be supplied with an explicit transcript.

Libraries were selected against their primary documentation: [unpdf](https://github.com/unjs/unpdf), [yauzl](https://github.com/thejoshwolfe/yauzl), and [xmldom](https://github.com/xmldom/xmldom). All declare Node engine ranges that include Node 22, 24, and 26.
