"use client";

import { useState, useTransition } from "react";
import { retryLessonProcessing } from "@/app/(app)/lessons/actions";

type Props = {
  lessonId: string;
};

export function RetryButton({ lessonId }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [doneAt, setDoneAt] = useState<number | null>(null);

  const onClick = () => {
    setError(null);
    setDoneAt(null);
    startTransition(async () => {
      const result = await retryLessonProcessing({ lessonId });
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
        Re-queued. We&apos;ll pick it back up shortly.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-foreground-muted transition hover:bg-surface-muted hover:text-foreground disabled:opacity-60"
      >
        {pending ? "Retrying…" : "Retry"}
      </button>
      {error ? (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
