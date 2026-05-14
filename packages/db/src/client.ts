import { createBrowserClient } from "@supabase/ssr";
import { dbEnv } from "./env.js";
import type { Database } from "./types.js";

export function createClient() {
  return createBrowserClient<Database>(dbEnv.url(), dbEnv.anonKey());
}
