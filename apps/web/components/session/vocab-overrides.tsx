"use client";

import { useState, useTransition } from "react";
import {
  EXTRACTION_FLAG_REASONS,
  extractionFlagReasonLabel,
  type ExtractionFlagReason,
} from "@reverb/domain/schemas/extraction-flag";
import {
  flagExtractedItemAction,
  markVocabKnownAction,
  type MarkVocabKnownResult,
} from "@/lib/vocab/overrides";

type Props = {
  vocabItemId: string;
  // When the override fires from inside the daily session runner, this
  // links the action back to the practice_session_items row so the
  // server-side path can also mark it answered. Omitted in non-session
  // contexts (e.g. lesson detail screens).
  sessionItemId?: string;
  // Called after a successful "I already know this" so the parent can advance
  // past the current card and update its in-memory queue. The action also
  // revalidates `/session`, but for the in-progress runner we want immediate
  // feedback without waiting for a router refresh. Receives the action
  // result so the parent can pull through the updated session counters.
  onKnown?: (result: Extract<MarkVocabKnownResult, { ok: true }>) => void;
  // Called after a successful flag so the parent can show a "flagged" pill or
  // collapse the affordance. Doesn't auto-advance — flagging is independent
  // of whether the user keeps reviewing the card.
  onFlagged?: (reason: ExtractionFlagReason) => void;
};

type Phase = "idle" | "flagging";

export function VocabOverrideControls({ vocabItemId, sessionItemId, onKnown, onFlagged }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const handleKnown = () => {
    setError(null);
    setFeedback(null);
    startTransition(async () => {
      const result = await markVocabKnownAction({ vocabItemId, sessionItemId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setFeedback("Marked as known. Removing card.");
      onKnown?.(result);
    });
  };

  const handleFlag = (reason: ExtractionFlagReason) => {
    setError(null);
    setFeedback(null);
    startTransition(async () => {
      const result = await flagExtractedItemAction({
        targetKind: "vocab",
        targetId: vocabItemId,
        reason,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setFeedback("Thanks — we'll review this extraction.");
      setPhase("idle");
      onFlagged?.(reason);
    });
  };

  if (phase === "flagging") {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-muted/40 p-3">
        <p className="text-xs font-medium text-foreground">What&apos;s wrong with this card?</p>
        <div className="flex flex-wrap gap-1.5">
          {EXTRACTION_FLAG_REASONS.map((reason) => (
            <button
              key={reason}
              type="button"
              onClick={() => handleFlag(reason)}
              disabled={pending}
              className="rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-foreground transition hover:bg-surface-muted disabled:opacity-40"
            >
              {extractionFlagReasonLabel(reason)}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setPhase("idle")}
            disabled={pending}
            className="rounded-md px-2.5 py-1 text-xs text-foreground-subtle hover:text-foreground disabled:opacity-40"
          >
            Cancel
          </button>
        </div>
        {error ? (
          <p className="text-xs text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <button
        type="button"
        onClick={handleKnown}
        disabled={pending}
        className="rounded-md border border-border px-2.5 py-1 font-medium text-foreground-muted transition hover:bg-surface-muted hover:text-foreground disabled:opacity-40"
      >
        I already know this
      </button>
      <button
        type="button"
        onClick={() => setPhase("flagging")}
        disabled={pending}
        className="rounded-md border border-border px-2.5 py-1 font-medium text-foreground-muted transition hover:bg-surface-muted hover:text-foreground disabled:opacity-40"
      >
        Flag this card
      </button>
      {feedback ? (
        <span className="text-foreground-subtle" role="status">
          {feedback}
        </span>
      ) : null}
      {error ? (
        <span className="text-danger" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
