import Link from "next/link";
import { Card } from "@/components/ui/card";
import { PlayIcon } from "@/components/ui/icons";
import { getUser } from "@/lib/auth/get-user";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { loadDailySessionSummary, type DailySessionSummary } from "@/lib/session/home-summary";

// Server component — fetches a lightweight snapshot of the user's active
// session (or what the orchestrator would assemble if they tap "Start") so
// the home tile shows real counts instead of placeholder dashes. The
// underlying loader is read-only; the orchestrator's insert path only
// fires when the user navigates to /session.
export async function DailySessionModule() {
  const user = await getUser();
  const summary = user ? await loadSummary(user.id) : null;

  const status = summary?.status ?? "no-session";
  const newCount = summary?.newCount ?? 0;
  const dueCount = summary?.dueCount ?? 0;
  const estimateMinutes = summary?.estimateMinutes ?? null;

  return (
    <Card className="flex flex-col gap-4 md:col-span-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs uppercase tracking-wider text-foreground-subtle">Today</p>
          <h2 className="mt-1 text-lg font-semibold tracking-tight">Your daily session</h2>
          <p className="mt-1 text-sm text-foreground-muted">
            {describeStatus(status, newCount + dueCount)}
          </p>
        </div>
        <StatusPill status={status} />
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <Stat label="New" value={formatCount(newCount)} />
        <Stat label="Due" value={formatCount(dueCount)} />
        <Stat label="Mins" value={estimateMinutes !== null ? String(estimateMinutes) : "—"} />
      </div>

      <Link
        href="/session"
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-accent-foreground transition hover:opacity-90"
      >
        <PlayIcon width={16} height={16} />
        {status === "active" ? "Resume today's session" : "Start today's session"}
      </Link>
    </Card>
  );
}

async function loadSummary(userId: string): Promise<DailySessionSummary | null> {
  const supabase = await createServerSupabaseClient();
  if (!supabase) return null;
  try {
    return await loadDailySessionSummary(supabase, userId);
  } catch {
    // Surfaceable read failure: degrade to the "no session" state rather
    // than crashing the home page.
    return null;
  }
}

function describeStatus(status: DailySessionSummary["status"], total: number): string {
  if (status === "active") {
    return total > 0
      ? "Pick up where you left off."
      : "All items answered — finish your session to claim XP.";
  }
  if (status === "completed") {
    return "You finished today's session. Come back tomorrow.";
  }
  if (total === 0) {
    return "Upload a lesson — vocab cards and correction drills appear here automatically.";
  }
  return "A mixed queue of mistake drills + vocab reviews, ready when you are.";
}

function formatCount(value: number): string {
  return value === 0 ? "—" : String(value);
}

function StatusPill({ status }: { status: DailySessionSummary["status"] }) {
  const label =
    status === "active" ? "In progress" : status === "completed" ? "Completed" : "Ready";
  const tone =
    status === "active"
      ? "border-accent/60 bg-accent/10 text-accent"
      : status === "completed"
        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
        : "border-border-strong text-foreground-subtle";
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${tone}`}
    >
      {label}
    </span>
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
