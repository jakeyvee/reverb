-- Diarization columns on transcript_segments (VOL-111).
--
-- The transcribing step (VOL-110) writes one row per ASR segment with
-- speaker=null because Whisper does not diarize. The diarizing step in the
-- lesson pipeline now fills in `speaker` plus the audit fields below using an
-- LLM-inferred labeling pass. The original `text` column is never touched on
-- this update — diarization only labels.
--
--   speaker_confidence    Self-reported confidence in [0,1]. The prompt is
--                         instructed to clamp to ≤ 0.4 when speaker='unknown'
--                         so the UI can dim or hide low-signal labels.
--   speaker_notes         Optional one-line rationale; surfaced as a tooltip.
--   speaker_low_priority  Marks segments that should remain in the transcript
--                         view but be skipped by extraction (English /
--                         code-switched text, teacher meta-instructions).
--
-- Per-job prompt + model versions are stored on lesson_jobs.provider_metadata
-- under `diarizing_details`, not here, so a future reprocess can target only
-- the lessons whose labels came from an older prompt without scanning every
-- segment row.

alter table public.transcript_segments
  add column if not exists speaker_confidence real,
  add column if not exists speaker_notes text,
  add column if not exists speaker_low_priority boolean not null default false,
  add constraint transcript_segments_speaker_confidence_check
    check (speaker_confidence is null or (speaker_confidence >= 0 and speaker_confidence <= 1));

create index if not exists transcript_segments_lesson_low_priority_idx
  on public.transcript_segments(lesson_id, speaker_low_priority);
