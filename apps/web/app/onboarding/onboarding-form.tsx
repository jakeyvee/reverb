"use client";

import { useActionState } from "react";
import { saveOnboarding, type OnboardingActionState } from "./actions";

type Props = {
  defaultReminderEnabled: boolean;
  defaultReminderTime: string;
};

const initialState: OnboardingActionState = {};

export function OnboardingForm({ defaultReminderEnabled, defaultReminderTime }: Props) {
  const [state, action, pending] = useActionState(saveOnboarding, initialState);

  return (
    <form action={action} className="space-y-5">
      <label className="flex items-start gap-3 rounded-md border border-border bg-surface-muted/40 p-3 text-sm">
        <input
          type="checkbox"
          name="reminderEnabled"
          defaultChecked={defaultReminderEnabled}
          className="mt-0.5 h-4 w-4 rounded border-border accent-accent"
        />
        <span className="min-w-0">
          <span className="block font-medium text-foreground">Send me a daily reminder</span>
          <span className="mt-0.5 block text-xs text-foreground-subtle">
            We&apos;ll nudge you once a day to keep your streak alive.
          </span>
        </span>
      </label>

      <label className="block space-y-1.5">
        <span className="block text-xs font-medium uppercase tracking-wider text-foreground-subtle">
          Reminder time
        </span>
        <input
          type="time"
          name="reminderTime"
          defaultValue={defaultReminderTime}
          required
          className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground"
        />
        <span className="block text-xs text-foreground-subtle">Local to your timezone.</span>
      </label>

      {state.error ? (
        <p role="alert" className="text-xs text-danger">
          {state.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-10 w-full items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground transition hover:opacity-90 disabled:opacity-60"
      >
        {pending ? "Saving…" : "Continue"}
      </button>
    </form>
  );
}
