import { readSupabaseEnv } from "@/lib/supabase/env";

type Props = {
  searchParams: Promise<{ next?: string }>;
};

export default async function SignInPage({ searchParams }: Props) {
  const { next } = await searchParams;
  const configured = Boolean(readSupabaseEnv());

  return (
    <div className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
      <h1 className="text-lg font-semibold tracking-tight">Sign in to Reverb</h1>
      <p className="mt-1 text-sm text-foreground-muted">
        Authentication wiring lands in a follow-up ticket. This screen is the redirect target for
        protected routes.
      </p>

      {!configured ? (
        <div className="mt-4 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
          Supabase env vars aren&apos;t set. Add{" "}
          <code className="font-mono">NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
          <code className="font-mono">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in{" "}
          <code className="font-mono">apps/web/.env.local</code> to enable real auth.
        </div>
      ) : null}

      <button
        type="button"
        disabled
        className="mt-6 inline-flex h-10 w-full items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground opacity-60"
      >
        Continue with email
      </button>

      {next ? (
        <p className="mt-4 truncate text-xs text-foreground-subtle" title={next}>
          You&apos;ll return to {next} after signing in.
        </p>
      ) : null}
    </div>
  );
}
