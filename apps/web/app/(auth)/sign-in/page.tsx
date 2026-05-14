import { readSupabaseEnv } from "@/lib/supabase/env";
import { GoogleSignInButton } from "./google-button";

type Props = {
  searchParams: Promise<{ next?: string; error?: string }>;
};

export default async function SignInPage({ searchParams }: Props) {
  const { next, error } = await searchParams;
  const configured = Boolean(readSupabaseEnv());

  return (
    <div className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
      <h1 className="text-lg font-semibold tracking-tight">Sign in to Reverb</h1>
      <p className="mt-1 text-sm text-foreground-muted">
        Reverb is private. Sign in with a Google account on the household allow-list to continue.
      </p>

      {!configured ? (
        <div className="mt-4 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
          Supabase env vars aren&apos;t set. Add{" "}
          <code className="font-mono">NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
          <code className="font-mono">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in{" "}
          <code className="font-mono">apps/web/.env.local</code> to enable real auth.
        </div>
      ) : null}

      {error ? (
        <div className="mt-4 rounded-md border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
          {decodeURIComponent(error)}
        </div>
      ) : null}

      <div className="mt-6">
        <GoogleSignInButton next={next ?? null} />
      </div>

      {next ? (
        <p className="mt-4 truncate text-xs text-foreground-subtle" title={next}>
          You&apos;ll return to {next} after signing in.
        </p>
      ) : null}
    </div>
  );
}
