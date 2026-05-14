"use client";

import { useState } from "react";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

type Props = {
  next: string | null;
};

export function GoogleSignInButton({ next }: Props) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null);
          setPending(true);
          void start(next).catch((err: unknown) => {
            setPending(false);
            setError(err instanceof Error ? err.message : "Could not start Google sign-in.");
          });
        }}
        className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-border bg-surface px-4 text-sm font-medium text-foreground transition hover:bg-surface-muted disabled:opacity-60"
      >
        <GoogleMark />
        <span>{pending ? "Redirecting…" : "Continue with Google"}</span>
      </button>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

async function start(next: string | null): Promise<void> {
  const supabase = createBrowserSupabaseClient();
  if (!supabase) {
    throw new Error("Supabase is not configured.");
  }

  const redirectUrl = new URL("/auth/callback", window.location.origin);
  if (next) redirectUrl.searchParams.set("next", next);

  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: redirectUrl.toString(),
      queryParams: { prompt: "select_account" },
    },
  });
  if (error) throw error;
}

function GoogleMark() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.717v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.616Z"
        fill="#4285F4"
      />
      <path
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.258c-.806.54-1.836.86-3.048.86-2.344 0-4.328-1.583-5.036-3.71H.957v2.332A8.997 8.997 0 0 0 9 18Z"
        fill="#34A853"
      />
      <path
        d="M3.964 10.712A5.41 5.41 0 0 1 3.682 9c0-.594.102-1.171.282-1.712V4.957H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.043l3.007-2.331Z"
        fill="#FBBC05"
      />
      <path
        d="M9 3.58c1.321 0 2.508.454 3.441 1.346l2.581-2.581C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.957l3.007 2.331C4.672 5.163 6.656 3.58 9 3.58Z"
        fill="#EA4335"
      />
    </svg>
  );
}
