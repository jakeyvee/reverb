"use client";

import Link from "next/link";
import { useTransition } from "react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { SCENARIO_COMPLETION_XP, type ScenarioDefinition, type ScenarioId } from "@reverb/domain";
import { Card } from "@/components/ui/card";
import { SparkleIcon } from "@/components/ui/icons";
import { startScenarioAction } from "@/lib/scenarios/actions";

export type ScenarioCardSummary = {
  id: ScenarioId;
  title: string;
  shortDescription: string;
  goals: readonly string[];
  // Most-recent session status for this scenario; null if the user has never
  // tried it. Drives the small pill on each card.
  lastStatus: "completed" | "active" | "abandoned" | null;
  totalCompleted: number;
};

type Props = {
  scenarios: readonly ScenarioCardSummary[];
};

// Top-level scenario list. Each card kicks off the role-play via a server
// action so we know the active session id before navigating — that way the
// runner page can mount in the loading state instead of starting empty.
export function ScenarioPicker({ scenarios }: Props) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {scenarios.map((scenario) => (
        <ScenarioCard key={scenario.id} scenario={scenario} />
      ))}
    </div>
  );
}

function ScenarioCard({ scenario }: { scenario: ScenarioCardSummary }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function startScenario() {
    if (pending) return;
    startTransition(async () => {
      const result = await startScenarioAction({ scenarioId: scenario.id });
      if (!result.ok) {
        // Surface a minimal error inline. The picker is the entry point, so
        // a noisy error UI would block the user from trying anything else.
        router.push(`/scenarios?error=${encodeURIComponent(result.error)}` as Route);
        return;
      }
      router.push(`/scenarios/${result.scenarioId}` as Route);
    });
  }

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold tracking-tight text-foreground">
            {scenario.title}
          </h2>
          <p className="mt-1 text-sm text-foreground-muted">{scenario.shortDescription}</p>
        </div>
        <StatusPill status={scenario.lastStatus} completedCount={scenario.totalCompleted} />
      </div>

      <ul className="space-y-1 text-xs text-foreground-subtle">
        {scenario.goals.slice(0, 3).map((goal, idx) => (
          <li key={idx} className="flex gap-2">
            <span className="text-foreground-subtle">•</span>
            <span>{goal}</span>
          </li>
        ))}
      </ul>

      <div className="mt-1 flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wider text-foreground-subtle">
          <SparkleIcon width={12} height={12} aria-hidden /> {SCENARIO_COMPLETION_XP} XP on
          completion
        </span>
        <button
          type="button"
          onClick={startScenario}
          disabled={pending}
          className="rounded-md bg-accent px-4 py-1.5 text-xs font-medium text-accent-foreground transition disabled:opacity-40"
        >
          {pending
            ? "Starting…"
            : scenario.lastStatus === "active"
              ? "Resume scene"
              : "Start scene"}
        </button>
      </div>
    </Card>
  );
}

function StatusPill({
  status,
  completedCount,
}: {
  status: ScenarioCardSummary["lastStatus"];
  completedCount: number;
}) {
  if (status === "active") {
    return (
      <span className="shrink-0 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-accent">
        In progress
      </span>
    );
  }
  if (completedCount > 0) {
    return (
      <span className="shrink-0 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
        Done × {completedCount}
      </span>
    );
  }
  return (
    <span className="shrink-0 rounded-full border border-border-strong px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-foreground-subtle">
      New
    </span>
  );
}

// Static summary card rendered on the picker page when the user is not
// signed in or Supabase is unavailable — keeps the marketing-ish shape
// without the personalised pills. Caller passes the raw definition.
export function StaticScenarioCard({ scenario }: { scenario: ScenarioDefinition }) {
  return (
    <Card className="flex flex-col gap-3 opacity-90">
      <h2 className="text-base font-semibold tracking-tight text-foreground">{scenario.title}</h2>
      <p className="text-sm text-foreground-muted">{scenario.shortDescription}</p>
      <ul className="space-y-1 text-xs text-foreground-subtle">
        {scenario.goals.slice(0, 3).map((goal, idx) => (
          <li key={idx} className="flex gap-2">
            <span className="text-foreground-subtle">•</span>
            <span>{goal}</span>
          </li>
        ))}
      </ul>
      <Link
        href="/sign-in"
        className="self-start text-xs text-foreground-subtle underline decoration-dotted underline-offset-2 hover:text-foreground"
      >
        Sign in to practise
      </Link>
    </Card>
  );
}
