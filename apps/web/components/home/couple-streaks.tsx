import { Card, SectionHeader } from "@/components/ui/card";
import { FlameIcon } from "@/components/ui/icons";

export function CoupleStreaksModule() {
  return (
    <Card>
      <SectionHeader title="Couple streaks" description="You + your partner, in sync" />
      <div className="grid grid-cols-2 gap-2">
        <StreakBlock label="You" days={0} />
        <StreakBlock label="Partner" days={0} />
      </div>
      <p className="mt-3 text-xs text-foreground-subtle">
        Invite a partner from your profile to start a shared streak.
      </p>
    </Card>
  );
}

function StreakBlock({ label, days }: { label: string; days: number }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-surface-muted/40 px-3 py-2.5">
      <span className="grid h-9 w-9 place-items-center rounded-full bg-surface text-foreground-muted">
        <FlameIcon width={18} height={18} />
      </span>
      <div className="min-w-0">
        <p className="truncate text-xs text-foreground-subtle">{label}</p>
        <p className="text-sm font-semibold">
          {days} <span className="text-xs font-normal text-foreground-subtle">days</span>
        </p>
      </div>
    </div>
  );
}
