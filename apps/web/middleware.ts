import { NextResponse, type NextRequest } from "next/server";
import { refreshSession } from "@/lib/supabase/middleware";
import { isAllowedEmail } from "@/lib/auth/allowlist";

const PUBLIC_PATHS = new Set(["/sign-in", "/access-denied"]);
const AUTH_PATH_PREFIX = "/auth/";
// Cron handlers authenticate themselves with CRON_SECRET — running them
// through the session refresh + allowlist gate would block Vercel Cron and
// any external scheduler from ever calling them.
const CRON_PATH_PREFIX = "/api/cron/";

export async function middleware(request: NextRequest) {
  const state = await refreshSession(request);
  const { pathname, search } = request.nextUrl;

  const isPublic = PUBLIC_PATHS.has(pathname);
  // Routes under /auth/ (OAuth callback, sign-out) need to run regardless of
  // session state — gating them would break the very flow that establishes or
  // tears down the session.
  const isAuthRoute = pathname.startsWith(AUTH_PATH_PREFIX);
  const isCronRoute = pathname.startsWith(CRON_PATH_PREFIX);

  if (isAuthRoute || isCronRoute) {
    return state.getResponse();
  }

  if (!state.userId) {
    if (isPublic) return state.getResponse();
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = "";
    if (pathname !== "/") {
      url.searchParams.set("next", `${pathname}${search}`);
    }
    return redirectPreservingCookies(url, state.getResponse());
  }

  // Authenticated but not on the allow-list: tear the session down and bounce
  // to the 403 screen. This is the second layer of defence after the OAuth
  // callback — if an existing session was created before an email was removed
  // from ALLOWED_EMAILS, we don't want it to keep working.
  if (!isAllowedEmail(state.userEmail)) {
    await state.signOut();
    const url = request.nextUrl.clone();
    url.pathname = "/access-denied";
    url.search = "";
    return redirectPreservingCookies(url, state.getResponse());
  }

  if (isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return redirectPreservingCookies(url, state.getResponse());
  }

  return state.getResponse();
}

// Carry any Set-Cookie writes (refreshed or cleared auth tokens) from the
// session-refresh response onto the redirect — otherwise the browser keeps
// stale cookies and we loop.
function redirectPreservingCookies(url: URL, source: NextResponse): NextResponse {
  const redirect = NextResponse.redirect(url);
  for (const cookie of source.cookies.getAll()) {
    redirect.cookies.set(cookie);
  }
  return redirect;
}

export const config = {
  matcher: [
    /*
     * Run on every request except Next internals and static assets.
     * Image, font, and favicon requests are excluded so we don't pay the
     * Supabase getUser() cost on each tile.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|woff2?)$).*)",
  ],
};
