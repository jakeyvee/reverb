import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isAllowedEmail, isVincentEmail } from "@/lib/auth/allowlist";

export type AppUser = {
  id: string;
  email: string | null;
  displayName: string | null;
  isVincent: boolean;
  isAllowed: boolean;
};

export async function getUser(): Promise<AppUser | null> {
  const supabase = await createServerSupabaseClient();
  if (!supabase) return null;

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;
  const email = user.email ?? null;
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const rawName = meta.full_name ?? meta.name ?? meta.display_name;
  const displayName = typeof rawName === "string" && rawName.length > 0 ? rawName : null;

  return {
    id: user.id,
    email,
    displayName,
    isVincent: isVincentEmail(email),
    isAllowed: isAllowedEmail(email),
  };
}

export async function requireUser(): Promise<AppUser> {
  const user = await getUser();
  if (!user) redirect("/sign-in");
  if (!user.isAllowed) redirect("/access-denied");
  return user;
}
