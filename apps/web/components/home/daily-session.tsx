import Link from "next/link";
import { Card } from "@/components/ui/card";
import { PlayIcon } from "@/components/ui/icons";

export function DailySessionModule() {
  return (
    <Card className="flex flex-col gap-4 md:col-span-2">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wider text-foreground-subtle">Today</p>
          <h2 className="mt-1 text-lg font-semibold tracking-tight">Your daily session</h2>
          <p className="mt-1 text-sm text-foreground-muted">
            New cards and reviews will appear here once you upload a lesson.
          </p>
        </div>
        <span className="rounded-full border border-border-strong px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-foreground-subtle">
          Coming soon
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <Stat label="New" value="—" />
        <Stat label="Due" value="—" />
        <Stat label="Mins" value="—" />
      </div>

      <Link
        href="/session"
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-accent-foreground transition hover:opacity-90"
      >
        <PlayIcon width={16} height={16} />
        Start a demo session
      </Link>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-muted/40 p-3">
      <p className="text-[11px] uppercase tracking-wider text-foreground-subtle">{label}</p>
      <p className="mt-1 text-base font-semibold text-foreground">{value}</p>
    </div>
  );
}
