# Word timing and private video editing — 13 October 2026

This continues the [synchronized playback and report analysis update](SCREENING_SYNC_REPORT_ANALYSIS_UPDATE.md). It uses the existing signed-in observations and partial REA evidence as the product baseline; no new source audit or private backend equivalence is claimed.

## Recording studio

An owner or administrator can open the studio from a submitted interview's private recording player. A saved edit has a title, an independent revision and up to twelve source-time ranges. Ranges can be trimmed, reordered, removed or muted, and previewed in sequence against the original player. Concurrent edits preserve the local draft and require loading the latest version or saving a new copy. Saving does not process media.

An explicit export queues a snapshot of the saved edit. Later changes or deletion of the edit do not rewrite an existing export. FFmpeg re-encodes the selected ranges into a separate H.264/AAC MP4, verifies its duration, removes source metadata and chapters, and preserves the original. Members can preview/download ready exports; owners/admins can cancel jobs or remove exports. Boundaries follow actual frame/sample resolution. This supports excerpts and ordered cuts, not arbitrary multitrack production, overlays, blur or image replacement.

Edits require at least 0.1 seconds per range, at most the original recording's duration in total, and a source no larger than 250 MiB or 30 minutes. Each recording has at most twenty saved edits and thirty retained jobs; a workspace may have two pending jobs. The API processes one media job at a time with a ten-minute overall deadline. Operators need FFmpeg/ffprobe on the API host; see [processor setup](SCREENING_MEDIA_PROCESSOR.md).

## Word-level playback

An explicit, consented word-timing request extracts compressed audio locally and sends it to the configured speech transcription provider. It reuses the existing speech key, endpoint and workspace allowlist, with a dedicated word-timestamp model setting. Text LLM credentials do not establish speech access. No environment secrets were added or overwritten, and no live speech request was made during this delivery.

Measured provider word timestamps are conservatively matched to the original transcript within known utterance bounds. Matching retains the original spelling, punctuation and spacing. Matched words become seek buttons and highlight while spoken. Unmatched, repeated, ambiguous or unsupported words remain plain text with no guessed timing. Older transcripts without utterance bounds remain readable at their original level of timing. This is partial ASR-derived word alignment, not phonetic forced alignment or guaranteed acoustic precision. Corrected candidate answers remain separate evidence.

Word timing is stored independently of the original transcript and bound to a fingerprint of the recording and speech evidence. Changed evidence invalidates the cached result. Removing the current alignment restores the previous compatible result or the original turn-level transcript. Generation never changes a candidate response or hiring decision.

## Authority, retention and recovery

All studio routes inherit the original recording's active workspace membership, submitted-session scope, readiness and expiry. Creation/mutation requires current owner/admin authority. Queued jobs bind to the requesting session and recheck source access, membership, role and evidence before processing, during long work and before publishing results. Revocation or cancellation cannot publish a late result.

Original media is streamed into a bounded private job directory, processed with argument-array subprocesses and removed afterward. Derivatives and scratch files live below the private data directory and are never served statically. Downloads use authenticated byte-range routes. Source deletion/expiry immediately blocks descendants and queues filesystem cleanup; cascading source deletion retains cleanup tombstones. Interrupted processing becomes failed on restart and cleans its scratch files. Paid transcription is not automatically retried after an unknown outcome. Browser retries retain their operation identity until a response is confirmed.

## Validation and remaining gaps

Tests cover real synthetic FFmpeg trimming/muting/duration/source preservation, mocked speech timestamps, original-text preservation, API permissions and consent, edit conflicts, concurrent request identities, immutable exports, cancellation/revocation, restart and retention cleanup, private range reads, and browser editing/preview/word seeking. CI explicitly installs FFmpeg; local testing and remote check results are recorded in the delivery PR.

Live speech/LiveKit/S3 connectivity remains unverified without configured providers. Full phonetic alignment, manual per-word timing correction, burned-in captions, clip sharing outside the workspace, rich multitrack/redaction editing and enterprise/source-scale parity remain gaps. Reports keep the previously delivered filters/charts/sharing/subscriptions; their remaining meeting metrics, nested filters and source-discovery gaps are unchanged. See the [parity matrix](PARITY.md).
