import { Card, SectionHeader } from "@/components/ui/card";
import { HEATMAP_DAYS, type HomeMetrics, type HomeUserMetrics } from "@/lib/home/metrics";

const DAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"];

// 7-day heatmap covering both household members. Each row is a user; each
// column is a day in their local timezone. Filled squares mean they
// answered at least one item that day.
export function HeatmapModule({ metrics }: { metrics: HomeMetrics | null }) {
  const users = metrics?.users ?? [];

  return (
    <Card>
      <SectionHeader title="Activity" description={`Last ${HEATMAP_DAYS} days`} />
      {users.length === 0 ? (
        <Placeholder />
      ) : (
        <div className="space-y-3">
          <DayHeader windowEnd={metrics?.windowEnd ?? null} />
          {users.map((user) => (
            <UserRow key={user.userId} user={user} />
          ))}
        </div>
      )}
      <p className="mt-3 text-xs text-foreground-subtle">
        Each square is a day. Filled means at least one practice item answered.
      </p>
    </Card>
  );
}

function UserRow({ user }: { user: HomeUserMetrics }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-12 shrink-0 truncate text-xs text-foreground-subtle sm:w-16">
        {user.isCurrentUser ? "You" : user.displayName}
      </span>
      <div
        role="img"
        aria-label={describeRow(user)}
        className="grid flex-1 gap-1"
        style={{ gridTemplateColumns: `repeat(${HEATMAP_DAYS}, minmax(0, 1fr))` }}
      >
        {user.heatmap.map((practiced, i) => (
          <span
            key={i}
            className={
              practiced
                ? "aspect-square rounded-[3px] bg-accent/70"
                : "aspect-square rounded-[3px] bg-surface-muted"
            }
          />
        ))}
      </div>
    </div>
  );
}

function DayHeader({ windowEnd }: { windowEnd: string | null }) {
  // Match column count for alignment. Letters are seeded from today's
  // weekday so the rightmost cell always reads correctly.
  const todayIndex = windowEnd ? dayOfWeekIndex(windowEnd) : new Date().getUTCDay();
  return (
    <div className="flex items-center gap-3">
      <span className="w-12 shrink-0 sm:w-16" aria-hidden />
      <div
        className="grid flex-1 gap-1"
        style={{ gridTemplateColumns: `repeat(${HEATMAP_DAYS}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: HEATMAP_DAYS }).map((_, i) => {
          const offset = HEATMAP_DAYS - 1 - i;
          const dayIndex = (todayIndex - offset + 7 * 7) % 7;
          return (
            <span
              key={i}
              className="text-center text-[10px] text-foreground-subtle"
              aria-hidden
            >
              {DAY_INITIALS[dayIndex]}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function Placeholder() {
  return (
    <div
      role="img"
      aria-label="No activity yet"
      className="grid gap-1"
      style={{ gridTemplateColumns: `repeat(${HEATMAP_DAYS}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: HEATMAP_DAYS * 2 }).map((_, i) => (
        <span key={i} className="aspect-square rounded-[3px] bg-surface-muted opacity-40" />
      ))}
    </div>
  );
}

function describeRow(user: HomeUserMetrics): string {
  const days = user.heatmap.filter(Boolean).length;
  return `${user.isCurrentUser ? "Your" : `${user.displayName}'s`} activity: ${days} of ${HEATMAP_DAYS} days`;
}

function dayOfWeekIndex(yyyyMmDd: string): number {
  // Parse a YYYY-MM-DD as a date in UTC midnight, then read getUTCDay().
  // Avoids timezone drift from the user's runtime.
  const parts = yyyyMmDd.split("-").map(Number);
  const [y, m, d] = [parts[0] ?? 1970, parts[1] ?? 1, parts[2] ?? 1];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
