import Link from "next/link";
import { revalidatePath } from "next/cache";
import {
  isLessonNotificationKind,
  notificationKindLabel,
  type NotificationEventKind,
} from "@reverb/domain/schemas/notifications";
import { Card, EmptyState, SectionHeader } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/get-user";
import { loadNotifications, type NotificationRow } from "@/lib/notifications/load";
import { markNotificationsRead } from "@/app/(app)/lessons/actions";

export const dynamic = "force-dynamic";

async function markAllReadAction() {
  "use server";
  await markNotificationsRead();
  revalidatePath("/notifications");
}

export default async function NotificationsPage() {
  await requireUser();
  const rows = await loadNotifications({ limit: 50 });
  const unread = rows.filter((r) => r.readAt === null);

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight md:text-2xl">Notifications</h1>
          <p className="mt-1 text-sm text-foreground-muted">
            Updates from your lessons and your daily practice.
          </p>
        </div>
        {unread.length > 0 ? (
          <form action={markAllReadAction}>
            <button
              type="submit"
              className="inline-flex h-9 items-center rounded-md border border-border px-3 text-xs font-medium text-foreground-muted transition hover:bg-surface-muted hover:text-foreground"
            >
              Mark all read
            </button>
          </form>
        ) : null}
      </header>

      <section>
        <SectionHeader
          title="Recent"
          description={
            unread.length > 0
              ? `${unread.length} unread`
              : rows.length > 0
                ? "You're all caught up."
                : undefined
          }
        />
        {rows.length === 0 ? (
          <EmptyState
            title="No notifications yet"
            description="Lesson completion and failure alerts will show up here."
          />
        ) : (
          <ul className="space-y-2">
            {rows.map((row) => (
              <li key={row.id}>
                <NotificationItem row={row} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function NotificationItem({ row }: { row: NotificationRow }) {
  const unread = row.readAt === null;
  const isLessonScoped = isLessonNotificationKind(row.kind);
  const body = describeBody(row);

  const inner = (
    <Card className="flex flex-col gap-1.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            <span className={toneFor(row.kind)}>{notificationKindLabel(row.kind)}</span>
            {row.lessonTitle ? (
              <span className="text-foreground-muted"> — {row.lessonTitle}</span>
            ) : null}
          </p>
          {body ? <p className="mt-0.5 text-xs text-foreground-muted">{body}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {unread ? (
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-full bg-accent"
              title="Unread"
            />
          ) : null}
          <p className="text-xs text-foreground-subtle">{formatRelative(row.createdAt)}</p>
        </div>
      </div>
    </Card>
  );

  if (isLessonScoped && row.lessonId) {
    return (
      <Link
        href={{ pathname: "/lessons" }}
        className="block rounded-xl transition hover:bg-surface-muted/40"
      >
        {inner}
      </Link>
    );
  }
  return inner;
}

function describeBody(row: NotificationRow): string | null {
  if (row.kind === "lesson_failed") {
    const summary = row.payload.error_summary;
    if (typeof summary === "string" && summary.length > 0) return summary;
    return "Tap to retry from the Lessons page.";
  }
  if (row.kind === "lesson_ready") {
    return "Cards are ready to practice.";
  }
  return null;
}

const TONE_BY_KIND: Record<NotificationEventKind, string> = {
  lesson_ready: "text-success",
  lesson_failed: "text-danger",
  streak_reminder: "text-foreground",
  session_due: "text-foreground",
  milestone: "text-accent",
};

function toneFor(kind: NotificationEventKind): string {
  return TONE_BY_KIND[kind];
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
