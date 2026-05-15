import { Card, EmptyState } from "@/components/ui/card";
import type { TranscriptSegmentRow } from "@/lib/lessons/transcript";
import { formatSpeaker, formatTimestamp } from "@/lib/lessons/transcript-format";
import { type LessonProcessingStatus } from "@reverb/domain/schemas/lesson-status";

type Props = {
  segments: TranscriptSegmentRow[];
  // Status drives the empty/error state copy when there are no segments yet —
  // a `failed` lesson reads differently from one that's still transcribing.
  status: LessonProcessingStatus | null;
};

export function TranscriptView({ segments, status }: Props) {
  if (segments.length === 0) {
    return <TranscriptEmptyState status={status} />;
  }

  const speakers = uniqueSpeakers(segments);
  const showSpeakers = speakers.size > 1 || hasAnySpeakerLabel(segments);

  return (
    <div className="space-y-4">
      {showSpeakers ? <SpeakerLegend segments={segments} /> : null}
      <Card className="space-y-3 sm:space-y-4">
        <ol className="space-y-3 sm:space-y-4">
          {segments.map((segment) => (
            <li key={segment.id}>
              <TranscriptSegment segment={segment} showSpeaker={showSpeakers} />
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}

function TranscriptSegment({
  segment,
  showSpeaker,
}: {
  segment: TranscriptSegmentRow;
  showSpeaker: boolean;
}) {
  const speaker = formatSpeaker(segment.speaker);
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:gap-3">
      <div className="flex shrink-0 items-center gap-2 sm:w-32 sm:flex-col sm:items-start sm:gap-1">
        <span className="font-mono text-[11px] tabular-nums text-foreground-subtle">
          {formatTimestamp(segment.startMs)}
        </span>
        {showSpeaker ? (
          <span
            className={`inline-flex max-w-[10rem] truncate rounded-full border px-2 py-0.5 text-[10px] font-medium ${speaker.tone}`}
            title={speaker.display}
          >
            {speaker.display}
          </span>
        ) : null}
      </div>
      <p className="min-w-0 text-sm leading-relaxed text-foreground">{segment.text}</p>
    </div>
  );
}

function SpeakerLegend({ segments }: { segments: TranscriptSegmentRow[] }) {
  const seen = new Map<string, ReturnType<typeof formatSpeaker>>();
  for (const seg of segments) {
    const view = formatSpeaker(seg.speaker);
    if (!seen.has(view.key)) seen.set(view.key, view);
  }
  if (seen.size === 0) return null;
  return (
    <div className="flex flex-wrap gap-2" aria-label="Speakers in this transcript">
      {Array.from(seen.values()).map((view) => (
        <span
          key={view.key}
          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${view.tone}`}
        >
          {view.display}
        </span>
      ))}
    </div>
  );
}

function TranscriptEmptyState({ status }: { status: LessonProcessingStatus | null }) {
  if (status === "failed") {
    return (
      <EmptyState
        title="Transcript unavailable"
        description="This lesson didn't finish processing, so we don't have a transcript to show yet."
      />
    );
  }
  if (
    status === "queued" ||
    status === "transcribing" ||
    status === "diarizing" ||
    status === "extracting" ||
    status === "generating_audio"
  ) {
    return (
      <EmptyState
        title="Transcript not ready yet"
        description="We'll show timestamped segments here as soon as transcription finishes."
      />
    );
  }
  if (status === "ready") {
    return (
      <EmptyState
        title="No transcript segments"
        description="This lesson finished processing but no transcript segments were stored."
      />
    );
  }
  return (
    <EmptyState
      title="No transcript yet"
      description="Upload the lesson audio to generate a transcript."
    />
  );
}

function uniqueSpeakers(segments: TranscriptSegmentRow[]): Set<string> {
  const set = new Set<string>();
  for (const seg of segments) {
    set.add(formatSpeaker(seg.speaker).key);
  }
  return set;
}

function hasAnySpeakerLabel(segments: TranscriptSegmentRow[]): boolean {
  return segments.some((s) => Boolean(s.speaker && s.speaker.trim().length > 0));
}
