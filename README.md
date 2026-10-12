# ArkOffer

A runnable recruiting workspace and public website reconstructed from observable Metaview pages, with ArkOffer branding. It includes a React frontend, an Express API, persistent SQLite storage, and isolated user workspaces.

This is a working reconstruction, **not verified 100% Metaview parity**. REA captured the public website; the signed-in application was inspected through Chrome’s desktop UI. The source service’s private backend and enterprise integrations are unavailable. See [feature coverage and remaining gaps](docs/PARITY.md) and [inspection evidence and architecture](docs/RECONSTRUCTION.md).

## Run locally

Use Node.js 24 LTS (minimum 22.13).

```sh
npm ci
cp .env.example .env
npm run dev
```

Open [http://localhost:5174](http://localhost:5174). The API runs on port 3002. These ports avoid the existing GoApply development services on this machine. Register a new account; optional demo content is clearly synthetic. No Metaview credentials or private account records are included.

SQLite and uploaded files are stored in `./data` by default, outside Git. Restarting the app preserves them. Set `DATA_DIR` to a durable directory for a persistent installation. Back up the database and uploaded files together while the app is stopped.

## What works

- Account registration, password login/logout, sessions, workspace isolation, personal and workspace settings.
- Conversation creation, transcript and document import, browser audio recording, authenticated attachment playback, local transcript extraction, editable notes and TLDR, snippets, search, collections, archive/delete, history and restore, text/print export, expiring read-only share links and revocation.
- Twelve default note templates plus custom template creation, editing, duplication and deletion.
- Candidate records, CSV import, local candidate search and saved searches, sequence drafts and enrollment lists, manual application review, job descriptions, screening questionnaires, local reports and CSV exports.
- Responsive public pages, product navigation, pricing controls, resource articles, integration directory, saved demo requests and newsletter registrations.

Model-generated summaries, template-based notes, translation, transcript Q&A and audio transcription use OpenAI when configured on the server. Without a key, basic notes and Q&A use clearly labeled transcript extraction; translation and template generation report the missing provider and preserve existing notes.

```dotenv
OPENAI_API_KEY=your-server-side-key
OPENAI_MODEL=gpt-4.1-mini
OPENAI_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe
```

A configured model provider receives the transcript only when a user invokes the relevant action. API requests are bounded; provider errors leave existing notes intact. The UI identifies truncated source input. Keep provider keys in `.env` or the host’s secret store, never in client code or commits.

Calendar sync, meeting bots, ATS/CRM sync, candidate enrichment, automated email delivery, voice screening, billing, SSO and Slack are **not connected**. Sequence enrollment does not send email; scheduling creates a local entry. See the parity document for precise limits, including team collaboration and source features that were not observable.

## Validate

```sh
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm run format:check
```

API tests use isolated temporary databases. Browser tests start a separate production build on port 3412 with synthetic accounts and a temporary data directory; macOS uses the installed Google Chrome when available. Provider behavior is tested with mocked responses, not live paid requests. CI runs the API suite, build and browser suite on Node.js 24.

## Production build

```sh
npm run build
npm start
```

Express serves the built frontend and API on port 3002. `npm start` enables secure session cookies: put the app behind HTTPS and set `APP_ORIGIN` to the exact public origin. The server binds to `127.0.0.1` by default; configure `HOST` if required. All `/api` routes remain same-origin in the browser. Local HTTP preview should use `npm run dev`, not production mode.

This repository uses single-process SQLite and local file storage. It has no production deployment, operational monitoring, external mail transport or managed backups configured. Before exposing it publicly, provision HTTPS, durable storage, account recovery/email verification, abuse protection and provider credentials appropriate to the intended use. Do not use the draft legal pages as a production privacy policy.

## Project layout

- `client/marketing/`: public pages and interactions.
- `client/workspace/`: recruiting workspace and public shared views.
- `server/`: API, authentication, storage, providers and document extraction.
- `tests/server/`, `tests/e2e/`: API and complete browser workflows.
- `public/marketing/origins.json`: public reference asset provenance.
- [API reference](server/API.md): endpoint contracts and limits.

Captured private browser data, runtime uploads, cookies, provider keys and generated databases are excluded from the repository. Public reference asset provenance is recorded; independently written application logic replaces the inaccessible source backend.
