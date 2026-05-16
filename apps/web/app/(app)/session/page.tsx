import Link from "next/link";
import { EmptyState } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/get-user";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { startOrResumeTodaysSession } from "@/lib/session/orchestrator";
import { SessionRunner } from "@/components/session/session-runner";

export const dynamic = "force-dynamic";

export default async function SessionPage() {
  const user = await requireUser();
  const supabase = await createServerSupabaseClient();
  if (!supabase) {
    return (
      <PageShell>
        <EmptyState
          title="Supabase not configured"
          description="Set NEXT_PUBLIC_SUPABASE_URL and the matching keys to load your session."
        />
      </PageShell>
    );
  }

  // Single entry point: either today's active session is loaded with its
  // persisted item order, or a new session is created and seeded. Either
  // way the SessionRunner sees the same shape and the queue is stable
  // across refreshes/devices.
  const view = await startOrResumeTodaysSession(supabase, user.id);

  return (
    <PageShell>
      {view.unresolvedItems > 0 ? (
        <p className="text-xs text-foreground-subtle">
          {view.unresolvedItems} {view.unresolvedItems === 1 ? "item is" : "items are"} unavailable
          (the source row was removed since this session started).
        </p>
      ) : null}
      <SessionRunner view={view} />
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <div>
        <Link href="/" className="text-xs text-foreground-subtle transition hover:text-foreground">
          ← Home
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight md:text-2xl">Session</h1>
        <p className="mt-1 text-sm text-foreground-muted">
          Today&apos;s mixed queue — mistake drills come up first, then vocab reviews.
        </p>
      </div>
      {children}
    </div>
  );
}
