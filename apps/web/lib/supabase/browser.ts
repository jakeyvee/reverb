import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@reverb/db/types";
import { readSupabaseEnv } from "./env";

export function createBrowserSupabaseClient() {
  const env = readSupabaseEnv();
  if (!env) return null;
  return createBrowserClient<Database>(env.url, env.anonKey);
}
