import Link from "next/link";
import { Card, SectionHeader } from "@/components/ui/card";
import { LessonStatusList } from "@/components/lessons/lesson-status-list";
import { loadLessonStatusRows, isActiveRow } from "@/lib/lessons/status";

// Surfaces lessons that are still working their way through the pipeline or
// have failed, so the household can see what's happening without leaving the
// home screen — and without blocking daily practice (the section quietly
// hides when there's nothing to report).
export async function LessonsInProgressModule() {
  const rows = await loadLessonStatusRows({
    limit: 5,
    statuses: ["queued", "transcribing", "diarizing", "extracting", "generating_audio", "failed"],
  });

  if (rows.length === 0) return null;

  const activeCount = rows.filter(isActiveRow).length;
  const failedCount = rows.length - activeCount;

  return (
    <Card className="flex flex-col gap-3 md:col-span-2">
      <SectionHeader
        title="Lesson processing"
        description={describe(activeCount, failedCount)}
        action={
          <Link
            href="/lessons"
            className="text-xs font-medium text-foreground-muted transition hover:text-foreground"
          >
            View all
          </Link>
        }
      />
      <LessonStatusList rows={rows} />
    </Card>
  );
}

function describe(activeCount: number, failedCount: number): string {
  if (activeCount > 0 && failedCount > 0) {
    return `${activeCount} in progress · ${failedCount} need${failedCount === 1 ? "s" : ""} a retry`;
  }
  if (failedCount > 0) {
    return `${failedCount} lesson${failedCount === 1 ? "" : "s"} need${failedCount === 1 ? "s" : ""} a retry`;
  }
  return `${activeCount} in progress`;
}
