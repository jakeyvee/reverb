import { Card, SectionHeader } from "@/components/ui/card";
import type { HomeMetrics, HomeUserMetrics } from "@/lib/home/metrics";

// Weekly XP race. Each household member gets a horizontal bar scaled to the
// pair's largest total — so being "ahead" is always visually obvious without
// turning into a public ranking.
export function WeeklyXpModule({ metrics }: { metrics: HomeMetrics | null }) {
  const users = metrics?.users ?? [];
  const total = users.reduce((sum, user) => sum + user.weeklyXp, 0);
  const leader = Math.max(0, ...users.map((u) => u.weeklyXp));

  return (
    <Card>
      <SectionHeader
        title="Weekly XP"
        description={describeWeek(users, total)}
      />
      {users.length === 0 ? (
        <Placeholder />
      ) : (
        <ul className="space-y-3">
          {users.map((user) => (
            <li key={user.userId}>
              <UserBar user={user} leader={leader} />
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-foreground-subtle">
        XP from drills, vocab, and lessons — refreshed nightly.
      </p>
    </Card>
  );
}

function UserBar({ user, leader }: { user: HomeUserMetrics; leader: number }) {
  // Show the user's bar at proportional width, clamping the empty state to
  // a faint stub so an "I haven't started" row isn't completely invisible.
  const ratio = leader > 0 ? user.weeklyXp / leader : 0;
  const widthPercent = Math.max(2, Math.round(ratio * 100));

  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium text-foreground">
          {user.isCurrentUser ? "You" : user.displayName}
        </span>
        <span className="text-foreground-subtle">
          {user.weeklyXp} <span className="text-[10px]">XP</span>
        </span>
      </div>
      <div className="mt-1 h-2 w-full rounded-full bg-surface-muted">
        <div
          className={
            user.isCurrentUser
              ? "h-full rounded-full bg-accent"
              : "h-full rounded-full bg-accent/50"
          }
          style={{ width: `${widthPercent}%` }}
          aria-hidden
        />
      </div>
    </div>
  );
}

function Placeholder() {
  return (
    <div className="flex h-24 items-end gap-2">
      {Array.from({ length: 7 }).map((_, i) => (
        <div
          key={i}
          className="w-full flex-1 rounded-md bg-surface-muted"
          style={{ height: "8%" }}
          aria-hidden
        />
      ))}
    </div>
  );
}

function describeWeek(users: ReadonlyArray<HomeUserMetrics>, total: number): string {
  if (users.length === 0) return "0 XP this week";
  return `${total} XP this week`;
}
