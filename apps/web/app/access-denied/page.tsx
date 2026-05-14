import Link from "next/link";

export const dynamic = "force-dynamic";

export default function AccessDeniedPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm rounded-2xl border border-danger/40 bg-surface p-6 shadow-sm">
        <p className="text-xs font-medium uppercase tracking-wider text-danger">403 · Forbidden</p>
        <h1 className="mt-2 text-lg font-semibold tracking-tight">This Reverb is private</h1>
        <p className="mt-2 text-sm text-foreground-muted">
          Your Google account isn&apos;t on the household allow-list. If this looks wrong, double
          check you&apos;re signed into the right Google account and try again.
        </p>
        <Link
          href="/sign-in"
          className="mt-6 inline-flex h-10 w-full items-center justify-center rounded-md border border-border bg-surface px-4 text-sm font-medium text-foreground transition hover:bg-surface-muted"
        >
          Back to sign-in
        </Link>
      </div>
    </div>
  );
}
