import Link from "next/link";
import { SCENARIO_DEFINITIONS } from "@reverb/domain";
import { EmptyState } from "@/components/ui/card";
import {
  ScenarioPicker,
  StaticScenarioCard,
  type ScenarioCardSummary,
} from "@/components/scenarios/scenario-picker";
import { requireUser } from "@/lib/auth/get-user";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Travel scenario picker. Server component so the personalised per-card
// pills (active, completed × N) reflect the user's actual session history
// without a client round-trip on mount.
export default async function ScenariosPage() {
  const user = await requireUser();
  const supabase = await createServerSupabaseClient();

  if (!supabase) {
    return (
      <PageShell>
        <EmptyState
          title="Supabase not configured"
          description="Set NEXT_PUBLIC_SUPABASE_URL and the matching keys to start a scenario."
        />
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          {SCENARIO_DEFINITIONS.map((scenario) => (
            <StaticScenarioCard key={scenario.id} scenario={scenario} />
          ))}
        </div>
      </PageShell>
    );
  }

  const summaries = await loadScenarioSummaries(supabase, user.id);

  return (
    <PageShell>
      <ScenarioPicker scenarios={summaries} />
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
        <h1 className="mt-2 text-xl font-semibold tracking-tight md:text-2xl">Travel scenarios</h1>
        <p className="mt-1 text-sm text-foreground-muted">
          Pick a scene to role-play with the AI partner. The partner stays in character in Bahasa
          Indonesia and corrects mistakes inline.
        </p>
      </div>
      {children}
    </div>
  );
}

// Joins the static scenario catalogue with the user's history so each card
// can show "in progress" or "done × N". One query reads recent rows per
// scenario id (ordered desc) — we collapse the result client-side because
// the catalogue is fixed-size (8) and the per-user history is small.
async function loadScenarioSummaries(
  supabase: NonNullable<Awaited<ReturnType<typeof createServerSupabaseClient>>>,
  userId: string,
): Promise<ScenarioCardSummary[]> {
  const { data, error } = await supabase
    .from("scenario_sessions")
    .select("scenario_id, status, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  type Aggregate = { lastStatus: ScenarioCardSummary["lastStatus"]; totalCompleted: number };
  const aggregates = new Map<string, Aggregate>();
  if (!error && data) {
    for (const row of data) {
      const current = aggregates.get(row.scenario_id) ?? {
        lastStatus: null,
        totalCompleted: 0,
      };
      // First (most recent) row sets lastStatus; subsequent rows only update
      // the completed count.
      if (current.lastStatus === null) {
        if (row.status === "active" || row.status === "completed" || row.status === "abandoned") {
          current.lastStatus = row.status;
        }
      }
      if (row.status === "completed") current.totalCompleted += 1;
      aggregates.set(row.scenario_id, current);
    }
  }

  return SCENARIO_DEFINITIONS.map((scenario) => {
    const aggregate = aggregates.get(scenario.id);
    return {
      id: scenario.id,
      title: scenario.title,
      shortDescription: scenario.shortDescription,
      goals: scenario.goals,
      lastStatus: aggregate?.lastStatus ?? null,
      totalCompleted: aggregate?.totalCompleted ?? 0,
    };
  });
}
