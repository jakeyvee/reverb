import { Card, EmptyState, SectionHeader } from "@/components/ui/card";
import { createServerSupabaseClient } from "@/lib/supabase/server";

type LessonRow = {
  id: string;
  title: string;
  status: "draft" | "uploading" | "processing" | "ready" | "failed" | "archived";
  duration_ms: number | null;
  created_at: string;
};

export async function RecentUploads() {
  const supabase = await createServerSupabaseClient();
  if (!supabase) {
    return (
      <section>
        <SectionHeader title="Recent uploads" />
        <EmptyState
          title="Storage isn't configured"
          description="Set NEXT_PUBLIC_SUPABASE_URL and the anon key to start uploading lessons."
        />
      </section>
    );
  }

  const { data, error } = await supabase
    .from("lessons")
    .select("id, title, status, duration_ms, created_at")
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) {
    return (
      <section>
        <SectionHeader title="Recent uploads" />
        <EmptyState
          title="Couldn't load uploads"
          description="The list will appear once we can reach the database again."
        />
      </section>
    );
  }

  const rows = (data ?? []) as LessonRow[];

  if (rows.length === 0) {
    return (
      <section>
        <SectionHeader title="Recent uploads" />
        <EmptyState
          title="No uploads yet"
          description="Once you upload a file you'll see its processing status here."
        />
      </section>
    );
  }

  return (
    <section>
      <SectionHeader title="Recent uploads" />
      <ul className="space-y-2">
        {rows.map((lesson) => (
          <li key={lesson.id}>
            <Card className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{lesson.title}</p>
                <p className="mt-0.5 text-xs text-foreground-subtle">
                  {formatRelative(lesson.created_at)}
                  {lesson.duration_ms ? ` · ${formatDuration(lesson.duration_ms)}` : ""}
                </p>
              </div>
              <StatusBadge status={lesson.status} />
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}

function StatusBadge({ status }: { status: LessonRow["status"] }) {
  const map: Record<LessonRow["status"], { label: string; className: string }> = {
    draft: { label: "Draft", className: "text-foreground-subtle" },
    uploading: { label: "Uploading", className: "text-foreground-muted" },
    processing: { label: "Processing", className: "text-warning" },
    ready: { label: "Ready", className: "text-success" },
    failed: { label: "Failed", className: "text-danger" },
    archived: { label: "Archived", className: "text-foreground-subtle" },
  };
  const tone = map[status];
  return (
    <span
      className={`inline-flex h-7 shrink-0 items-center rounded-full border border-border px-2.5 text-[11px] font-medium ${tone.className}`}
    >
      {tone.label}
    </span>
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
