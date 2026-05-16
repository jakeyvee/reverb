import { Card, SectionHeader } from "@/components/ui/card";
import { FlameIcon } from "@/components/ui/icons";
import type { HomeMetrics, HomeUserMetrics } from "@/lib/home/metrics";

export function CoupleStreaksModule({ metrics }: { metrics: HomeMetrics | null }) {
  const users = metrics?.users ?? [];
  const currentUser = users.find((u) => u.isCurrentUser) ?? users[0] ?? null;
  const partner = users.find((u) => !u.isCurrentUser) ?? null;

  return (
    <Card>
      <SectionHeader title="Couple streaks" description={describe(currentUser, partner)} />
      <div className="grid grid-cols-2 gap-2">
        <StreakBlock
          label={currentUser ? `${currentUser.displayName}` : "You"}
          days={currentUser?.currentStreak ?? 0}
          practicedToday={currentUser?.practicedToday ?? false}
          isCurrentUser
        />
        <StreakBlock
          label={partner?.displayName ?? "Partner"}
          days={partner?.currentStreak ?? 0}
          practicedToday={partner?.practicedToday ?? false}
          isCurrentUser={false}
        />
      </div>
      {!partner ? (
        <p className="mt-3 text-xs text-foreground-subtle">
          Invite a partner from your profile to start a shared streak.
        </p>
      ) : null}
    </Card>
  );
}

function describe(
  currentUser: HomeUserMetrics | null,
  partner: HomeUserMetrics | null,
): string {
  if (!currentUser) return "You + your partner, in sync";
  if (!partner) return `Solo for now — ${currentUser.currentStreak}d streak`;
  if (currentUser.practicedToday && partner.practicedToday) {
    return "Both done for today";
  }
  if (currentUser.practicedToday) {
    return `${partner.displayName} hasn't practised today`;
  }
  if (partner.practicedToday) {
    return `${partner.displayName} is ahead of you today`;
  }
  return "Nobody has practised today yet";
}

function StreakBlock({
  label,
  days,
  practicedToday,
  isCurrentUser,
}: {
  label: string;
  days: number;
  practicedToday: boolean;
  isCurrentUser: boolean;
}) {
  // Lit flame only when today's box is checked. A cold streak still shows
  // the digit so the user can see what they're at risk of losing.
  const flameClass = practicedToday
    ? "bg-accent/15 text-accent"
    : "bg-surface text-foreground-muted";
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-surface-muted/40 px-3 py-2.5">
      <span className={`grid h-9 w-9 place-items-center rounded-full ${flameClass}`}>
        <FlameIcon width={18} height={18} />
      </span>
      <div className="min-w-0">
        <p className="truncate text-xs text-foreground-subtle">
          {isCurrentUser ? "You" : label}
        </p>
        <p className="text-sm font-semibold">
          {days} <span className="text-xs font-normal text-foreground-subtle">days</span>
        </p>
      </div>
    </div>
  );
}
