type SupabaseClientEnv = {
  url: string;
  anonKey: string;
};

export function readSupabaseEnv(): SupabaseClientEnv | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}
