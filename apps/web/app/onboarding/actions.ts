"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isAllowedEmail } from "@/lib/auth/allowlist";

const TIME_PATTERN = /^([0-1]\d|2[0-3]):[0-5]\d$/;

export type OnboardingActionState = {
  error?: string;
};

export async function saveOnboarding(
  _prev: OnboardingActionState,
  formData: FormData,
): Promise<OnboardingActionState> {
  const supabase = await createServerSupabaseClient();
  if (!supabase) {
    return { error: "Supabase is not configured." };
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isAllowedEmail(user.email)) {
    redirect("/sign-in");
  }

  const reminderEnabled = formData.get("reminderEnabled") === "on";
  const reminderTimeRaw = String(formData.get("reminderTime") ?? "");
  if (!TIME_PATTERN.test(reminderTimeRaw)) {
    return { error: "Pick a time in HH:MM format." };
  }

  const { error } = await supabase
    .from("profiles")
    .update({
      reminder_enabled: reminderEnabled,
      reminder_time: `${reminderTimeRaw}:00`,
      onboarded_at: new Date().toISOString(),
    })
    .eq("id", user.id);
  if (error) {
    return { error: "Could not save your preferences. Please try again." };
  }

  revalidatePath("/", "layout");
  redirect("/");
}
