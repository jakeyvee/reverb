import { createServiceRoleClient } from "@reverb/db/server";
import type { User } from "@supabase/supabase-js";

const DEFAULT_HOUSEHOLD_NAME = "Reverb House";
const DEFAULT_TIMEZONE = process.env.HOUSEHOLD_TIMEZONE ?? "UTC";

// Singleton household. Matches the seed UUID so local-dev and prod resolve to
// the same row. Pinning a UUID is the only race-free way to give two users
// signing in concurrently the same household_id when neither has a profile
// yet — the primary key turns the otherwise-checking insert into an atomic
// upsert.
const SINGLETON_HOUSEHOLD_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

export type BootstrapResult = {
  profileId: string;
  householdId: string;
  onboarded: boolean;
};

// Idempotently attach a freshly-signed-in user to the single Reverb household
// and ensure a profile row exists. Returns whether the user has finished
// onboarding so the caller can route to /onboarding when needed.
export async function ensureProfile(user: User): Promise<BootstrapResult> {
  const supabase = createServiceRoleClient();

  const { data: existing, error: existingError } = await supabase
    .from("profiles")
    .select("id, household_id, onboarded_at")
    .eq("id", user.id)
    .maybeSingle();
  if (existingError) throw existingError;

  if (existing) {
    return {
      profileId: existing.id,
      householdId: existing.household_id,
      onboarded: existing.onboarded_at !== null,
    };
  }

  const householdId = await ensureHousehold(supabase);
  const displayName = pickDisplayName(user);

  const { error: insertError } = await supabase.from("profiles").insert({
    id: user.id,
    household_id: householdId,
    display_name: displayName,
    avatar_url: pickAvatarUrl(user),
    locale: pickLocale(user),
    timezone: DEFAULT_TIMEZONE,
  });
  if (insertError) throw insertError;

  return { profileId: user.id, householdId, onboarded: false };
}

async function ensureHousehold(
  supabase: ReturnType<typeof createServiceRoleClient>,
): Promise<string> {
  // `ignoreDuplicates: true` makes this a no-op if the row already exists,
  // so concurrent first sign-ins both land on the same primary key without
  // creating a second household.
  const { error } = await supabase
    .from("households")
    .upsert(
      { id: SINGLETON_HOUSEHOLD_ID, name: DEFAULT_HOUSEHOLD_NAME },
      { onConflict: "id", ignoreDuplicates: true },
    );
  if (error) throw error;
  return SINGLETON_HOUSEHOLD_ID;
}

function pickDisplayName(user: User): string {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const candidates = [meta.full_name, meta.name, meta.display_name, user.email];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return "Reverb user";
}

function pickAvatarUrl(user: User): string | null {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const value = meta.avatar_url ?? meta.picture;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function pickLocale(user: User): string | null {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const value = meta.locale;
  return typeof value === "string" && value.length > 0 ? value : null;
}
