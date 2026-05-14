import { Card, SectionHeader } from "@/components/ui/card";

const DAYS = ["M", "T", "W", "T", "F", "S", "S"];

export function WeeklyXpModule() {
  return (
    <Card>
      <SectionHeader title="Weekly XP" description="0 XP this week" />
      <div className="flex h-24 items-end gap-2">
        {DAYS.map((day, i) => (
          <div key={`${day}-${i}`} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
            <div
              className="w-full rounded-md bg-surface-muted"
              style={{ height: "8%" }}
              aria-hidden
            />
            <span className="text-[10px] text-foreground-subtle">{day}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-foreground-subtle">
        Bars will fill as you earn XP from sessions.
      </p>
    </Card>
  );
}
