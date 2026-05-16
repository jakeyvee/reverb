import Link from "next/link";
import { EmptyState } from "@/components/ui/card";
import { ChatRunner } from "@/components/chat/chat-runner";
import { requireUser } from "@/lib/auth/get-user";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getOrCreateActiveSession, loadSessionMessages } from "@/lib/chat/sessions";

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const user = await requireUser();
  const supabase = await createServerSupabaseClient();
  if (!supabase) {
    return (
      <PageShell>
        <EmptyState
          title="Supabase not configured"
          description="Set NEXT_PUBLIC_SUPABASE_URL and the matching keys to start a chat."
        />
      </PageShell>
    );
  }

  const session = await getOrCreateActiveSession(supabase, user.id);
  const messages = await loadSessionMessages(supabase, session.id, user.id);

  return (
    <PageShell>
      <ChatRunner sessionId={session.id} level={session.level} initialMessages={messages} />
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <div>
        <Link href="/" className="text-xs text-foreground-subtle transition hover:text-foreground">
          ← Home
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight md:text-2xl">Chat in Bahasa</h1>
        <p className="mt-1 text-sm text-foreground-muted">
          Free-form practice with an AI partner. It uses your lesson vocab and corrects mistakes
          inline.
        </p>
      </div>
      {children}
    </div>
  );
}
