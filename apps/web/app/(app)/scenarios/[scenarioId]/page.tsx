import Link from "next/link";
import { notFound } from "next/navigation";
import { ChatLevelSchema, ScenarioIdSchema, getScenarioDefinition } from "@reverb/domain";
import { EmptyState } from "@/components/ui/card";
import { ScenarioRunner } from "@/components/scenarios/scenario-runner";
import { requireUser } from "@/lib/auth/get-user";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  getOrCreateActiveScenarioSession,
  getScenarioSession,
  loadScenarioMessages,
} from "@/lib/scenarios/sessions";

export const dynamic = "force-dynamic";

type Params = { scenarioId: string };

export default async function ScenarioRunnerPage({ params }: { params: Promise<Params> }) {
  const { scenarioId } = await params;
  const parsed = ScenarioIdSchema.safeParse(scenarioId);
  if (!parsed.success) notFound();
  const definition = getScenarioDefinition(parsed.data);

  const user = await requireUser();
  const supabase = await createServerSupabaseClient();
  if (!supabase) {
    return (
      <PageShell title={definition.title}>
        <EmptyState
          title="Supabase not configured"
          description="Set NEXT_PUBLIC_SUPABASE_URL and the matching keys to start a scenario."
        />
      </PageShell>
    );
  }

  // Resume an active scene if one exists, otherwise open a fresh row. We
  // intentionally do NOT auto-reopen completed or abandoned scenes — the
  // user has to come back through the picker to start again, which keeps
  // each XP claim tied to a real practice.
  const level = ChatLevelSchema.parse("beginner");
  const session = await getOrCreateActiveScenarioSession(supabase, user.id, parsed.data, level);
  const fresh = await getScenarioSession(supabase, session.id, user.id);
  const messages = await loadScenarioMessages(supabase, session.id, user.id);

  const status = normaliseStatus(fresh?.status ?? "active");

  return (
    <PageShell title={definition.title}>
      <ScenarioRunner
        sessionId={session.id}
        scenario={definition}
        initialMessages={messages}
        initialStatus={status}
        initialXp={fresh?.xp_earned ?? 0}
        initialUserTurns={fresh?.total_user_messages ?? 0}
      />
    </PageShell>
  );
}

function PageShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/scenarios"
          className="text-xs text-foreground-subtle transition hover:text-foreground"
        >
          ← Scenarios
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight md:text-2xl">{title}</h1>
      </div>
      {children}
    </div>
  );
}

function normaliseStatus(value: string): "active" | "completed" | "abandoned" {
  if (value === "completed" || value === "abandoned") return value;
  return "active";
}
