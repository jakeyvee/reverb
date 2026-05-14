import { type NextRequest, NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { Database } from "@reverb/db/types";
import { readSupabaseEnv } from "./env";

type CookieSet = { name: string; value: string; options: CookieOptions };

export type SessionState = {
  response: NextResponse;
  userId: string | null;
};

export async function refreshSession(request: NextRequest): Promise<SessionState> {
  let response = NextResponse.next({ request });
  const env = readSupabaseEnv();
  if (!env) return { response, userId: null };

  const supabase = createServerClient<Database>(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: CookieSet[]) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        // Rebuild the response so Server Components see the refreshed cookies
        // on this same request via the x-middleware-override-headers signal.
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  return { response, userId: user?.id ?? null };
}
