import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/get-user";
import { getProfile } from "@/lib/auth/get-profile";
import { ensureProfile } from "@/lib/auth/bootstrap";
import { OnboardingForm } from "./onboarding-form";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const user = await requireUser();

  // The OAuth callback already runs ensureProfile, but a returning user whose
  // session was refreshed by middleware hasn't been through the callback this
  // visit. Run it again — it's idempotent — so the form has a real row to
  // edit.
  const supabase = await createServerSupabaseClient();
  if (supabase) {
    const {
      data: { user: authUser },
    } = await supabase.auth.getUser();
    if (authUser) await ensureProfile(authUser);
  }

  const profile = await getProfile(user.id);
  if (profile?.onboardedAt) {
    redirect("/");
  }

  const defaultTime = profile?.reminderTime ? profile.reminderTime.slice(0, 5) : "20:00";
  const defaultEnabled = profile?.reminderEnabled ?? true;

  return (
    <div className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wider text-foreground-subtle">
        Welcome{user.displayName ? `, ${user.displayName.split(" ")[0]}` : ""}
      </p>
      <h1 className="mt-1 text-lg font-semibold tracking-tight">One quick question</h1>
      <p className="mt-1 text-sm text-foreground-muted">
        When would you like Reverb to remind you to practice? You can change this later in your
        profile.
      </p>

      <div className="mt-6">
        <OnboardingForm
          defaultReminderEnabled={defaultEnabled}
          defaultReminderTime={defaultTime}
        />
      </div>
    </div>
  );
}
