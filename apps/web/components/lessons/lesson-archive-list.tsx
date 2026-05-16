import Link from "next/link";
import { isActiveLessonStatus, lessonStatusHint } from "@reverb/domain/schemas/lesson-status";
import { Card } from "@/components/ui/card";
import type { LessonStatusRow } from "@/lib/lessons/status";
import type { LessonMastery } from "@/lib/lessons/mastery";
import { LessonMasteryPanel } from "./lesson-mastery";
import { LessonStatusBadge } from "./lesson-status-badge";
import { RetryButton } from "./retry-button";

type Props = {
  rows: LessonStatusRow[];
  // Only Vincent (the upload account) can re-enqueue processing. The partner
  // still sees the failure card so it doesn't silently disappear, but the
  // retry button is hidden for them.
  canRetry?: boolean;
  // VOL-134: per-lesson mastery for the signed-in user. The map is sparse —
  // lessons missing from it render without a mastery row (e.g. in-flight
  // lessons whose content hasn't been extracted yet).
  masteryByLesson?: Map<string, LessonMastery>;
};

// Archive variant of the lesson list. Unlike the home dashboard's status list,
// every row is a link to the lesson detail page, surfaces extracted-content
// counts, and is meant to coexist with successful older lessons even when a
// recent upload fails — we never filter rows out here.
export function LessonArchiveList({ rows, canRetry = false, masteryByLesson }: Props) {
  if (rows.length === 0) return null;

  return (
    <ul className="space-y-2">
      {rows.map((row) => (
        <li key={row.id}>
          <ArchiveRow
            row={row}
            canRetry={canRetry}
            mastery={masteryByLesson?.get(row.id) ?? null}
          />
        </li>
      ))}
    </ul>
  );
}

function ArchiveRow({
  row,
  canRetry,
  mastery,
}: {
  row: LessonStatusRow;
  canRetry: boolean;
  mastery: LessonMastery | null;
}) {
  const { processingStatus: status } = row;
  const isFailed = status === "failed";
  const inFlight = isActiveLessonStatus(status);
  const hint = lessonStatusHint(status);
  const href = `/lessons/${row.id}`;
  // Mastery is only meaningful once extraction has produced content. We
  // also skip it on rows with no extracted content of any type so we don't
  // render three "—" chips for an empty lesson.
  const showMastery =
    !inFlight &&
    mastery !== null &&
    (mastery.vocab.total > 0 || mastery.grammar.total > 0 || mastery.corrections.total > 0);

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <Link
            href={href}
            className="block truncate text-sm font-medium text-foreground transition hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {row.title}
          </Link>
          <p className="mt-0.5 text-xs text-foreground-subtle">
            {formatDate(row.createdAt)}
            {row.durationMs ? ` · ${formatDuration(row.durationMs)}` : ""}
            {row.attemptCount > 0 && inFlight ? ` · attempt ${row.attemptCount + 1}` : ""}
            {row.attemptCount > 1 && isFailed ? ` · ${row.attemptCount} attempts` : ""}
          </p>
        </div>
        <LessonStatusBadge status={status} />
      </div>

      <CountRow row={row} />

      {showMastery && mastery ? (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-border pt-2 text-xs">
          <span className="text-foreground-subtle">Mastery</span>
          <LessonMasteryPanel mastery={mastery} variant="row" />
        </div>
      ) : null}

      {isFailed ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-muted/40 p-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-medium text-danger">Processing failed</p>
            <p className="mt-1 text-xs text-foreground-muted">
              {row.errorSummary ?? "We couldn't finish this lesson. Please try again."}
            </p>
          </div>
          {canRetry ? <RetryButton lessonId={row.id} /> : null}
        </div>
      ) : null}

      {hint && inFlight && !isFailed ? (
        <p className="text-xs text-foreground-subtle">{hint}</p>
      ) : null}
    </Card>
  );
}

// Pre-aggregated counts of extracted content for the lesson. We render `—` for
// in-flight rows because those numbers can still change as extraction runs;
// zero on a terminal row is a real outcome ("no vocab found") and is shown.
function CountRow({ row }: { row: LessonStatusRow }) {
  const inFlight = isActiveLessonStatus(row.processingStatus);
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-foreground-muted">
      <CountChip label="Vocab" value={row.vocabCount} pending={inFlight} />
      <CountChip label="Corrections" value={row.correctionCount} pending={inFlight} />
      <CountChip label="Grammar" value={row.grammarPatternCount} pending={inFlight} />
    </dl>
  );
}

function CountChip({ label, value, pending }: { label: string; value: number; pending: boolean }) {
  return (
    <div className="flex items-baseline gap-1">
      <dt className="text-foreground-subtle">{label}</dt>
      <dd className="font-medium text-foreground">{pending ? "—" : value}</dd>
    </div>
  );
}

function formatDate(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "";
  const date = new Date(ts);
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
