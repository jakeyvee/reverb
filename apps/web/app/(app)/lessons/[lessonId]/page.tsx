import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, SectionHeader } from "@/components/ui/card";
import { DEMO_LESSON, DEMO_LESSON_ID } from "@/lib/demo/lesson";
import { PlayIcon } from "@/components/ui/icons";
import { requireUser } from "@/lib/auth/get-user";
import { loadLessonTranscript, type LessonTranscriptView } from "@/lib/lessons/transcript";
import { LessonStatusBadge } from "@/components/lessons/lesson-status-badge";
import { LessonAudioPlayer } from "@/components/lessons/lesson-audio-player";
import { LessonMasteryPanel } from "@/components/lessons/lesson-mastery";
import { TranscriptView } from "@/components/lessons/transcript-view";
import { RetryButton } from "@/components/lessons/retry-button";
import { ReprocessButton } from "@/components/lessons/reprocess-button";
import { isMasteryEmpty, loadLessonMastery } from "@/lib/lessons/mastery";
import {
  isActiveLessonStatus,
  isTerminalLessonStatus,
  lessonStatusHint,
} from "@reverb/domain/schemas/lesson-status";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ lessonId: string }>;
};

export default async function LessonDetailPage({ params }: Props) {
  const { lessonId } = await params;
  if (lessonId === DEMO_LESSON_ID) {
    return <DemoLessonView />;
  }

  // Real lessons require auth + RLS scoping. Demo lesson is intentionally
  // public-within-the-app so the marketing copy on /lessons still works
  // before any real upload has happened.
  const user = await requireUser();
  const [result, mastery] = await Promise.all([
    loadLessonTranscript(lessonId),
    loadLessonMastery(lessonId, user.id),
  ]);
  if (!result.ok) notFound();

  const { view } = result;
  const status = view.job?.status ?? null;
  const isFailed = status === "failed";
  const inFlight = status ? isActiveLessonStatus(status) : false;
  const hint = status ? lessonStatusHint(status) : null;
  // Only Vincent (the upload account) drives reprocessing today, and the
  // worker won't accept a re-enqueue while a run is still in flight — gate
  // the button on the terminal-status condition so partners + transient
  // states don't see a misleading affordance.
  // Demo seed lessons (VOL-124) are inert fixtures — they never went through
  // the worker pipeline, so retry / reprocess affordances would dead-end.
  const isDemo = view.lesson.isDemo;
  const canReprocess =
    user.isVincent && !isDemo && status !== null && isTerminalLessonStatus(status);
  const hasReprocessHistory = view.extraction.hasHistory;
  const currentVersion = view.extraction.currentVersion;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/lessons"
          className="text-xs text-foreground-subtle transition hover:text-foreground"
        >
          ← Lessons
        </Link>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight md:text-2xl">
              {view.lesson.title}
            </h1>
            {view.lesson.description ? (
              <p className="mt-1 text-sm text-foreground-muted">{view.lesson.description}</p>
            ) : null}
            <p className="mt-2 text-xs text-foreground-subtle">{formatMeta(view)}</p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {isDemo ? (
              <span
                className="rounded-md border border-accent/40 bg-accent/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-accent"
                title="Pre-seeded demo lesson — not produced by the upload pipeline."
              >
                Demo
              </span>
            ) : null}
            {status ? <LessonStatusBadge status={status} /> : null}
            {hasReprocessHistory || currentVersion > 1 ? (
              <span
                className="rounded-md border border-border bg-surface-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-foreground-muted"
                title="This lesson has been re-extracted. Cards and correction-drill progress are preserved across versions."
              >
                Extraction v{currentVersion}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {isFailed ? (
        <Card className="flex flex-col gap-2 border-danger/40 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-medium text-danger">Processing failed</p>
            <p className="mt-1 text-xs text-foreground-muted">
              {view.job?.errorSummary ??
                "We couldn't finish this lesson. Retry to send it back through the pipeline."}
            </p>
          </div>
          <RetryButton lessonId={view.lesson.id} />
        </Card>
      ) : null}

      {hint && inFlight && !isFailed ? (
        <p className="text-xs text-foreground-subtle">{hint}</p>
      ) : null}

      {canReprocess ? (
        <Card className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">Re-run extraction</p>
            <p className="mt-1 text-xs text-foreground-muted">
              Pulls vocab, grammar, and corrections again with the latest prompt. Existing review
              progress is preserved where the word or correction identity still matches.
            </p>
          </div>
          <ReprocessButton lessonId={view.lesson.id} disabled={inFlight} />
        </Card>
      ) : null}

      {mastery && !isMasteryEmpty(mastery) ? (
        <section>
          <SectionHeader
            title="Your mastery"
            description="Calculated from your practice state — no manual entry."
          />
          <LessonMasteryPanel mastery={mastery} />
        </section>
      ) : null}

      {view.audio ? (
        <section>
          <SectionHeader
            title="Lesson audio"
            description="Spot-check the source recording while you read the transcript."
          />
          <Card>
            <LessonAudioPlayer signedUrl={view.audio.signedUrl} mimeType={view.audio.mimeType} />
          </Card>
        </section>
      ) : null}

      <section>
        <SectionHeader
          title="Transcript"
          description="Raw ASR output. Toggle translation or click any word to look it up."
        />
        <TranscriptView
          segments={view.segments}
          status={status}
          targetLanguage={view.lesson.targetLanguage ?? view.lesson.sourceLanguage}
        />
      </section>
    </div>
  );
}

function formatMeta(view: LessonTranscriptView): string {
  const parts: string[] = [];
  if (view.lesson.targetLanguage) parts.push(view.lesson.targetLanguage);
  else if (view.lesson.sourceLanguage) parts.push(view.lesson.sourceLanguage);
  if (view.lesson.durationMs) parts.push(formatDuration(view.lesson.durationMs));
  parts.push(`${view.segments.length} segment${view.segments.length === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function DemoLessonView() {
  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/lessons"
          className="text-xs text-foreground-subtle transition hover:text-foreground"
        >
          ← Lessons
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight md:text-2xl">
          {DEMO_LESSON.title}
        </h1>
        <p className="mt-1 text-sm text-foreground-muted">{DEMO_LESSON.description}</p>
        <p className="mt-2 text-xs text-foreground-subtle">
          {DEMO_LESSON.language} · {DEMO_LESSON.level} · {DEMO_LESSON.cards.length} cards
        </p>
      </div>

      <Link
        href="/session"
        className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-accent-foreground transition hover:opacity-90"
      >
        <PlayIcon width={16} height={16} />
        Start session
      </Link>

      <section>
        <SectionHeader title="Cards" />
        <ul className="space-y-2">
          {DEMO_LESSON.cards.map((card, i) => (
            <li key={i}>
              <Card className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-wider text-foreground-subtle">
                    Card {i + 1}
                  </p>
                  <p className="mt-0.5 truncate text-sm font-medium">{card.front}</p>
                </div>
                <div className="text-sm text-foreground-muted sm:text-right">
                  <p className="truncate">{card.back}</p>
                  {card.pronunciation ? (
                    <p className="mt-0.5 text-xs text-foreground-subtle">{card.pronunciation}</p>
                  ) : null}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
