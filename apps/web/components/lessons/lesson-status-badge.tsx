import {
  isActiveLessonStatus,
  lessonStageProgress,
  lessonStatusLabel,
  type LessonProcessingStatus,
} from "@reverb/domain/schemas/lesson-status";

const TONE_BY_STATUS: Record<LessonProcessingStatus, string> = {
  queued: "border-border text-foreground-muted",
  transcribing: "border-border-strong text-warning",
  diarizing: "border-border-strong text-warning",
  extracting: "border-border-strong text-warning",
  generating_audio: "border-border-strong text-warning",
  ready: "border-border-strong text-success",
  failed: "border-border-strong text-danger",
};

export function LessonStatusBadge({ status }: { status: LessonProcessingStatus }) {
  const tone = TONE_BY_STATUS[status];
  const showSpinner = isActiveLessonStatus(status) && status !== "queued";
  const progress = lessonStageProgress(status);

  return (
    <span
      className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium ${tone}`}
      aria-live="polite"
      aria-label={
        progress
          ? `${lessonStatusLabel(status)} — step ${progress.step} of ${progress.total}`
          : lessonStatusLabel(status)
      }
    >
      {showSpinner ? <Spinner /> : null}
      <span>{lessonStatusLabel(status)}</span>
      {progress && status !== "ready" && status !== "queued" ? (
        <span className="text-foreground-subtle">
          {progress.step}/{progress.total}
        </span>
      ) : null}
    </span>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-2.5 w-2.5 animate-spin rounded-full border border-current border-t-transparent"
    />
  );
}
