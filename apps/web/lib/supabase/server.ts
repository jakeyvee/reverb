import { cookies } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { Database } from "@reverb/db/types";
import { readSupabaseEnv } from "./env";

type CookieSet = { name: string; value: string; options: CookieOptions };

export async function createServerSupabaseClient() {
  const env = readSupabaseEnv();
  if (!env) return null;

  const cookieStore = await cookies();

  return createServerClient<Database>(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: CookieSet[]) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // setAll called from a Server Component — middleware refreshes the session instead.
        }
      },
    },
  });
}
