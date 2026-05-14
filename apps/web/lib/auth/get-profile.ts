import { createServerSupabaseClient } from "@/lib/supabase/server";

export type AppProfile = {
  id: string;
  householdId: string;
  displayName: string;
  timezone: string;
  reminderEnabled: boolean;
  reminderTime: string;
  onboardedAt: string | null;
};

export async function getProfile(userId: string): Promise<AppProfile | null> {
  const supabase = await createServerSupabaseClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("profiles")
    .select(
      "id, household_id, display_name, timezone, reminder_enabled, reminder_time, onboarded_at",
    )
    .eq("id", userId)
    .maybeSingle();
  if (error || !data) return null;

  return {
    id: data.id,
    householdId: data.household_id,
    displayName: data.display_name,
    timezone: data.timezone,
    reminderEnabled: data.reminder_enabled,
    reminderTime: data.reminder_time,
    onboardedAt: data.onboarded_at,
  };
}
