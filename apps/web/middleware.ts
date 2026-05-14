import { NextResponse, type NextRequest } from "next/server";
import { refreshSession } from "@/lib/supabase/middleware";

const PUBLIC_PATHS = new Set(["/sign-in"]);

export async function middleware(request: NextRequest) {
  const { response, userId } = await refreshSession(request);
  const { pathname, search } = request.nextUrl;

  const isPublic = PUBLIC_PATHS.has(pathname);

  if (!userId && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = "";
    if (pathname !== "/") {
      url.searchParams.set("next", `${pathname}${search}`);
    }
    return redirectPreservingCookies(url, response);
  }

  if (userId && isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return redirectPreservingCookies(url, response);
  }

  return response;
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
