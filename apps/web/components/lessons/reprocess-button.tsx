"use client";

import { useState, useTransition } from "react";
import { reprocessLesson } from "@/app/(app)/lessons/actions";

type Props = {
  lessonId: string;
  // Disable when there's an in-flight pipeline run for this lesson — the
  // server action also rejects in that case, but greying out the button is
  // a clearer signal than the toast.
  disabled?: boolean;
};

// Vincent-only "re-run extraction" affordance. Calls into the server action
// that wipes the extracting + generating_audio stage markers and re-enqueues
// the worker. Card components on the lesson detail page render this inline
// with the version badge.
export function ReprocessButton({ lessonId, disabled }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [doneAt, setDoneAt] = useState<number | null>(null);

  const onClick = () => {
    setError(null);
    setDoneAt(null);
    startTransition(async () => {
      const result = await reprocessLesson({ lessonId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDoneAt(Date.now());
    });
  };

  if (doneAt !== null) {
    return (
      <p className="text-xs text-foreground-subtle" role="status">
        Re-queued for extraction.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={pending || disabled}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-foreground-muted transition hover:bg-surface-muted hover:text-foreground disabled:opacity-60"
      >
        {pending ? "Re-running…" : "Re-run extraction"}
      </button>
      {error ? (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
