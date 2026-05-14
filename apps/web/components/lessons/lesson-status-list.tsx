import { isActiveLessonStatus, lessonStatusHint } from "@reverb/domain/schemas/lesson-status";
import { Card } from "@/components/ui/card";
import type { LessonStatusRow } from "@/lib/lessons/status";
import { LessonStatusBadge } from "./lesson-status-badge";
import { RetryButton } from "./retry-button";

type Props = {
  rows: LessonStatusRow[];
  // When true, render the inline hint and retry affordance. Compact mode is
  // used on the Home dashboard where space is tighter.
  showDetail?: boolean;
};

export function LessonStatusList({ rows, showDetail = true }: Props) {
  if (rows.length === 0) return null;

  return (
    <ul className="space-y-2">
      {rows.map((row) => (
        <li key={row.id}>
          <LessonStatusItem row={row} showDetail={showDetail} />
        </li>
      ))}
    </ul>
  );
}

function LessonStatusItem({ row, showDetail }: { row: LessonStatusRow; showDetail: boolean }) {
  const { processingStatus: status } = row;
  const isFailed = status === "failed";
  const hint = lessonStatusHint(status);
  const inFlight = isActiveLessonStatus(status);

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{row.title}</p>
          <p className="mt-0.5 text-xs text-foreground-subtle">
            {formatRelative(row.createdAt)}
            {row.durationMs ? ` · ${formatDuration(row.durationMs)}` : ""}
            {row.attemptCount > 0 && inFlight ? ` · attempt ${row.attemptCount + 1}` : ""}
          </p>
        </div>
        <LessonStatusBadge status={status} />
      </div>

      {showDetail && isFailed ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-muted/40 p-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-medium text-danger">Processing failed</p>
            <p className="mt-1 text-xs text-foreground-muted">
              {row.errorSummary ?? "We couldn't finish this lesson. Please try again."}
            </p>
          </div>
          <RetryButton lessonId={row.id} />
        </div>
      ) : null}

      {showDetail && hint && !isFailed ? (
        <p className="text-xs text-foreground-subtle">{hint}</p>
      ) : null}
    </Card>
  );
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatRelative(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "";
  const diffMs = Date.now() - ts;
  if (diffMs < 60_000) return "just now";
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}
