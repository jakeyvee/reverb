"use client";

import { useTransition } from "react";
import { setTheme } from "@/lib/theme/actions";
import type { Theme } from "@/lib/theme/cookie";

type Props = {
  current: Theme;
};

export function ThemeToggle({ current }: Props) {
  const [pending, startTransition] = useTransition();
  const next: Theme = current === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      disabled={pending}
      onClick={() => {
        startTransition(async () => {
          await setTheme(next);
        });
      }}
      className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-foreground-muted transition hover:bg-surface-muted hover:text-foreground disabled:opacity-50"
    >
      {current === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function SunIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
    </svg>
  );
}
