import Link from "next/link";
import { Card, EmptyState, SectionHeader } from "@/components/ui/card";
import { DEMO_LESSON } from "@/lib/demo/lesson";
import { UploadIcon, PlayIcon } from "@/components/ui/icons";
import { requireUser } from "@/lib/auth/get-user";
import { LessonArchiveList } from "@/components/lessons/lesson-archive-list";
import { loadLessonStatusRows } from "@/lib/lessons/status";

export const dynamic = "force-dynamic";

// Archive surface: every household lesson, ordered newest first, with
// extracted-content counts and a link to the detail view. We intentionally
// fetch without a status filter so a recent failure can't push older
// successful lessons out of the window.
const ARCHIVE_PAGE_SIZE = 50;

export default async function LessonsPage() {
  const user = await requireUser();
  const canUpload = user.isVincent;
  const rows = await loadLessonStatusRows({ limit: ARCHIVE_PAGE_SIZE });

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight md:text-2xl">Lessons</h1>
          <p className="mt-1 text-sm text-foreground-muted">
            Cards generated from your uploads will live here.
          </p>
        </div>
        {canUpload ? (
          <Link
            href="/upload"
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-foreground-muted transition hover:bg-surface-muted hover:text-foreground"
          >
            <UploadIcon width={14} height={14} />
            Upload
          </Link>
        ) : null}
      </header>

      <section>
        <SectionHeader
          title="Demo lesson"
          description="Try a sample to see how a Reverb session feels."
        />
        <Card className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wider text-foreground-subtle">
              {DEMO_LESSON.language} · {DEMO_LESSON.level}
            </p>
            <h3 className="mt-1 truncate text-base font-semibold">{DEMO_LESSON.title}</h3>
            <p className="mt-1 text-sm text-foreground-muted">{DEMO_LESSON.description}</p>
            <p className="mt-2 text-xs text-foreground-subtle">{DEMO_LESSON.cards.length} cards</p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Link
              href={{ pathname: `/lessons/${DEMO_LESSON.id}` }}
              className="inline-flex h-9 items-center rounded-md border border-border px-3 text-xs font-medium text-foreground-muted transition hover:bg-surface-muted hover:text-foreground"
            >
              View
            </Link>
            <Link
              href="/session"
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground transition hover:opacity-90"
            >
              <PlayIcon width={14} height={14} />
              Start
            </Link>
          </div>
        </Card>
      </section>

      <section>
        <SectionHeader
          title="Your lessons"
          description={summariseArchive(rows.length)}
        />
        {rows.length > 0 ? (
          <LessonArchiveList rows={rows} canRetry={canUpload} />
        ) : (
          <EmptyState
            title="No lessons yet"
            description={
              canUpload
                ? "Upload audio, a screenshot, or paste a transcript to generate your first deck. The demo above is always available for practice."
                : "Vincent hasn't uploaded a lesson yet. Try the demo lesson above while you wait — new decks will appear here as soon as they're ready."
            }
            action={
              canUpload ? (
                <Link
                  href="/upload"
                  className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground transition hover:opacity-90"
                >
                  <UploadIcon width={14} height={14} />
                  Upload your first lesson
                </Link>
              ) : undefined
            }
          />
        )}
      </section>
    </div>
  );
}

function summariseArchive(count: number): string | undefined {
  if (count === 0) return undefined;
  if (count === 1) return "1 lesson in the household archive.";
  return `${count} lessons in the household archive, newest first.`;
}
