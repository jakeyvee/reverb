import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient();
  if (supabase) {
    await supabase.auth.signOut();
  }
  const target = request.nextUrl.clone();
  target.pathname = "/sign-in";
  target.search = "";
  return NextResponse.redirect(target, { status: 303 });
}
