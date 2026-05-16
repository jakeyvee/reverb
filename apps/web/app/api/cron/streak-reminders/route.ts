import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@reverb/db/server";
import { defaultRecipientResolver, dispatchStreakReminders } from "@/lib/streak/reminders";

// VOL-135: hourly cron route that fans out streak-reminder emails.
//
// Wiring:
//   * Scheduled by Vercel Cron (see `apps/web/vercel.json`) at the top of
//     every hour. The `Authorization: Bearer <CRON_SECRET>` header Vercel
//     attaches keeps the endpoint from being public; we fall back to a
//     local-only path when the secret is unset (dev convenience).
//   * The dispatcher itself does all the work; this handler just owns auth,
//     instantiates the service-role client + email resolver, and returns a
//     JSON summary for observability.
//
// Why GET: Vercel Cron only fires GET requests. The handler is idempotent
// — calling it twice in the same minute produces zero duplicate emails
// because the streak_reminder_log primary key collapses retries.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = checkCronAuthorization(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.reason }, { status: 401 });
  }

  const supabase = createServiceRoleClient();
  const resolveEmail = defaultRecipientResolver(supabase);

  try {
    const summary = await dispatchStreakReminders(supabase, resolveEmail);
    return NextResponse.json({
      ok: true,
      summary: {
        scanned: summary.scanned,
        eligible: summary.eligible,
        sent: summary.sent,
        failed: summary.failed,
      },
      // Errors come back in the body so the Vercel cron history surface
      // shows the failure context without a separate log dive. The handler
      // still returns 200 — partial failures aren't a reason to schedule a
      // retry that would re-send the successful ones.
      errors: summary.errors,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

// Authorize via:
//   * `Authorization: Bearer <CRON_SECRET>` — what Vercel Cron sends.
//   * `?secret=<CRON_SECRET>` — fallback for manual invocation from a
//     terminal or a one-off external trigger.
// When CRON_SECRET is unset (local dev), the endpoint allows any caller —
// production deploys MUST set the env var, but blocking dev makes it hard
// to test the flow end-to-end.
function checkCronAuthorization(
  request: NextRequest,
): { ok: true } | { ok: false; reason: string } {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return { ok: true };

  const authHeader = request.headers.get("authorization") ?? "";
  const headerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const queryToken = request.nextUrl.searchParams.get("secret")?.trim() ?? "";
  if (headerToken === secret || queryToken === secret) return { ok: true };
  return { ok: false, reason: "Unauthorized" };
}
