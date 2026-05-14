import Link from "next/link";
import { Card, EmptyState } from "@/components/ui/card";
import { DEMO_LESSON } from "@/lib/demo/lesson";

export default function SessionPage() {
  const card = DEMO_LESSON.cards[0];
  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/lessons"
          className="text-xs text-foreground-subtle transition hover:text-foreground"
        >
          ← Lessons
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight md:text-2xl">Session</h1>
        <p className="mt-1 text-sm text-foreground-muted">
          A live session will run here once scheduling is wired up.
        </p>
      </div>

      {card ? (
        <Card className="flex flex-col items-center gap-6 py-10">
          <p className="text-xs uppercase tracking-wider text-foreground-subtle">Demo card · 1 of {DEMO_LESSON.cards.length}</p>
          <p className="text-2xl font-semibold tracking-tight md:text-3xl">{card.front}</p>
          <p className="text-base text-foreground-muted">{card.back}</p>
          {card.pronunciation ? (
            <p className="text-xs text-foreground-subtle">{card.pronunciation}</p>
          ) : null}

          <div className="grid w-full max-w-md grid-cols-4 gap-2">
            {(["Again", "Hard", "Good", "Easy"] as const).map((label) => (
              <button
                key={label}
                type="button"
                disabled
                className="h-10 rounded-md border border-border bg-surface-muted text-xs font-medium text-foreground-muted opacity-60"
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-foreground-subtle">Rating buttons activate when sessions go live.</p>
        </Card>
      ) : (
        <EmptyState
          title="Nothing scheduled"
          description="Upload a lesson to populate your session queue."
        />
      )}
    </div>
  );
}
