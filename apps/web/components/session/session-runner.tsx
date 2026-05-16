"use client";

import { useCallback, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { completeSessionAction, type CompleteSessionActionResult } from "@/lib/session/actions";
import type { DailySessionView, SessionItem } from "@/lib/session/orchestrator";
import { SessionVocabCard } from "@/components/session/vocab-card";
import { SessionDrillCard } from "@/components/session/drill-card";
import { SessionShadowingCard } from "@/components/session/shadowing-card";
import { SessionListeningCard } from "@/components/session/listening-card";

// Orchestrates today's mixed session. The hydrated view is fetched on the
// server and persisted in `practice_session_items`, so the order on the
// screen matches the order in the database; a refresh or device hand-off
// resumes from the next unanswered item without re-asking the user
// questions they already finished.

type Props = {
  view: DailySessionView;
};

type SessionState = {
  // Live counter snapshot. Seeded from the server view, then updated as
  // each item completes (per-action response). Avoids a refetch between
  // answers so the runner stays snappy.
  xpEarned: number;
  cardsReviewed: number;
  exercisesAttempted: number;
  // Indices into `items` that the user has finished this mount. Combined
  // with `view.items[i].completed` to decide which item is current.
  answeredHere: Set<string>;
};

export function SessionRunner({ view }: Props) {
  // Snapshot the items on mount. A revalidate from a sibling action (e.g.
  // an "I already know this" override) would otherwise shift the queue
  // under us — the orchestrator persists order in the DB, so this snapshot
  // remains the source of truth for the current mount.
  const [items] = useState(() => view.items);
  const [state, setState] = useState<SessionState>(() => ({
    xpEarned: view.xpEarned,
    cardsReviewed: view.cardsReviewed,
    exercisesAttempted: view.exercisesAttempted,
    answeredHere: new Set(),
  }));
  // Ref mirror of `state.answeredHere` so the `advance` callback can see
  // an id that was just added by a setState updater in the same batch.
  // Without this, `onSkipped` → `onAdvance` fires both queue updates in
  // one event tick, and React calls advance's setActiveIndex updater
  // before the answeredHere closure has propagated — the runner would
  // wrap and re-select the just-skipped item.
  const answeredHereRef = useRef<Set<string>>(state.answeredHere);
  const [activeIndex, setActiveIndex] = useState(() => firstUnansweredIndex(items));
  const [completion, setCompletion] = useState<CompleteSessionActionResult | null>(null);
  const [pendingComplete, startCompleteTransition] = useTransition();
  const router = useRouter();

  const totalCount = items.length;
  const completedCount = useMemo(
    () =>
      items.reduce(
        (acc, item) => acc + (item.completed || state.answeredHere.has(item.sessionItemId) ? 1 : 0),
        0,
      ),
    [items, state.answeredHere],
  );

  const allDone = totalCount > 0 && completedCount >= totalCount;

  const onAnswered = useCallback(
    (
      sessionItemId: string,
      snapshot?: {
        sessionXpEarned: number;
        cardsReviewed: number;
        exercisesAttempted: number;
      },
    ) => {
      setState((prev) => {
        if (prev.answeredHere.has(sessionItemId)) return prev;
        const next = new Set(prev.answeredHere);
        next.add(sessionItemId);
        // Mirror into the ref inside the updater so `advance` (which may
        // run in the same React batch) sees the new id even before the
        // committed state propagates through closures.
        answeredHereRef.current = next;
        return {
          xpEarned: snapshot?.sessionXpEarned ?? prev.xpEarned,
          cardsReviewed: snapshot?.cardsReviewed ?? prev.cardsReviewed,
          exercisesAttempted: snapshot?.exercisesAttempted ?? prev.exercisesAttempted,
          answeredHere: next,
        };
      });
    },
    [],
  );

  const advance = useCallback(() => {
    setActiveIndex((current) => {
      // Find the next item that hasn't been answered. We can't rely on
      // current+1 because the user may skip with the override controls
      // ("I already know this"), which doesn't go through the standard
      // answer feedback flow. Reading the ref means we pick up an id that
      // was just added by `onAnswered` in the same event tick.
      const completedIds = new Set<string>();
      for (const item of items) {
        if (item.completed) completedIds.add(item.sessionItemId);
      }
      for (const id of answeredHereRef.current) completedIds.add(id);

      for (let i = current + 1; i < items.length; i += 1) {
        if (!completedIds.has(items[i]!.sessionItemId)) return i;
      }
      // Wrap to find any earlier item that's still open (e.g. user just
      // marked the last card "known" — there's still an earlier unfinished
      // drill they came back to).
      for (let i = 0; i < items.length; i += 1) {
        if (!completedIds.has(items[i]!.sessionItemId)) return i;
      }
      return items.length; // sentinel: past the end → "all done"
    });
  }, [items]);

  const finish = useCallback(() => {
    if (pendingComplete) return;
    startCompleteTransition(async () => {
      const result = await completeSessionAction({ sessionId: view.sessionId });
      setCompletion(result);
      // Refresh the route so the home page (DailySessionModule, streaks)
      // picks up the new state next time the user navigates there.
      if (result.ok) router.refresh();
    });
  }, [pendingComplete, router, view.sessionId]);

  if (totalCount === 0) {
    return (
      <Card className="flex flex-col items-center gap-2 py-8 text-center">
        <p className="text-sm font-medium text-foreground">Nothing due right now.</p>
        <p className="text-xs text-foreground-muted">
          Upload a lesson — vocab cards and correction drills appear here automatically.
        </p>
      </Card>
    );
  }

  if (completion?.ok) {
    return <CompletionSummary result={completion} />;
  }

  if (allDone) {
    return (
      <Card className="flex flex-col items-center gap-3 py-8 text-center">
        <p className="text-sm font-medium text-foreground">All items answered.</p>
        <p className="text-xs text-foreground-muted">
          {state.xpEarned} XP earned · {state.cardsReviewed} cards · {state.exercisesAttempted}{" "}
          drills.
        </p>
        <button
          type="button"
          onClick={finish}
          disabled={pendingComplete}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition disabled:opacity-40"
        >
          {pendingComplete ? "Finishing..." : "Finish session"}
        </button>
        {completion && !completion.ok ? (
          <p className="text-xs text-danger">{completion.error}</p>
        ) : null}
      </Card>
    );
  }

  const current = items[activeIndex];
  if (!current) {
    // Out-of-range; the answeredHere set says we still have work. Walk
    // back to the first open item and let the user retry.
    return (
      <Card className="flex flex-col items-center gap-2 py-8 text-center">
        <p className="text-sm font-medium text-foreground">No active item.</p>
        <button
          type="button"
          onClick={() => setActiveIndex(firstUnansweredIndex(items, state.answeredHere))}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition"
        >
          Resume
        </button>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <SessionProgress
        positionLabel={`${completedCount + 1} of ${totalCount}`}
        xpEarned={state.xpEarned}
        cardsReviewed={state.cardsReviewed}
        exercisesAttempted={state.exercisesAttempted}
      />
      <SessionItemView
        item={current}
        positionLabel={`${activeIndex + 1} of ${totalCount}`}
        onAnswered={onAnswered}
        onAdvance={advance}
      />
    </div>
  );
}

function SessionItemView({
  item,
  positionLabel,
  onAnswered,
  onAdvance,
}: {
  item: SessionItem;
  positionLabel: string;
  onAnswered: (
    sessionItemId: string,
    snapshot?: { sessionXpEarned: number; cardsReviewed: number; exercisesAttempted: number },
  ) => void;
  onAdvance: () => void;
}) {
  if (item.kind === "card") {
    return (
      <SessionVocabCard
        key={item.sessionItemId}
        card={item.card}
        sessionItemId={item.sessionItemId}
        positionLabel={positionLabel}
        onAnswered={({ result }) => {
          if (result.ok && result.session) {
            onAnswered(item.sessionItemId, {
              sessionXpEarned: result.session.sessionXpEarned,
              cardsReviewed: result.session.cardsReviewed,
              exercisesAttempted: result.session.exercisesAttempted,
            });
          } else if (result.ok) {
            // Action succeeded but session wasn't linked — mark answered
            // without bumping local counters so progress still advances.
            onAnswered(item.sessionItemId);
          }
        }}
        // "I already know this" routes through the server action so the
        // session-item row is marked answered too; we mirror the resulting
        // snapshot into the runner's local state so the queue advances
        // immediately and the finish flow accepts the completion.
        onSkipped={(snapshot) =>
          onAnswered(snapshot.sessionItemId, {
            sessionXpEarned: snapshot.sessionXpEarned,
            cardsReviewed: snapshot.cardsReviewed,
            exercisesAttempted: snapshot.exercisesAttempted,
          })
        }
        onAdvance={onAdvance}
      />
    );
  }
  if (item.kind === "listening_comprehension") {
    return (
      <SessionListeningCard
        key={item.sessionItemId}
        listening={item.listening}
        sessionItemId={item.sessionItemId}
        positionLabel={positionLabel}
        onAnswered={(result) => {
          if (result.ok && result.session) {
            onAnswered(item.sessionItemId, {
              sessionXpEarned: result.session.sessionXpEarned,
              cardsReviewed: result.session.cardsReviewed,
              exercisesAttempted: result.session.exercisesAttempted,
            });
          } else if (result.ok) {
            onAnswered(item.sessionItemId);
          }
        }}
        onAdvance={onAdvance}
      />
    );
  }
  if (item.kind === "shadowing") {
    return (
      <SessionShadowingCard
        key={item.sessionItemId}
        clip={item.clip}
        sessionItemId={item.sessionItemId}
        positionLabel={positionLabel}
        onAnswered={(result) => {
          if (result.ok) {
            onAnswered(item.sessionItemId, {
              sessionXpEarned: result.session.sessionXpEarned,
              cardsReviewed: result.session.cardsReviewed,
              exercisesAttempted: result.session.exercisesAttempted,
            });
          }
        }}
        onAdvance={onAdvance}
      />
    );
  }
  return (
    <SessionDrillCard
      key={item.sessionItemId}
      drill={item.drill}
      sessionItemId={item.sessionItemId}
      positionLabel={positionLabel}
      onAnswered={(result) => {
        if (result.ok && result.session) {
          onAnswered(item.sessionItemId, {
            sessionXpEarned: result.session.sessionXpEarned,
            cardsReviewed: result.session.cardsReviewed,
            exercisesAttempted: result.session.exercisesAttempted,
          });
        } else if (result.ok) {
          onAnswered(item.sessionItemId);
        }
      }}
      onAdvance={onAdvance}
    />
  );
}

function SessionProgress({
  positionLabel,
  xpEarned,
  cardsReviewed,
  exercisesAttempted,
}: {
  positionLabel: string;
  xpEarned: number;
  cardsReviewed: number;
  exercisesAttempted: number;
}) {
  return (
    <div className="grid grid-cols-4 gap-2 text-center">
      <Stat label="Item" value={positionLabel} />
      <Stat label="XP" value={String(xpEarned)} />
      <Stat label="Cards" value={String(cardsReviewed)} />
      <Stat label="Drills" value={String(exercisesAttempted)} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-muted/40 p-3">
      <p className="text-[11px] uppercase tracking-wider text-foreground-subtle">{label}</p>
      <p className="mt-1 text-sm font-semibold text-foreground">{value}</p>
    </div>
  );
}

function CompletionSummary({
  result,
}: {
  result: Extract<CompleteSessionActionResult, { ok: true }>;
}) {
  const summary = result.summary;
  return (
    <Card className="flex flex-col items-center gap-3 py-10 text-center">
      <p className="text-xs uppercase tracking-wider text-foreground-subtle">Session complete</p>
      <p className="text-3xl font-semibold text-foreground">+{summary.xpEarned} XP</p>
      <p className="text-xs text-foreground-muted">
        {summary.cardsReviewed} cards · {summary.exercisesAttempted} drills ·{" "}
        {formatDuration(summary.durationMs)}
      </p>
      <div className="flex items-center gap-2 rounded-full border border-amber-400/40 bg-amber-400/10 px-3 py-1 text-xs text-amber-700 dark:text-amber-300">
        <span aria-hidden>🔥</span>
        <span>
          {summary.streak.currentLength}-day streak
          {summary.streak.bumped ? " · +1 today" : ""}
        </span>
      </div>
      <p className="text-[11px] text-foreground-subtle">
        Longest streak: {summary.streak.longestLength} day
        {summary.streak.longestLength === 1 ? "" : "s"}.
      </p>
      {result.partnerNudge ? (
        <p className="mt-2 max-w-xs rounded-lg border border-border bg-surface-muted/40 px-3 py-2 text-xs text-foreground-muted">
          {result.partnerNudge}
        </p>
      ) : null}
    </Card>
  );
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "0m";
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

function firstUnansweredIndex(items: ReadonlyArray<SessionItem>, here?: Set<string>): number {
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    if (item.completed) continue;
    if (here?.has(item.sessionItemId)) continue;
    return i;
  }
  return items.length; // all answered
}
