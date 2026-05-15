import {
  isLessonNotificationKind,
  type NotificationEventKind,
} from "@reverb/domain/schemas/notifications";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export type NotificationRow = {
  id: string;
  kind: NotificationEventKind;
  lessonId: string | null;
  lessonTitle: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  readAt: string | null;
};

type RawLessonRef = { title: string } | { title: string }[] | null;

type RawNotificationRow = {
  id: string;
  kind: NotificationEventKind;
  lesson_id: string | null;
  payload: unknown;
  created_at: string;
  read_at: string | null;
  lessons: RawLessonRef;
};

function pickLessonTitle(value: RawLessonRef): string | null {
  if (!value) return null;
  if (Array.isArray(value)) return value[0]?.title ?? null;
  return value.title ?? null;
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

const DEFAULT_LIMIT = 25;

// Fetches in-app notifications for the signed-in user, joined to the lesson
// title so the inbox page doesn't need a second query per row. Returns an
// empty list when Supabase isn't configured (parity with loadLessonStatusRows).
export async function loadNotifications(opts: { limit?: number } = {}): Promise<NotificationRow[]> {
  const supabase = await createServerSupabaseClient();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("notification_events")
    .select("id, kind, lesson_id, payload, created_at, read_at, lessons(title)")
    .eq("channel", "in_app")
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? DEFAULT_LIMIT);

  if (error || !data) return [];

  return (data as RawNotificationRow[]).map((row) => ({
    id: row.id,
    kind: row.kind,
    lessonId: row.lesson_id,
    lessonTitle: pickLessonTitle(row.lessons),
    payload: asObject(row.payload),
    createdAt: row.created_at,
    readAt: row.read_at,
  }));
}

// Lightweight count for the app shell badge. Counts only lesson-scoped kinds
// so future system notifications can opt in explicitly.
export async function countUnreadNotifications(): Promise<number> {
  const supabase = await createServerSupabaseClient();
  if (!supabase) return 0;

  const { count, error } = await supabase
    .from("notification_events")
    .select("id", { count: "exact", head: true })
    .is("read_at", null)
    .eq("channel", "in_app");

  if (error || count === null) return 0;
  return count;
}

export function isLessonNotification(row: NotificationRow): boolean {
  return isLessonNotificationKind(row.kind);
}
