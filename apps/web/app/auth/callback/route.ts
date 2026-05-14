import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { ensureProfile } from "@/lib/auth/bootstrap";
import { isAllowedEmail } from "@/lib/auth/allowlist";

const VALID_NEXT_PREFIX = "/";

export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  const requestedNext = url.searchParams.get("next");

  if (oauthError) {
    return redirectToSignIn(request, "Sign-in was cancelled or failed. Please try again.");
  }

  if (!code) {
    return redirectToSignIn(request, "Missing OAuth code. Please try again.");
  }

  const supabase = await createServerSupabaseClient();
  if (!supabase) {
    return redirectToSignIn(request, "Supabase is not configured.");
  }

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.session?.user) {
    return redirectToSignIn(request, "Could not complete sign-in. Please try again.");
  }

  const user = data.session.user;
  if (!isAllowedEmail(user.email)) {
    // Tear down the just-issued session so the user never holds a valid token.
    await supabase.auth.signOut();
    return NextResponse.redirect(new URL("/access-denied", request.url));
  }

  try {
    const bootstrap = await ensureProfile(user);
    return NextResponse.redirect(pickDestination(request, requestedNext, bootstrap.onboarded));
  } catch (err) {
    console.error("ensureProfile failed", err);
    // Drop the session: leaving it active would let middleware bounce the
    // (allow-listed but profile-less) user out of /sign-in and into / where
    // the layout would either show an error or loop them through onboarding
    // again. Forcing a fresh sign-in keeps the retry surface visible.
    await supabase.auth.signOut();
    return redirectToSignIn(request, "Could not finish creating your profile. Please try again.");
  }
}

function redirectToSignIn(request: NextRequest, message: string): NextResponse {
  const target = new URL("/sign-in", request.url);
  target.searchParams.set("error", encodeURIComponent(message));
  return NextResponse.redirect(target);
}

function pickDestination(
  request: NextRequest,
  requestedNext: string | null,
  onboarded: boolean,
): URL {
  if (!onboarded) {
    return new URL("/onboarding", request.url);
  }

  if (
    requestedNext &&
    requestedNext.startsWith(VALID_NEXT_PREFIX) &&
    !requestedNext.startsWith("//")
  ) {
    return new URL(requestedNext, request.url);
  }

  return new URL("/", request.url);
}
