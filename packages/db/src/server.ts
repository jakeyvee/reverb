import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { dbEnv } from "./env";
import type { Database } from "./types";

export function createServiceRoleClient() {
  return createSupabaseClient<Database>(dbEnv.url(), dbEnv.serviceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
