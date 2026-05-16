import { createServiceRoleClient } from "@reverb/db/server";
import { DailySessionModule } from "@/components/home/daily-session";
import { CoupleStreaksModule } from "@/components/home/couple-streaks";
import { HeatmapModule } from "@/components/home/heatmap";
import { WeeklyXpModule } from "@/components/home/weekly-xp";
import { LessonsInProgressModule } from "@/components/home/lessons-in-progress";
import { getUser } from "@/lib/auth/get-user";
import { getProfile } from "@/lib/auth/get-profile";
import { loadHomeMetrics, type HomeMetrics } from "@/lib/home/metrics";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const metrics = await loadMetrics();

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight md:text-2xl">Welcome back</h1>
        <p className="mt-1 text-sm text-foreground-muted">
          Pick up where you left off, or upload a new lesson to expand your deck.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <DailySessionModule />
        <LessonsInProgressModule />
        <CoupleStreaksModule metrics={metrics} />
        <WeeklyXpModule metrics={metrics} />
        <HeatmapModule metrics={metrics} />
      </div>
    </div>
  );
}

// Single fetch for everything streak/heatmap/XP-related. The metrics need
// the partner's rows, which sit behind a self-only RLS policy — using the
// service-role client is the standard pattern here. We constrain the read
// by `household_id` so this can never leak data from another household.
async function loadMetrics(): Promise<HomeMetrics | null> {
  const user = await getUser();
  if (!user) return null;
  const profile = await getProfile(user.id);
  if (!profile) return null;
  try {
    const supabase = createServiceRoleClient();
    return await loadHomeMetrics(supabase, {
      householdId: profile.householdId,
      currentUserId: user.id,
    });
  } catch {
    // The home page should never crash on a degraded telemetry read. The
    // modules accept a null `metrics` prop and fall back to dashes.
    return null;
  }
}
