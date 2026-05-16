"use client";

import { useEffect, useState, useTransition, type FormEvent } from "react";
import { GRAMMAR_FILL_BLANK_PLACEHOLDER } from "@reverb/domain/schemas/grammar-exercise";
import { Card } from "@/components/ui/card";
import {
  recordGrammarExerciseAttempt,
  type RecordGrammarExerciseResult,
} from "@/lib/session/actions";
import type { SessionGrammarExercise } from "@/lib/session/grammar-exercises";

// Single grammar exercise runner. Dispatches on `exercise.kind` to the
// matching input control:
//
//   - fill_blank      → text input below the prompt (placeholder rendered
//                       inline so the user sees where the answer goes).
//   - multiple_choice → radio-style button list; submitting the chosen one
//                       skips the explicit "Submit" button.
//   - transform       → multi-line text input (full sentence rewrites).
//
// The server action grades the answer authoritatively; the component only
// uses local state to advance the runner UI between prompt → answered.

type Props = {
  exercise: SessionGrammarExercise;
  sessionItemId?: string;
  positionLabel: string;
  onAnswered: (result: RecordGrammarExerciseResult) => void;
  onAdvance: () => void;
};

type Phase = { kind: "prompt" } | { kind: "answered"; result: RecordGrammarExerciseResult };

export function SessionGrammarCard({
  exercise,
  sessionItemId,
  positionLabel,
  onAnswered,
  onAdvance,
}: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: "prompt" });
  const [value, setValue] = useState("");
  const [pending, startTransition] = useTransition();

  // Reset when the active exercise changes (the parent rerenders with a
  // new exercise prop). Keeps the input field empty between exercises.
  useEffect(() => {
    setPhase({ kind: "prompt" });
    setValue("");
  }, [exercise.exerciseId]);

  function submit(answer: string) {
    if (pending) return;
    const trimmed = answer.trim();
    if (trimmed.length === 0) return;
    startTransition(async () => {
      const result = await recordGrammarExerciseAttempt({
        exerciseId: exercise.exerciseId,
        userResponse: trimmed,
        sessionItemId,
      });
      setPhase({ kind: "answered", result });
      onAnswered(result);
    });
  }

  function submitForm(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    submit(value);
  }

  return (
    <Card className="flex flex-col gap-5 py-8">
      <div className="flex items-center justify-between text-xs text-foreground-subtle">
        <span className="uppercase tracking-wider">
          Grammar · {kindLabel(exercise.kind)} · {positionLabel}
        </span>
        {exercise.pattern ? (
          <span className="rounded-full border border-border bg-surface-muted/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-foreground-muted">
            {exercise.pattern}
          </span>
        ) : null}
      </div>

      <PromptBody exercise={exercise} />

      {phase.kind === "prompt" ? (
        <ExerciseInput
          exercise={exercise}
          value={value}
          onChange={setValue}
          onSubmit={submit}
          onSubmitForm={submitForm}
          pending={pending}
        />
      ) : (
        <AnswerFeedback result={phase.result} exercise={exercise} onContinue={onAdvance} />
      )}
    </Card>
  );
}

function kindLabel(kind: SessionGrammarExercise["kind"]): string {
  switch (kind) {
    case "fill_blank":
      return "Fill in the blank";
    case "multiple_choice":
      return "Multiple choice";
    case "transform":
      return "Transform the sentence";
  }
}

function PromptBody({ exercise }: { exercise: SessionGrammarExercise }) {
  if (exercise.kind === "fill_blank") {
    // Render the prompt with the placeholder swapped for a visible blank
    // marker so the user sees where to type. The text-only fallback is
    // identical to what the LLM emitted.
    return (
      <p className="text-lg font-medium text-foreground">
        {renderFillBlankPrompt(exercise.prompt)}
      </p>
    );
  }
  return <p className="text-lg font-medium text-foreground">{exercise.prompt}</p>;
}

// Splits a fill-in prompt around the placeholder marker and renders a
// styled span in its place. Reads cleaner than a plain `___` for low-vision
// users and signals "type your answer here" for sighted ones.
function renderFillBlankPrompt(prompt: string) {
  const segments = prompt.split(GRAMMAR_FILL_BLANK_PLACEHOLDER);
  if (segments.length === 1) return prompt;
  const out: Array<React.ReactNode> = [];
  for (let i = 0; i < segments.length; i += 1) {
    out.push(<span key={`text-${i}`}>{segments[i]}</span>);
    if (i < segments.length - 1) {
      out.push(
        <span
          key={`blank-${i}`}
          aria-label="blank"
          className="mx-1 inline-block min-w-[3ch] border-b border-foreground-subtle px-1 align-baseline text-foreground-muted"
        >
          {"   "}
        </span>,
      );
    }
  }
  return <>{out}</>;
}

function ExerciseInput({
  exercise,
  value,
  onChange,
  onSubmit,
  onSubmitForm,
  pending,
}: {
  exercise: SessionGrammarExercise;
  value: string;
  onChange: (next: string) => void;
  onSubmit: (answer: string) => void;
  onSubmitForm: (e: FormEvent<HTMLFormElement>) => void;
  pending: boolean;
}) {
  if (exercise.kind === "multiple_choice") {
    return (
      <div className="flex flex-col gap-2">
        {exercise.choices.map((choice, idx) => (
          <button
            key={`${idx}-${choice}`}
            type="button"
            disabled={pending}
            onClick={() => onSubmit(choice)}
            className="rounded-md border border-border bg-surface-muted/30 px-4 py-3 text-left text-sm text-foreground transition hover:border-foreground hover:bg-surface-muted disabled:opacity-40"
          >
            <span className="mr-2 text-[11px] uppercase tracking-wider text-foreground-subtle">
              {String.fromCharCode(65 + idx)}
            </span>
            {choice}
          </button>
        ))}
      </div>
    );
  }
  if (exercise.kind === "transform") {
    return (
      <form onSubmit={onSubmitForm} className="flex flex-col gap-3">
        <label htmlFor="grammar-transform-input" className="text-xs text-foreground-muted">
          Rewrite the sentence as requested.
        </label>
        <textarea
          id="grammar-transform-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
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
    );
  }
  // fill_blank
  return (
    <form onSubmit={onSubmitForm} className="flex flex-col gap-3">
      <label htmlFor="grammar-fillblank-input" className="text-xs text-foreground-muted">
        Type the word or phrase that fills the blank.
      </label>
      <input
        id="grammar-fillblank-input"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
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
  );
}

function AnswerFeedback({
  result,
  exercise,
  onContinue,
}: {
  result: RecordGrammarExerciseResult;
  exercise: SessionGrammarExercise;
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
  return (
    <div className="space-y-3 border-t border-border pt-4">
      <p
        className={`text-sm font-medium ${
          result.correct ? "text-emerald-700 dark:text-emerald-300" : "text-danger"
        }`}
      >
        {result.correct ? `Correct. +${result.xpAwarded} XP.` : "Not quite."}
      </p>
      <div>
        <p className="text-xs uppercase tracking-wider text-foreground-subtle">Answer</p>
        <p className="mt-1 text-sm font-semibold text-foreground">{result.expectedAnswer}</p>
      </div>
      {result.explanation ? (
        <p className="text-xs text-foreground-muted">{result.explanation}</p>
      ) : exercise.explanation ? (
        <p className="text-xs text-foreground-muted">{exercise.explanation}</p>
      ) : null}
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
