import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { dbEnv } from "./env.js";
import type { Database } from "./types.js";

export function createServiceRoleClient() {
  return createSupabaseClient<Database>(dbEnv.url(), dbEnv.serviceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
