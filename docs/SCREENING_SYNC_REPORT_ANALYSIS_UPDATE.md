# Synchronized interview playback and report analysis — 13 October 2026

This continues the [recording and public report delivery](SCREENING_RECORDING_PUBLIC_REPORT_UPDATE.md), using the previous signed-in observations and partial static REA evidence as the source baseline. It adds independent ArkOffer workflows; it does not establish complete Metaview functionality or private backend equivalence.

## Transcript-synchronized playback

The interview agent sends genuine speech start/end timestamps with signed transcript events. Candidate speech uses LiveKit's VAD-corrected utterance bounds, and interviewer speech uses the completed audio playout metrics. The server validates the speaker, ordering and session bounds before storing optional timing. It does not use callback receipt times as speech timestamps.

Recording synchronization uses the Egress output file's start timestamp, not the job's creation time. Private recording transcripts expose only original speech attached to the explicitly submitted interview. The reviewer can search, seek by transcript turn, follow the active turn and navigate by keyboard while playing the existing authorized MP4. Final candidate-corrected answers remain separate evidence. Playback, transcript reads and downloads retain workspace access checks, submitted-session scope, expiry and deletion controls.

Synchronization is approximate at utterance level: VAD and playout clocks are not word-level forced alignment. Agent and media hosts require synchronized clocks. Older events without speech bounds, recordings without a file start timestamp and out-of-range turns remain readable without a seek target. No historical timing is reconstructed from arrival time or guessed from text length. Existing provider requirements still apply; no LiveKit/S3 credentials were added or live recordings created in this delivery.

## Typed result filters

Saved result analysis is independently revisioned from both the extraction definition and the legacy quick-chart presentation. It does not start extraction, consume model budget, cancel a run or change a reviewed public publication. Authors and named editors can save it; named viewers can inspect authorized results and export them.

Up to twelve conditions combine with **all (AND)** or **any (OR)**. Supported fields are completed text, number, boolean and currency columns, plus captured conversation creation/date, candidate, interviewer, status and duration. Operators include equality/inequality, text contains/does not contain, numeric/date comparisons and documented presence/absence. Text comparisons ignore case. Date comparisons use UTC calendar days. Currency comparisons require an explicit currency; amounts in another currency are unknown for that predicate and are never converted or treated as zero.

Missing/not-documented values differ from pending, failed and unavailable values. Negative predicates do not accidentally include incomplete or inaccessible results. AND/OR uses unknown-aware logic: an AND with a known false condition fails; an OR with a known true condition matches; otherwise unresolved evidence remains unknown. Counts distinguish matched, excluded, unknown and unavailable conversations. The UI makes filtered results versus all available evidence explicit. A separate filtered CSV exports the saved selection; legacy full-result CSV and subscription counts keep their existing behavior.

## Multiple saved charts

A report can save up to six named bar, line or stacked charts. Each chart has its own grouping, optional text/boolean split, and count/sum/average metric. Numeric metrics include captured conversation duration. Currency totals remain in separate units/panels. Stacked charts require a split field and an additive count or sum; averages are not stacked. Negative values use a diverging baseline. Exact aggregate tables and individual chart CSV exports accompany the visuals.

Date groups use daily, Monday-start weekly or monthly UTC buckets, in chronological order and with calendar-based horizontal positions. Unobserved buckets are not fabricated as zeros. Chart counts expose missing, pending and failed inputs. Legacy categorical quick charts remain available, separately saved and backward compatible. A historical run with an absent or incompatible field shows a compatibility issue instead of silently reinterpreting the saved filter/chart.

## Historical metadata and access

New report runs capture a bounded versioned metadata snapshot alongside each existing source snapshot. Title/transcript source hashes and AI prompt contexts remain unchanged. Metadata is exposed only after the existing current source-access/freshness check succeeds. Editing a conversation's date, candidate or duration does not rewrite a historical snapshot. Legacy runs retain null metadata; it is not backfilled from mutable current records.

Analysis always consumes the already-authorized serialized run. It never aggregates hidden stored cells. Revoked, deleted, archived or stale sources are excluded before predicates, metrics and CSV. Public links remain the separately reviewed projection of selected completed result cells; private filters, chart definitions and captured metadata are not automatically added to anonymous output. Existing subscriptions retain their original source checks and result counts.

## Validation and remaining gaps

Tests use synthetic workspaces, mocked speech/storage providers and deterministic completed report results. They cover real timing provenance, private transcript authorization, legacy fallback, seek/highlight/search, typed predicates and unknowns, historical metadata, UTC/currency grouping, revision conflicts, permissions/revocation, CSV safety, and preservation of extraction/public-sharing behavior. Final combined validation and remote checks are recorded in the delivery PR.

Live video/speech/Egress operation remains unverified without configured providers. Word-level alignment, media clipping/editing, full-plan interview chat editing, resume-grounded branching, automated translation/scoring, measured talk-time/late-start metrics, nested arbitrary filter expressions, list/date AI extraction types, chart cover images and enterprise/source-scale parity remain outside this delivery. See the current [parity matrix](PARITY.md).
