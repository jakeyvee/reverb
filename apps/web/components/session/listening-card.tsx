"use client";

import { useCallback, useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { Card } from "@/components/ui/card";
import { PlayIcon } from "@/components/ui/icons";
import { recordListeningAttempt, type RecordListeningAttemptResult } from "@/lib/session/actions";
import { formatSpeakerChoice } from "@/lib/session/listening-comprehension";
import type { ListeningItemView } from "@/lib/session/listening-comprehension";

// VOL-128 listening-comprehension runner. Plays the materialized clip from
// the private `lesson-clips` bucket (signed URL upstream) and routes the
// user through the prompt's question type:
//
//   transcription  — text input, server-graded against the caption,
//                    with a "close enough" self-mark fallback.
//   mc_english     — buttons for each English choice.
//   speaker_id     — buttons for the household speakers.
//
// Index management belongs to SessionRunner; this component renders the
// prompt and emits the attempt result.

type Props = {
  listening: ListeningItemView;
  sessionItemId: string;
  positionLabel: string;
  onAnswered: (result: RecordListeningAttemptResult) => void;
  onAdvance: () => void;
};

type Phase = { kind: "prompt" } | { kind: "answered"; result: RecordListeningAttemptResult };

export function SessionListeningCard({
  listening,
  sessionItemId,
  positionLabel,
  onAnswered,
  onAdvance,
}: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: "prompt" });
  const [typedAnswer, setTypedAnswer] = useState("");
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const startedAtRef = useRef<number>(Date.now());

  useEffect(() => {
    startedAtRef.current = Date.now();
    setPhase({ kind: "prompt" });
    setTypedAnswer("");
    setSelectedIndex(null);
  }, [listening.clipId, listening.prompt.kind]);

  const playAudio = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    try {
      el.currentTime = 0;
      void el.play().catch(() => undefined);
    } catch {
      // Browsers can refuse playback (autoplay policy, expired URL); the
      // disabled state on the button handles "no audio" upfront, and the
      // user can re-click otherwise.
    }
  }, []);

  const submit = useCallback(
    (overrides?: { selfMarked?: "pass" | "fail" }) => {
      if (pending) return;
      const responseMs = Math.max(0, Date.now() - startedAtRef.current);
      startTransition(async () => {
        const result = await recordListeningAttempt({
          sessionItemId,
          promptKind: listening.prompt.kind,
          typedAnswer: listening.prompt.kind === "transcription" ? typedAnswer : undefined,
          selectedIndex: selectedIndex ?? undefined,
          selfMarked: overrides?.selfMarked,
          responseMs,
        });
        setPhase({ kind: "answered", result });
        onAnswered(result);
      });
    },
    [listening.prompt.kind, onAnswered, pending, selectedIndex, sessionItemId, typedAnswer],
  );

  const audioAvailable = listening.audioUrl !== null;

  return (
    <Card className="flex flex-col gap-5 py-7">
      <div className="flex items-center justify-between text-xs text-foreground-subtle">
        <span className="uppercase tracking-wider">Listening · {positionLabel}</span>
        <span className="text-[11px] text-foreground-subtle">
          {Math.round(listening.durationMs / 1000)}s clip
        </span>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={playAudio}
          disabled={!audioAvailable}
          aria-label={audioAvailable ? "Play clip" : "Audio unavailable"}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-border bg-surface-muted text-foreground transition hover:bg-surface-muted/70 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <PlayIcon width={20} height={20} />
        </button>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            {promptHeadline(listening.prompt.kind)}
          </p>
          {listening.lessonTitle ? (
            <p className="mt-0.5 text-xs text-foreground-subtle">From {listening.lessonTitle}</p>
          ) : null}
        </div>
      </div>

      {audioAvailable && listening.audioUrl ? (
        <audio ref={audioRef} src={listening.audioUrl} preload="auto" className="hidden" />
      ) : (
        <p className="text-[11px] text-foreground-subtle">
          Audio is unavailable for this clip — try again once it&apos;s materialised.
        </p>
      )}

      <p className="text-sm text-foreground">{listening.prompt.question}</p>

      {phase.kind === "prompt" ? (
        listening.prompt.kind === "transcription" ? (
          <TranscriptionInput
            value={typedAnswer}
            onChange={setTypedAnswer}
            onSubmit={() => submit()}
            pending={pending}
          />
        ) : (
          <ChoicesGroup
            choices={listening.prompt.choices}
            kind={listening.prompt.kind}
            selectedIndex={selectedIndex}
            onSelect={setSelectedIndex}
            onSubmit={() => submit()}
            pending={pending}
          />
        )
      ) : (
        <AnswerFeedback
          result={phase.result}
          promptKind={listening.prompt.kind}
          choices={listening.prompt.choices}
          onContinue={onAdvance}
          onSelfMarkClose={
            listening.prompt.kind === "transcription"
              ? () => submit({ selfMarked: "pass" })
              : undefined
          }
        />
      )}
    </Card>
  );
}

function TranscriptionInput({
  value,
  onChange,
  onSubmit,
  pending,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  pending: boolean;
}) {
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit();
  }
  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <label htmlFor="listening-transcription" className="text-xs text-foreground-muted">
        Type what you heard, in the original language.
      </label>
      <textarea
        id="listening-transcription"
        value={value}
        onChange={(event) => onChange(event.target.value)}
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

function ChoicesGroup({
  choices,
  kind,
  selectedIndex,
  onSelect,
  onSubmit,
  pending,
}: {
  choices: ReadonlyArray<string>;
  kind: "mc_english" | "speaker_id";
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  onSubmit: () => void;
  pending: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <ul className="grid gap-2">
        {choices.map((choice, index) => {
          const label = kind === "speaker_id" ? formatSpeakerChoice(choice) : choice;
          const isSelected = selectedIndex === index;
          return (
            <li key={`${index}-${choice}`}>
              <button
                type="button"
                onClick={() => onSelect(index)}
                disabled={pending}
                className={`w-full rounded-md border px-3 py-2 text-left text-sm transition disabled:opacity-40 ${
                  isSelected
                    ? "border-foreground bg-foreground text-background"
                    : "border-border text-foreground hover:bg-surface-muted/60"
                }`}
              >
                {label}
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={onSubmit}
        disabled={pending || selectedIndex === null}
        className="self-start rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition disabled:opacity-40"
      >
        Submit
      </button>
    </div>
  );
}

function AnswerFeedback({
  result,
  promptKind,
  choices,
  onContinue,
  onSelfMarkClose,
}: {
  result: RecordListeningAttemptResult;
  promptKind: "transcription" | "mc_english" | "speaker_id";
  choices: ReadonlyArray<string>;
  onContinue: () => void;
  onSelfMarkClose?: () => void;
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
        {result.correct ? `Nailed it. +${result.xpAwarded} XP.` : "Not quite — here's the answer."}
      </p>
      <ExpectedDetail promptKind={promptKind} expected={result.expected} choices={choices} />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onContinue}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition"
        >
          Continue
        </button>
        {!result.correct && onSelfMarkClose ? (
          <button
            type="button"
            onClick={onSelfMarkClose}
            className="rounded-md border border-border px-3 py-2 text-xs text-foreground-muted transition hover:text-foreground"
          >
            I was close — mark correct
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ExpectedDetail({
  promptKind,
  expected,
  choices,
}: {
  promptKind: "transcription" | "mc_english" | "speaker_id";
  expected: { promptKind: string; text: string | null; choiceIndex: number | null };
  choices: ReadonlyArray<string>;
}) {
  if (promptKind === "transcription") {
    return expected.text ? (
      <div className="rounded-md border border-border bg-surface-muted/40 p-3">
        <p className="text-xs uppercase tracking-wider text-foreground-subtle">Caption</p>
        <p className="mt-1 text-sm text-foreground">{expected.text}</p>
      </div>
    ) : null;
  }
  if (expected.choiceIndex === null) return null;
  const answer = choices[expected.choiceIndex];
  if (!answer) return null;
  const label = promptKind === "speaker_id" ? formatSpeakerChoice(answer) : answer;
  return (
    <p className="text-xs text-foreground-muted">
      Correct answer: <span className="font-medium text-foreground">{label}</span>
    </p>
  );
}

function promptHeadline(kind: "transcription" | "mc_english" | "speaker_id"): string {
  switch (kind) {
    case "transcription":
      return "Transcribe what you hear";
    case "mc_english":
      return "Pick the English meaning";
    case "speaker_id":
      return "Identify the speaker";
  }
}
