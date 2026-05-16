"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import type { ReviewRating } from "@reverb/domain/schemas/review";
import { Card } from "@/components/ui/card";
import { PlayIcon } from "@/components/ui/icons";
import { submitVocabReviewAction, type SubmitVocabReviewActionResult } from "@/lib/vocab/actions";
import type { ReviewableVocabCard } from "@/lib/session/vocab-review";
import { resolveVocabReviewKey, type ReviewKeyPhase } from "@/lib/session/vocab-review-keys";
import { VocabOverrideControls } from "@/components/session/vocab-overrides";

// Single-card vocab review. Renders one hydrated vocab card and submits the
// user's rating via the vocab review action. When `sessionItemId` is set,
// the action also bumps the host practice_session counters. Index/queue
// management lives one level up in SessionRunner — this component is a
// pure "render and emit" leaf so the orchestrator can stack it next to a
// drill card without their internal states colliding.

type Props = {
  card: ReviewableVocabCard;
  sessionItemId?: string;
  positionLabel: string;
  // Fires after the action completes (success or failure). The runner uses
  // this to advance to the next item and pull updated session counters.
  onAnswered: (event: { rating: ReviewRating; result: SubmitVocabReviewActionResult }) => void;
  // Fires when the user clicks "Continue" / hits Enter on the feedback
  // screen. Separate from `onAnswered` so the queue advances on explicit
  // user input rather than the instant a review lands.
  onAdvance: () => void;
};

type RatingConfig = {
  value: ReviewRating;
  label: string;
  shortcut: string;
  toneClass: string;
};

const RATINGS: RatingConfig[] = [
  {
    value: "again",
    label: "Again",
    shortcut: "1",
    toneClass: "border-danger/40 text-danger hover:bg-danger/10 focus-visible:ring-danger/40",
  },
  {
    value: "hard",
    label: "Hard",
    shortcut: "2",
    toneClass:
      "border-amber-400/40 text-amber-700 hover:bg-amber-400/10 focus-visible:ring-amber-400/40 dark:text-amber-300",
  },
  {
    value: "good",
    label: "Good",
    shortcut: "3",
    toneClass:
      "border-emerald-500/40 text-emerald-700 hover:bg-emerald-500/10 focus-visible:ring-emerald-500/40 dark:text-emerald-300",
  },
  {
    value: "easy",
    label: "Easy",
    shortcut: "4",
    toneClass:
      "border-sky-500/40 text-sky-700 hover:bg-sky-500/10 focus-visible:ring-sky-500/40 dark:text-sky-300",
  },
];

export function SessionVocabCard({
  card,
  sessionItemId,
  positionLabel,
  onAnswered,
  onAdvance,
}: Props) {
  const [phase, setPhase] = useState<ReviewKeyPhase>("prompt");
  const [feedback, setFeedback] = useState<SubmitVocabReviewActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const startedAtRef = useRef<number>(Date.now());

  // Reset whenever the active card changes (parent rerenders with a new
  // card prop). startedAt resets so elapsedMs reflects time-on-this-card.
  useEffect(() => {
    startedAtRef.current = Date.now();
    setFeedback(null);
    setPhase("prompt");
  }, [card.cardId]);

  const playAudio = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    try {
      el.currentTime = 0;
      void el.play().catch(() => undefined);
    } catch {
      // ignore
    }
  }, []);

  const reveal = useCallback(() => setPhase("answer"), []);

  const submitRating = useCallback(
    (rating: ReviewRating) => {
      if (pending) return;
      const elapsedMs = Math.max(0, Date.now() - startedAtRef.current);
      startTransition(async () => {
        const result = await submitVocabReviewAction({
          cardId: card.cardId,
          rating,
          elapsedMs,
          sessionItemId,
        });
        setFeedback(result);
        setPhase("answered");
        onAnswered({ rating, result });
      });
    },
    [card.cardId, onAnswered, pending, sessionItemId],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const action = resolveVocabReviewKey(event, phase);
      if (!action) return;
      event.preventDefault();
      switch (action.kind) {
        case "play-audio":
          playAudio();
          return;
        case "reveal":
          reveal();
          return;
        case "rate":
          submitRating(action.rating);
          return;
        case "advance":
          onAdvance();
          return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, playAudio, reveal, submitRating, onAdvance]);

  const hasAudio = card.audioUrl !== null;

  return (
    <Card className="flex flex-col gap-5 py-6">
      <div className="flex items-center justify-between text-xs text-foreground-subtle">
        <span className="uppercase tracking-wider">Vocab review · {positionLabel}</span>
        <span className="hidden text-[10px] uppercase tracking-wider text-foreground-subtle md:inline">
          Space audio · 1-4 rate · Enter next
        </span>
      </div>

      <div className="space-y-3">
        <div className="flex items-start gap-3">
          <button
            type="button"
            onClick={playAudio}
            disabled={!hasAudio}
            aria-label={hasAudio ? `Play audio for ${card.vocab.lemma}` : "Audio unavailable"}
            title={hasAudio ? "Play (Space)" : "Audio not available for this word yet"}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-border bg-surface-muted text-foreground transition hover:bg-surface-muted/70 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <PlayIcon width={20} height={20} />
          </button>
          <div className="min-w-0 flex-1">
            <p className="break-words text-2xl font-semibold leading-tight text-foreground md:text-3xl">
              {card.vocab.lemma}
            </p>
            {card.vocab.reading ? (
              <p className="mt-0.5 break-words text-xs text-foreground-subtle">
                {card.vocab.reading}
              </p>
            ) : null}
            {card.vocab.partOfSpeech ? (
              <p className="mt-1 text-[11px] uppercase tracking-wider text-foreground-subtle">
                {card.vocab.partOfSpeech}
              </p>
            ) : null}
          </div>
        </div>

        {card.vocab.exampleSentence ? (
          <div className="rounded-md border border-border bg-surface-muted/40 p-3">
            <p className="text-xs uppercase tracking-wider text-foreground-subtle">In context</p>
            <p className="mt-1 break-words text-sm text-foreground">{card.vocab.exampleSentence}</p>
          </div>
        ) : null}

        {hasAudio && card.audioUrl ? (
          <audio ref={audioRef} src={card.audioUrl} preload="auto" className="hidden" />
        ) : (
          <p className="text-[11px] text-foreground-subtle">
            Audio is still being generated for this word.
          </p>
        )}
      </div>

      {phase === "prompt" ? (
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={reveal}
            className="self-start rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition"
          >
            Show answer
            <span className="ml-2 hidden text-[10px] uppercase tracking-wider opacity-70 md:inline">
              Enter
            </span>
          </button>
        </div>
      ) : (
        <CardBack card={card} />
      )}

      {phase === "answer" ? (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {RATINGS.map((rating) => (
            <button
              key={rating.value}
              type="button"
              onClick={() => submitRating(rating.value)}
              disabled={pending}
              className={`flex flex-col items-center gap-1 rounded-md border px-3 py-2 text-sm font-medium transition focus:outline-none focus-visible:ring-2 disabled:opacity-40 ${rating.toneClass}`}
            >
              <span>{rating.label}</span>
              <span className="text-[10px] uppercase tracking-wider opacity-70">
                {rating.shortcut}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {phase === "answered" && feedback ? (
        <ReviewFeedback feedback={feedback} onContinue={onAdvance} />
      ) : null}

      <div className="border-t border-border pt-3">
        <VocabOverrideControls vocabItemId={card.vocabItemId} onKnown={onAdvance} />
      </div>
    </Card>
  );
}

function CardBack({ card }: { card: ReviewableVocabCard }) {
  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div>
        <p className="text-xs uppercase tracking-wider text-foreground-subtle">Meaning</p>
        <p className="mt-1 break-words text-lg font-medium text-foreground">
          {card.vocab.translation ?? "—"}
        </p>
      </div>
      {card.vocab.exampleTranslation ? (
        <p className="break-words text-sm text-foreground-muted">{card.vocab.exampleTranslation}</p>
      ) : null}
      {card.lessonTitle && card.vocab.lessonId ? (
        <p className="text-[11px] text-foreground-subtle">
          From{" "}
          <a
            href={`/lessons/${card.vocab.lessonId}`}
            className="underline-offset-2 hover:underline"
          >
            {card.lessonTitle}
          </a>
        </p>
      ) : null}
    </div>
  );
}

function ReviewFeedback({
  feedback,
  onContinue,
}: {
  feedback: SubmitVocabReviewActionResult;
  onContinue: () => void;
}) {
  if (!feedback.ok) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-danger">{feedback.error}</p>
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
    <div className="flex flex-col items-start gap-2 border-t border-border pt-4">
      <p className="text-xs text-foreground-subtle">
        Next review {formatRelativeFutureIso(feedback.review.dueAt)}
        {feedback.session ? ` · +${feedback.session.xpAwarded} XP` : null}
      </p>
      <button
        type="button"
        onClick={onContinue}
        className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition"
      >
        Continue
        <span className="ml-2 hidden text-[10px] uppercase tracking-wider opacity-70 md:inline">
          Enter
        </span>
      </button>
    </div>
  );
}

function formatRelativeFutureIso(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  if (diffMs <= 0) return "now";
  const diffMins = Math.round(diffMs / 60_000);
  if (diffMins < 60) return `in ${Math.max(diffMins, 1)} min`;
  const diffHours = Math.round(diffMs / 3_600_000);
  if (diffHours < 24) return `in ${diffHours} h`;
  const diffDays = Math.round(diffMs / 86_400_000);
  return `in ${diffDays} day${diffDays === 1 ? "" : "s"}`;
}
