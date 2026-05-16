import type { LessonMastery, MasteryStat } from "@/lib/lessons/mastery";

type Variant = "detail" | "row";

type Props = {
  mastery: LessonMastery;
  variant?: Variant;
};

// VOL-134: Renders the three mastery percentages for a lesson. Used on the
// lesson detail page (variant="detail", larger cards) and the archive list
// (variant="row", inline chips). When a content type wasn't extracted for
// a given lesson we render "—" rather than 0% / 100% so the user can tell
// the difference between "nothing to master" and "haven't mastered anything".
export function LessonMasteryPanel({ mastery, variant = "detail" }: Props) {
  if (variant === "row") {
    return (
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-foreground-muted">
        <MasteryChip label="Vocab" stat={mastery.vocab} />
        <MasteryChip label="Grammar" stat={mastery.grammar} />
        <MasteryChip label="Corrections" stat={mastery.corrections} />
      </dl>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <MasteryCard label="Vocab" description="FSRS interval ≥ 21 days" stat={mastery.vocab} />
      <MasteryCard
        label="Grammar"
        description="Exercises passed first try"
        stat={mastery.grammar}
      />
      <MasteryCard
        label="Mistakes"
        description="Correction drills retired"
        stat={mastery.corrections}
      />
    </div>
  );
}

function MasteryCard({
  label,
  description,
  stat,
}: {
  label: string;
  description: string;
  stat: MasteryStat;
}) {
  const isEmpty = stat.percent === null;
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <p className="text-xs uppercase tracking-wider text-foreground-subtle">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
        {isEmpty ? "—" : `${stat.percent}%`}
      </p>
      <p className="mt-1 text-xs text-foreground-muted">
        {isEmpty ? "No content extracted" : `${stat.mastered} of ${stat.total} mastered`}
      </p>
      <p className="mt-2 text-[11px] text-foreground-subtle">{description}</p>
    </div>
  );
}

function MasteryChip({ label, stat }: { label: string; stat: MasteryStat }) {
  return (
    <div className="flex items-baseline gap-1">
      <dt className="text-foreground-subtle">{label}</dt>
      <dd className="font-medium text-foreground">
        {stat.percent === null ? "—" : `${stat.percent}%`}
      </dd>
    </div>
  );
}
