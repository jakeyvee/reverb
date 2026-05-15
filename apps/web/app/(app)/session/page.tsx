import Link from "next/link";
import { Card, EmptyState, SectionHeader } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/get-user";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  ensureCorrectionDrillsForUser,
  loadDailySession,
} from "@/lib/session/correction-drills";
import { orderDailySession } from "@/lib/session/order";
import { MistakeDrillRunner } from "@/components/session/mistake-drill-runner";

export const dynamic = "force-dynamic";

export default async function SessionPage() {
  const user = await requireUser();
  const supabase = await createServerSupabaseClient();
  if (!supabase) {
    return (
      <PageShell>
        <EmptyState
          title="Supabase not configured"
          description="Set NEXT_PUBLIC_SUPABASE_URL and the matching keys to load your session."
        />
      </PageShell>
    );
  }

  await ensureCorrectionDrillsForUser(supabase, user.id);
  const session = await loadDailySession(supabase, user.id);
  const queue = orderDailySession(session);
  const hasCorrections = session.corrections.length > 0;
  const correctionCount = session.corrections.length;
  const freshVocabCount = session.freshVocab.length;

  return (
    <PageShell>
      <div className="grid grid-cols-3 gap-2 text-center">
        <Stat label="Corrections" value={String(correctionCount)} highlight={hasCorrections} />
        <Stat label="Fresh vocab" value={String(freshVocabCount)} />
        <Stat label="Retired" value={String(session.filtered.retired)} />
      </div>

      {session.filtered.lowConfidence > 0 ? (
        <p className="text-xs text-foreground-muted">
          {session.filtered.lowConfidence}{" "}
          {session.filtered.lowConfidence === 1 ? "correction is" : "corrections are"} hidden
          because the model wasn&apos;t confident enough.
        </p>
      ) : null}

      {hasCorrections ? (
        <MistakeDrillRunner drills={session.corrections} />
      ) : (
        <EmptyState
          title="No correction drills due"
          description={
            queue.length > 0
              ? "Fresh vocab is queued below once correction drills go live."
              : "Upload a lesson — teacher corrections become drills automatically."
          }
        />
      )}

      {freshVocabCount > 0 ? (
        <section className="space-y-2">
          <SectionHeader
            title="Coming up · Fresh vocab"
            description="Surfaces after you clear today's correction drills."
          />
          <ul className="space-y-2">
            {session.freshVocab.map((vocab) => (
              <li key={vocab.vocabItemId}>
                <Card className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-medium">{vocab.lemma}</span>
                  <span className="text-xs text-foreground-muted">
                    {vocab.translation ?? "—"}
                  </span>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/"
          className="text-xs text-foreground-subtle transition hover:text-foreground"
        >
          ← Home
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight md:text-2xl">Session</h1>
        <p className="mt-1 text-sm text-foreground-muted">
          Teacher-corrected mistakes come up first — they repeat your actual errors.
        </p>
      </div>
      {children}
    </div>
  );
}

function Stat({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${
        highlight ? "border-accent/40 bg-accent/5" : "border-border bg-surface-muted/40"
      }`}
    >
      <p className="text-[11px] uppercase tracking-wider text-foreground-subtle">{label}</p>
      <p className="mt-1 text-base font-semibold text-foreground">{value}</p>
    </div>
  );
}
