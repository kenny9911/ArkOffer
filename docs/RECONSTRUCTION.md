# ArkOffer reconstruction: evidence and scope

ArkOffer is a working local full-stack reconstruction of the observed Metaview website and selected recruiting workflows. It is **not a 100% functional clone of Metaview**. It has its own React frontend, Express API, SQLite storage, authentication, and optional AI provider. Metaview's private source code, backend services, production datasets, and integration credentials were not obtained.

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

The browser uses React, TypeScript, React Router, and Vite. Public pages live in `client/marketing`; authenticated screens live in `client/workspace`. The Express API in `server/app.ts` serves authenticated workspace resources and public form submissions. SQLite persists records in `DATA_DIR/arkoffer.sqlite`; uploaded sources are stored under `DATA_DIR/uploads`.

Signup creates an independent workspace with 12 editable built-in templates. Optional example conversations and candidates are fictional. Login uses a password and a seven-day HttpOnly session cookie; only a session-token hash is stored. Resource lookups, historical versions, source downloads, and exports are scoped to the authenticated workspace. Mutating requests require an allowed origin. These are implemented protections, not an assertion of enterprise certification or a completed production security audit.

The main usable flows are:

- Create an account; log in and out; update the user's name and workspace settings.
- Paste a transcript, upload a source, or record audio through browser microphone permission. An upcoming entry can be created manually.
- Generate clearly labeled local transcript highlights, edit sections and TLDR, save text snippets, maintain collections, archive records, and restore note versions.
- Ask questions against a transcript, inspect source excerpts, copy/export notes, and create or revoke an expiring read-only share link.
- Create and import candidates, save searches over the local candidate library, record manual decisions, draft sequences and enrollment, maintain job descriptions and applications, and build screening drafts with a nonpersistent candidate preview. Published screenings use separate expiring links that accept persistent text/choice responses; they do not send invitations automatically.
- View charts calculated from local records, save report filters, and export CSV.
- Submit a demo request or newsletter interest to local persistent storage.

These flows use the reconstruction's API. They do not forward requests to Metaview or reuse its tracking scripts, authenticated endpoints, or account cookies.

## AI and files

Without `OPENAI_API_KEY`, note generation extracts transcript highlights and the assistant retrieves matching transcript lines. The UI/API identify that mode as extraction. It does not impersonate model reasoning, evaluate candidate suitability, or fabricate transcription. Format and length preferences affect extraction and model output. Workspace defaults and per-generation overrides are applied. Custom template synthesis and explicit translation require the optional model provider; local extraction preserves the transcript language.

With a configured server-side key, explicit actions can request OpenAI note generation, transcript-based answers, or supported recording transcription. The model name is configurable. Generation and question answering send at most the first 100,000 transcript characters; API source metadata discloses clipping. Provider failure leaves prior notes intact. A concurrent edit detected before a provider result is committed returns a conflict instead of overwriting the newer record. Tests simulate model responses; a successful live paid-provider run is not part of the evidence recorded here.

Uploads accept supported text, VTT, PDF, DOCX, audio, and video up to 50 MB; document extraction has a stricter 10 MB input limit. Text and extracted document content are capped at 800 KB. Text-based PDF and DOCX extraction creates a ready conversation with source metadata. PDF extraction is limited to 200 pages; DOCX processing limits expanded data to 20 MB, each XML part to 4 MB, and archive entries to 1,000. Extraction runs in bounded workers with a ten-second deadline and at most two concurrent jobs. Scanned PDFs need OCR, which is absent. Corrupt, empty, unsupported encrypted, or oversized documents produce explicit errors and failed uploads are removed without creating a note. Optional recording transcription has a separate 25 MB provider limit. Uploaded audio/video has authorized byte-range playback, but no synchronized word timing, automatic speaker correction, or extracted video clips.

Published screening links use an immutable question snapshot and a random bearer token; only its hash is stored. Each seven-day link accepts one candidate response with name, email, consent, and validated answers. An identical retry is idempotent; a changed repeat is rejected. Workspace-authorized users can review responses, and owners can revoke links. Public reads do not expose submitted identity or answers. A draft preview remains nonpersistent.

## External services and remaining work

| Dependency                        | Present implementation                                                                              | Work still required for the source workflow                                                                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI notes and transcription        | Optional server-side OpenAI requests, local extraction fallback, explicit errors and source limits. | Configure a key/model and validate real recordings and model quality. Other provider support and source-product equivalence are unverified.                                 |
| Calendar and live meeting capture | Manual upcoming records and browser microphone recording.                                           | Google/Microsoft OAuth, calendar sync, invitations, conferencing bot infrastructure, consent and retention workflows.                                                       |
| ATS and candidate providers       | Local candidate, application, and job records; CSV import/export.                                   | Provider contracts, OAuth, webhooks, field/stage mapping, deduplication, remote updates, external search and contact enrichment.                                            |
| Outreach and notifications        | Draft sequences, saved enrollment, locally stored demo/newsletter submissions.                      | Mailbox authorization, actual sending, scheduling, unsubscribe/bounce handling, replies, analytics, email notifications and mailing-list delivery.                          |
| Screening execution               | Saved question plans, preview, and published text/choice sessions with persistent responses.        | Invitation delivery, voice/video sessions, automated evaluation, configurable deadlines/reminders, and ATS stage automation. Published links have a fixed seven-day expiry. |
| fillmore / Slack coworker         | Honest unavailable state and setup requirements.                                                    | Slack app/OAuth, permission-aware retrieval, autonomous tasks, approvals, external communications, scheduling and monitoring.                                               |
| Team and enterprise identity      | Independent workspaces with local session authentication.                                           | Membership and invitation flow, role permissions, shared-with-me collaboration, SAML/OIDC, SCIM, seat management and organization administration.                           |
| Commercial operation              | Illustrative pricing controls and demo intake.                                                      | Checkout, subscriptions, invoices, entitlements, credits, usage metering and payment webhooks. No purchase occurs on pricing pages.                                         |
| Production operation              | Local persistence, scoped APIs, validation, CI configuration.                                       | Choose and validate deployment, backups, recovery, operational monitoring, scalability, applicable retention controls, and production legal policies.                       |

Adding a credential does not enable an unimplemented connector. The integration screens deliberately distinguish configuration from available functionality.

## Public content and asset provenance

The homepage follows the observed visual structure: announcement strip, white navigation, rounded calls to action, split hero, product selector, feature accordions, resource cards, and footer. ArkOffer replaces the source brand and uses original educational articles and company copy. It does not claim Metaview's customers, funding, certifications, hiring openings, or testimonials.

The hero image and fonts downloaded from observed public asset URLs are recorded with origins and hashes in [origins.json](../public/marketing/origins.json). Public availability is not a license grant. Their ownership and use rights must be resolved for distribution or replaced with licensed assets. The legal pages are explicitly draft ArkOffer documents, not copied Metaview policies or finalized advice.

## Validation evidence and boundaries

The repository provides three reproducible checks:

```sh
npm test
npm run build
npm run test:e2e
```

Final local verification passed **29 API tests and 11 browser tests**, the production build, and formatting checks. The API total includes 21 core checks and eight published-screening checks. The core suite also passed on Node 22.23.3 and 24.21.0, with the combined backend suite passing on Node 26.8.1. `npm audit --omit=dev` reported no known production dependency vulnerabilities at review time; this is not a complete security audit.

The API suites in [api.test.ts](../tests/server/api.test.ts) and [screening.test.ts](../tests/server/screening.test.ts) cover workspace isolation, cookie lifecycle, origin validation, resource persistence, upload authorization and cleanup, history restore, expiring/revoked shares, extraction citations, CSV safety, public form persistence/rate limits, record limits, document extraction boundaries, screening consent/response validation, and simulated provider behavior and concurrent-edit preservation. The browser suites in [workspace.spec.ts](../tests/e2e/workspace.spec.ts) and [business.spec.ts](../tests/e2e/business.spec.ts) exercise real local browser-to-API persistence, including anonymous screening submission, private response review, settings-tab isolation, delayed template saves, and generation-failure preservation. A simulated late microphone-permission test verifies that closing the dialog stops the eventual stream; it does not establish successful physical microphone capture. Their checks do not call the original service.

Independent marketing checks exercised 19 public routes, desktop and 390-pixel layouts, navigation, resource search/category filtering, pricing controls, and successful local demo/newsletter submissions. No JavaScript errors or horizontal overflow were observed in those checked pages. Screenshots support layout review; they are not pixel-difference proof of the whole source site.

The GitHub workflow installs dependencies, runs API tests, builds, and runs Chromium browser tests. A workflow file alone is not a passing remote run. Delivery status and the final executed check results belong in the associated pull request. Untested external integrations, real provider calls, load behavior, accessibility conformance, and exhaustive source-site parity must not be inferred from these targeted checks.

## Public reference index

- [Metaview homepage](https://www.metaview.ai/), [pricing](https://www.metaview.ai/pricing), [resources](https://www.metaview.ai/resources), and [integrations](https://www.metaview.ai/integrations).
- [Navigation](https://support.metaview.ai/get-started/navigation), [working with notes](https://support.metaview.ai/notes/working-with-notes), [templates](https://support.metaview.ai/notes/templates), [transcript and recording](https://support.metaview.ai/notes/transcript-and-recording), [snippets](https://support.metaview.ai/notes/snippets), [assistant](https://support.metaview.ai/notes/assistant), [sharing/export](https://support.metaview.ai/notes/share-and-export), and [collections](https://support.metaview.ai/notes/collections).
- [Sourcing](https://support.metaview.ai/sourcing/overview), [application review](https://support.metaview.ai/application-review/overview), [screening setup](https://support.metaview.ai/screening/setup), and [reports](https://support.metaview.ai/reports/overview).
- [Team management](https://support.metaview.ai/account-management/managing-your-team), [workspace settings](https://support.metaview.ai/account-management/workspace-settings), [outreach](https://www.metaview.ai/outreach), and [fillmore](https://www.metaview.ai/fillmore).
