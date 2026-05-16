"use client";

import { useState, useTransition, type FormEvent } from "react";
import {
  CORRECTION_DRILL_HIGH_CONFIDENCE,
  CORRECTION_DRILL_MIN_CONFIDENCE,
  type CorrectionDrillResult,
} from "@reverb/domain/schemas/correction-drill";
import { Card } from "@/components/ui/card";
import {
  recordCorrectionDrillAttempt,
  type RecordDrillAttemptResult,
} from "@/lib/session/actions";
import type { CorrectionDrillView } from "@/lib/session/correction-drills";

type Props = {
  drills: CorrectionDrillView[];
};

type Phase =
  | { kind: "prompt" }
  | { kind: "answered"; result: RecordDrillAttemptResult }
  | { kind: "done" };

type Mode = "retype" | "self_mark";

export function MistakeDrillRunner({ drills }: Props) {
  // Snapshot the drill list on mount so a parent re-render (e.g. a future
  // revalidate on a sibling action) can't shift the array under us mid-batch
  // and skip drills. The session action deliberately avoids revalidating
  // /session for the same reason — this is defense-in-depth.
  const [snapshot] = useState(() => drills);
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: "prompt" });
  const [mode, setMode] = useState<Mode>("retype");
  const [value, setValue] = useState("");
  const [shown, setShown] = useState(false);
  const [pending, startTransition] = useTransition();

  if (snapshot.length === 0) {
    return null;
  }
  if (phase.kind === "done" || index >= snapshot.length) {
    return (
      <Card className="flex flex-col items-center gap-2 py-8 text-center">
        <p className="text-sm font-medium text-foreground">All caught up.</p>
        <p className="text-xs text-foreground-muted">
          You completed every correction drill that was due. Come back later for the next batch.
        </p>
      </Card>
    );
  }

  const drill = snapshot[index]!;
  const tier = drill.confidenceTier;
  const correction = drill.correction;

  function reset() {
    setValue("");
    setShown(false);
    setPhase({ kind: "prompt" });
  }

  function advance() {
    if (index + 1 >= snapshot.length) {
      setPhase({ kind: "done" });
      return;
    }
    setIndex((i) => i + 1);
    reset();
  }

  function submitRetype(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    startTransition(async () => {
      const result = await recordCorrectionDrillAttempt({
        drillId: drill.drillId,
        mode: "retype",
        userResponse: value,
      });
      setPhase({ kind: "answered", result });
    });
  }

  function submitSelfMark(self: CorrectionDrillResult) {
    if (pending) return;
    startTransition(async () => {
      const result = await recordCorrectionDrillAttempt({
        drillId: drill.drillId,
        mode: "self_mark",
        selfMarked: self,
      });
      setPhase({ kind: "answered", result });
    });
  }

  return (
    <Card className="flex flex-col gap-5 py-8">
      <div className="flex items-center justify-between text-xs text-foreground-subtle">
        <span className="uppercase tracking-wider">
          Mistake drill · {index + 1} of {snapshot.length}
        </span>
        {tier === "uncertain" ? (
          <span
            className="rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-700 dark:text-amber-300"
            title={`Model confidence ${(correction.confidence ?? 0).toFixed(2)}. Drills with confidence below ${CORRECTION_DRILL_MIN_CONFIDENCE.toFixed(2)} are hidden; ${CORRECTION_DRILL_MIN_CONFIDENCE.toFixed(2)}–${CORRECTION_DRILL_HIGH_CONFIDENCE.toFixed(2)} are labelled uncertain.`}
          >
            Uncertain
          </span>
        ) : null}
      </div>

      <div className="space-y-2">
        <p className="text-xs uppercase tracking-wider text-foreground-subtle">You said</p>
        <p className="text-lg font-medium text-danger line-through decoration-danger/60 decoration-2">
          {correction.sourceText}
        </p>
      </div>

      {shown ? (
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wider text-foreground-subtle">Teacher said</p>
          <p className="text-lg font-semibold text-emerald-600 dark:text-emerald-300">
            {correction.correctedText}
          </p>
          {correction.explanation ? (
            <p className="text-xs text-foreground-muted">{correction.explanation}</p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2 text-[11px]">
        <button
          type="button"
          onClick={() => setMode("retype")}
          className={`rounded-full border px-3 py-1 transition ${
            mode === "retype"
              ? "border-foreground bg-foreground text-background"
              : "border-border text-foreground-muted hover:text-foreground"
          }`}
        >
          Retype
        </button>
        <button
          type="button"
          onClick={() => setMode("self_mark")}
          className={`rounded-full border px-3 py-1 transition ${
            mode === "self_mark"
              ? "border-foreground bg-foreground text-background"
              : "border-border text-foreground-muted hover:text-foreground"
          }`}
        >
          Self-mark
        </button>
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          className="ml-auto text-foreground-subtle hover:text-foreground"
        >
          {shown ? "Hide correction" : "Show correction"}
        </button>
      </div>

      {phase.kind === "prompt" ? (
        mode === "retype" ? (
          <form onSubmit={submitRetype} className="flex flex-col gap-3">
            <label htmlFor="retype-input" className="text-xs text-foreground-muted">
              Type the corrected form exactly as the teacher said it.
            </label>
            <input
              id="retype-input"
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              className="rounded-md border border-border bg-surface-muted px-3 py-2 text-sm text-foreground outline-none focus:border-foreground"
              disabled={pending}
            />
            <button
              type="submit"
              disabled={pending || value.trim().length === 0}
              className="self-start rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition disabled:opacity-40"
            >
              Submit
            </button>
          </form>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-foreground-muted">
              Read the correction aloud and mark yourself.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => submitSelfMark("fail")}
                disabled={pending}
                className="rounded-md border border-danger/40 px-3 py-2 text-sm font-medium text-danger transition hover:bg-danger/10 disabled:opacity-40"
              >
                Missed it
              </button>
              <button
                type="button"
                onClick={() => submitSelfMark("pass")}
                disabled={pending}
                className="rounded-md border border-emerald-500/40 px-3 py-2 text-sm font-medium text-emerald-700 transition hover:bg-emerald-500/10 disabled:opacity-40 dark:text-emerald-300"
              >
                Nailed it
              </button>
            </div>
          </div>
        )
      ) : (
        <AnswerFeedback result={phase.result} onContinue={advance} />
      )}
    </Card>
  );
}

function AnswerFeedback({
  result,
  onContinue,
}: {
  result: RecordDrillAttemptResult;
  onContinue: () => void;
}) {
  if (!result.ok) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-danger">{result.error}</p>
        <button
          type="button"
          onClick={onContinue}
          className="rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground"
        >
          Skip
        </button>
      </div>
    );
  }
  const pass = result.result === "pass";
  return (
    <div className="space-y-3">
      <p
        className={`text-sm font-medium ${
          pass ? "text-emerald-700 dark:text-emerald-300" : "text-danger"
        }`}
      >
        {pass ? `Correct. +${result.xpAwarded} XP.` : "Not quite. We'll show this again soon."}
      </p>
      {result.retired ? (
        <p className="text-xs text-foreground-muted">Retired — three passes in a row.</p>
      ) : (
        <p className="text-xs text-foreground-subtle">
          Next due {formatDate(result.nextDueAt)}
        </p>
      )}
      <button
        type="button"
        onClick={onContinue}
        className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition"
      >
        Continue
      </button>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  const diffMins = Math.round(diffMs / 60_000);
  if (diffMins < 60) return `in ${Math.max(diffMins, 1)} min`;
  const diffHours = Math.round(diffMs / 3_600_000);
  if (diffHours < 24) return `in ${diffHours} h`;
  const diffDays = Math.round(diffMs / 86_400_000);
  return `in ${diffDays} day${diffDays === 1 ? "" : "s"}`;
}
